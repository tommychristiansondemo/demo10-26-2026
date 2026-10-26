import * as path from 'path';
import {
  CfnOutput, Duration, RemovalPolicy, Stack, StackProps,
  aws_certificatemanager as acm, aws_cloudfront as cf, aws_cloudfront_origins as origins, aws_cognito as cognito,
  aws_iam as iam, aws_lambda as lambda, aws_logs as logs, aws_route53 as r53, aws_route53_targets as targets,
  aws_s3 as s3, aws_s3_deployment as s3deploy, aws_wafv2 as waf, custom_resources as cr,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { DOMAIN_ZONE, INSIGHTS_HOST, MODEL_ID, PREFIX } from './config';
import { FoundationStack } from './foundation-stack';

interface Props extends StackProps { foundation: FoundationStack; hostedZoneId: string }

/**
 * TrialScout Insights: a separate, read-only "lift the hood" app for students.
 *  - static SPA in S3 behind its own CloudFront + WAF + ACM at insights.awsteach.com
 *  - all dynamic content from two Lambdas (buffered API + streaming chatbot) behind CloudFront OAC Function URLs
 *  - private, versioned knowledge bucket holding projectknowledge.md (+ a source-code snapshot)
 *  - account-level Bedrock model invocation logging (prompts + reasoning) owned by this stack
 */
export class InsightsStack extends Stack {
  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);
    const f = props.foundation;
    const name = (s: string) => `${PREFIX}-insights-${s}`;

    // ---------- Knowledge bucket: projectknowledge.md + source snapshot (written by scripts/publish_knowledge.py) ----------
    const knowledge = new s3.Bucket(this, 'KnowledgeBucket', {
      bucketName: `${name('knowledge')}-${this.account}`, versioned: true, encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, enforceSSL: true, minimumTLSVersion: 1.2,
      removalPolicy: RemovalPolicy.DESTROY, autoDeleteObjects: true,
      lifecycleRules: [{ noncurrentVersionExpiration: Duration.days(30) }],
    });

    // ---------- Bedrock model invocation logging (account + region scope) ----------
    // Captures every Bedrock model call in us-east-1 -- the TrialScout agent's prompts, tool rounds and reasoning,
    // and this chatbot's own -- into a KMS-encrypted log group. Requests >100 KB spill to S3.
    const invocationLogs = new logs.LogGroup(this, 'InvocationLogs', {
      logGroupName: `/aws/bedrock/${PREFIX}-model-invocations`, retention: logs.RetentionDays.TWO_WEEKS,
      encryptionKey: f.key, removalPolicy: RemovalPolicy.DESTROY,
    });
    const largeData = new s3.Bucket(this, 'InvocationLargeData', {
      bucketName: `${PREFIX}-invocation-logs-${this.account}`, encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, enforceSSL: true, minimumTLSVersion: 1.2,
      removalPolicy: RemovalPolicy.DESTROY, autoDeleteObjects: true, lifecycleRules: [{ expiration: Duration.days(14) }],
    });
    const bedrockSource = {
      StringEquals: { 'aws:SourceAccount': this.account },
      ArnLike: { 'aws:SourceArn': `arn:aws:bedrock:${this.region}:${this.account}:*` },
    };
    largeData.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'BedrockInvocationLogging', principals: [new iam.ServicePrincipal('bedrock.amazonaws.com')],
      actions: ['s3:PutObject'], resources: [largeData.arnForObjects('large/*')], conditions: bedrockSource,
    }));
    const loggingRole = new iam.Role(this, 'InvocationLoggingRole', {
      roleName: name('bedrock-logging'), description: 'Lets Bedrock write model invocation logs for TrialScout',
      assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com', { conditions: bedrockSource }),
    });
    loggingRole.addToPolicy(new iam.PolicyStatement({
      actions: ['logs:CreateLogStream', 'logs:PutLogEvents'], resources: [`${invocationLogs.logGroupArn}:*`],
    }));
    const loggingConfig = new cr.AwsCustomResource(this, 'InvocationLogging', {
      functionName: name('invocation-logging-cr'), installLatestAwsSdk: false,
      onCreate: putLogging(), onUpdate: putLogging(),
      onDelete: { service: 'Bedrock', action: 'DeleteModelInvocationLoggingConfiguration',
        physicalResourceId: cr.PhysicalResourceId.of(`${PREFIX}-invocation-logging`) },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({ actions: ['bedrock:PutModelInvocationLoggingConfiguration',
          'bedrock:DeleteModelInvocationLoggingConfiguration'], resources: ['*'] }),
        new iam.PolicyStatement({ actions: ['iam:PassRole'], resources: [loggingRole.roleArn] }),
      ]),
      logGroup: new logs.LogGroup(this, 'InvocationLoggingCrLogs', { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: RemovalPolicy.DESTROY }),
    });
    function putLogging(): cr.AwsSdkCall {
      return {
        service: 'Bedrock', action: 'PutModelInvocationLoggingConfiguration',
        physicalResourceId: cr.PhysicalResourceId.of(`${PREFIX}-invocation-logging`),
        parameters: { loggingConfig: {
          cloudWatchConfig: { logGroupName: invocationLogs.logGroupName, roleArn: loggingRole.roleArn,
            largeDataDeliveryS3Config: { bucketName: largeData.bucketName, keyPrefix: 'large' } },
          textDataDeliveryEnabled: true, imageDataDeliveryEnabled: false,
          embeddingDataDeliveryEnabled: false, videoDataDeliveryEnabled: false,
        } },
      };
    }
    loggingConfig.node.addDependency(loggingRole, largeData.policy!, invocationLogs);

    // ---------- Cognito: a separate app client on the same user pool (same self-registered student accounts) ----------
    const client = new cognito.UserPoolClient(this, 'InsightsClient', {
      userPool: f.userPool, userPoolClientName: name('spa'), generateSecret: false,
      authFlows: { userSrp: true, userPassword: true, adminUserPassword: true }, // userPassword: in-page sign-in; adminUserPassword: smoke tests
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: [`https://${INSIGHTS_HOST}/`], logoutUrls: [`https://${INSIGHTS_HOST}/`],
      },
      accessTokenValidity: Duration.minutes(60), idTokenValidity: Duration.minutes(60),
      refreshTokenValidity: Duration.hours(8), preventUserExistenceErrors: true, enableTokenRevocation: true,
    });

    // ---------- Lambdas (read-only) ----------
    const allowedLogGroups = [
      `/aws/bedrock-agentcore/runtimes/${PREFIX}*`, `/aws/vendedlogs/bedrock-agentcore/${PREFIX}*`,
      `/aws/lambda/${PREFIX}-*`, `/aws/apigateway/${PREFIX}-api`, invocationLogs.logGroupName,
    ].map((g) => `arn:aws:logs:${this.region}:${this.account}:log-group:${g}:*`);
    const readOnly = [
      new iam.PolicyStatement({ sid: 'Knowledge', actions: ['s3:GetObject', 's3:ListBucket'],
        resources: [knowledge.bucketArn, knowledge.arnForObjects('*')] }),
      new iam.PolicyStatement({ sid: 'ReadAllowListedLogs',
        actions: ['logs:FilterLogEvents', 'logs:GetLogEvents', 'logs:DescribeLogStreams'], resources: allowedLogGroups }),
      new iam.PolicyStatement({ sid: 'ResolveLogGroups', actions: ['logs:DescribeLogGroups'], resources: ['*'] }),
      new iam.PolicyStatement({ sid: 'Inventory',
        actions: ['cloudformation:DescribeStacks', 'cloudformation:ListStackResources'],
        resources: [`arn:aws:cloudformation:${this.region}:${this.account}:stack/TrialScout-*/*`] }),
      new iam.PolicyStatement({ sid: 'TaggedResources', actions: ['tag:GetResources'], resources: ['*'] }),
      new iam.PolicyStatement({ sid: 'Metrics', actions: ['cloudwatch:GetMetricData'], resources: ['*'] }),
      new iam.PolicyStatement({ sid: 'LoggingStatus', actions: ['bedrock:GetModelInvocationLoggingConfiguration'], resources: ['*'] }),
      // Belt and braces: even if a broader policy were attached later, these functions can never read secrets.
      new iam.PolicyStatement({ sid: 'NeverReadSecrets', effect: iam.Effect.DENY,
        actions: ['secretsmanager:GetSecretValue', 'ssm:GetParameter*', 'cognito-idp:DescribeUserPoolClient'], resources: ['*'] }),
    ];
    const env = {
      KNOWLEDGE_BUCKET: knowledge.bucketName, USER_POOL_ID: f.userPool.userPoolId, CLIENT_ID: client.userPoolClientId,
      MODEL_ID, INVOCATION_LOG_GROUP: invocationLogs.logGroupName, PREFIX,
    };
    const code = lambda.Code.fromAsset(path.join(__dirname, '..', '..', 'lambdas', 'insights'));
    const fn = (id: string, handler: string, timeout: Duration, memorySize: number) => {
      const fnName = name(id);
      const func = new lambda.Function(this, `${id}Fn`, {
        functionName: fnName, runtime: lambda.Runtime.NODEJS_22_X, architecture: lambda.Architecture.ARM_64,
        handler, code, timeout, memorySize, environment: env, tracing: lambda.Tracing.ACTIVE,
        reservedConcurrentExecutions: 10, description: `TrialScout Insights ${id} (read-only)`,
        logGroup: new logs.LogGroup(this, `${id}Logs`, { logGroupName: `/aws/lambda/${fnName}`,
          retention: logs.RetentionDays.ONE_MONTH, encryptionKey: f.key, removalPolicy: RemovalPolicy.DESTROY }),
      });
      readOnly.forEach((s) => func.addToRolePolicy(s));
      return func;
    };
    const apiFn = fn('api', 'api.handler', Duration.seconds(30), 512);
    const chatFn = fn('chat', 'chat.handler', Duration.minutes(5), 1024);
    chatFn.addToRolePolicy(new iam.PolicyStatement({ sid: 'InvokeClaude',
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: [`arn:aws:bedrock:${this.region}:${this.account}:inference-profile/${MODEL_ID}`,
        'arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-6*'] }));
    const apiUrl = apiFn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM });
    const chatUrl = chatFn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM, invokeMode: lambda.InvokeMode.RESPONSE_STREAM });

    // ---------- Edge: ACM, WAF, CloudFront, DNS ----------
    const zone = r53.HostedZone.fromHostedZoneAttributes(this, 'Zone', { hostedZoneId: props.hostedZoneId, zoneName: DOMAIN_ZONE });
    const cert = new acm.Certificate(this, 'Cert', {
      domainName: INSIGHTS_HOST, validation: acm.CertificateValidation.fromDns(zone), certificateName: name('cert'),
    });
    const managed = (ruleName: string, priority: number, countOnly: string[] = []) => ({
      name: ruleName, priority, overrideAction: { none: {} },
      statement: { managedRuleGroupStatement: { vendorName: 'AWS', name: ruleName,
        ruleActionOverrides: countOnly.map((n) => ({ name: n, actionToUse: { count: {} } })) } },
      visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: `insights-${ruleName}`, sampledRequestsEnabled: true },
    });
    const acl = new waf.CfnWebACL(this, 'WebAcl', {
      name: name('cloudfront'), scope: 'CLOUDFRONT', defaultAction: { allow: {} },
      visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: name('cloudfront'), sampledRequestsEnabled: true },
      rules: [
        { name: 'ApiRateLimitPerIp', priority: 0, action: { block: {} },
          statement: { rateBasedStatement: { limit: 300, evaluationWindowSec: 300, aggregateKeyType: 'IP',
            scopeDownStatement: { byteMatchStatement: { fieldToMatch: { uriPath: {} }, positionalConstraint: 'STARTS_WITH',
              searchString: '/api/', textTransformations: [{ priority: 0, type: 'NONE' }] } } } },
          visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: 'InsightsApiRateLimitPerIp', sampledRequestsEnabled: true } },
        managed('AWSManagedRulesAmazonIpReputationList', 1),
        // Chat posts carry the conversation so far, which can exceed the rule set's 8 KB body limit.
        managed('AWSManagedRulesCommonRuleSet', 2, ['SizeRestrictions_BODY']),
        managed('AWSManagedRulesKnownBadInputsRuleSet', 3),
      ],
    });

    const site = new s3.Bucket(this, 'SiteBucket', {
      bucketName: `${name('site')}-${this.account}`, encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, enforceSSL: true, minimumTLSVersion: 1.2,
      removalPolicy: RemovalPolicy.DESTROY, autoDeleteObjects: true,
    });
    const headers = new cf.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      responseHeadersPolicyName: name('security-headers'),
      securityHeadersBehavior: {
        strictTransportSecurity: { accessControlMaxAge: Duration.days(365), includeSubdomains: false, override: true },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cf.HeadersFrameOption.DENY, override: true },
        referrerPolicy: { referrerPolicy: cf.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN, override: true },
        contentSecurityPolicy: { override: true, contentSecurityPolicy:
          `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; ` +
          `connect-src 'self' https://${f.cognitoDomain} https://cognito-idp.${this.region}.amazonaws.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self' https://${f.cognitoDomain}` },
      },
    });
    // OAC signs the origin request with SigV4 (replacing Authorization), so the user's JWT travels in X-Insights-Token.
    // (x-amz-content-sha256 is sent by the browser for POST bodies and consumed by OAC; CloudFront forbids listing it here.)
    const originRequest = new cf.OriginRequestPolicy(this, 'ApiOriginRequest', {
      originRequestPolicyName: name('api'),
      headerBehavior: cf.OriginRequestHeaderBehavior.allowList('x-insights-token', 'content-type'),
      queryStringBehavior: cf.OriginRequestQueryStringBehavior.all(), cookieBehavior: cf.OriginRequestCookieBehavior.none(),
    });
    const apiBehavior = (url: lambda.FunctionUrl, readTimeout: number): cf.BehaviorOptions => ({
      origin: origins.FunctionUrlOrigin.withOriginAccessControl(url, { readTimeout: Duration.seconds(readTimeout) }),
      viewerProtocolPolicy: cf.ViewerProtocolPolicy.HTTPS_ONLY, allowedMethods: cf.AllowedMethods.ALLOW_ALL,
      cachePolicy: cf.CachePolicy.CACHING_DISABLED, originRequestPolicy: originRequest, responseHeadersPolicy: headers,
    });
    const distribution = new cf.Distribution(this, 'Distribution', {
      comment: 'TrialScout Insights', domainNames: [INSIGHTS_HOST], certificate: cert, webAclId: acl.attrArn,
      minimumProtocolVersion: cf.SecurityPolicyProtocol.TLS_V1_2_2021, httpVersion: cf.HttpVersion.HTTP2_AND_3,
      defaultRootObject: 'index.html', priceClass: cf.PriceClass.PRICE_CLASS_100,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(site),
        viewerProtocolPolicy: cf.ViewerProtocolPolicy.REDIRECT_TO_HTTPS, cachePolicy: cf.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: headers,
      },
      additionalBehaviors: { '/api/chat': apiBehavior(chatUrl, 60), '/api/*': apiBehavior(apiUrl, 30) },
    });
    for (const [rid, Rec] of [['InsightsA', r53.ARecord], ['InsightsAAAA', r53.AaaaRecord]] as const) {
      new Rec(this, rid, { zone, recordName: 'insights', target: r53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)) });
    }

    new s3deploy.BucketDeployment(this, 'DeploySite', {
      destinationBucket: site, distribution, distributionPaths: ['/*'], memoryLimit: 512,
      sources: [
        s3deploy.Source.asset(path.join(__dirname, '..', '..', 'insights-web')),
        s3deploy.Source.jsonData('config.json', {
          region: this.region, clientId: client.userPoolClientId, cognitoDomain: f.cognitoDomain,
          redirectUri: `https://${INSIGHTS_HOST}/`, mainSite: 'https://www.awsteach.com/',
        }),
      ],
    });

    new CfnOutput(this, 'InsightsUrl', { value: `https://${INSIGHTS_HOST}` });
    new CfnOutput(this, 'KnowledgeBucketName', { value: knowledge.bucketName });
    new CfnOutput(this, 'InsightsClientId', { value: client.userPoolClientId });
    new CfnOutput(this, 'InvocationLogGroup', { value: invocationLogs.logGroupName });
    new CfnOutput(this, 'InsightsDistributionId', { value: distribution.distributionId });
  }
}
