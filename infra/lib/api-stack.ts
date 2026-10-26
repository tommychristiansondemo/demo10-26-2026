import * as path from 'path';
import {
  CfnOutput, Duration, RemovalPolicy, Stack, StackProps,
  aws_apigateway as apigw, aws_cognito as cognito, aws_lambda as lambda, aws_logs as logs, aws_wafv2 as waf,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { PREFIX } from './config';
import { FoundationStack } from './foundation-stack';
import { AgentCoreStack } from './agentcore-stack';

interface Props extends StackProps { foundation: FoundationStack; agentcore: AgentCoreStack }

/** Thin backend: REST API (Cognito authorizer, throttling, STREAM) -> Lambda proxy -> AgentCore Runtime. */
export class ApiStack extends Stack {
  readonly api: apigw.RestApi;
  readonly proxyFn: lambda.Function;

  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);
    const f = props.foundation;

    this.proxyFn = new lambda.Function(this, 'ChatProxyFn', {
      functionName: `${PREFIX}-chat-proxy`, runtime: lambda.Runtime.NODEJS_22_X, architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler', code: lambda.Code.fromAsset(path.join(__dirname, '..', '..', 'lambdas', 'chat_proxy')),
      timeout: Duration.minutes(5), memorySize: 256, tracing: lambda.Tracing.ACTIVE,
      environment: { AGENT_RUNTIME_ARN: props.agentcore.agentRuntime.attrAgentRuntimeArn, UPSTREAM_TIMEOUT_MS: '240000' },
      logGroup: new logs.LogGroup(this, 'ChatProxyLogs', { logGroupName: `/aws/lambda/${PREFIX}-chat-proxy`,
        retention: logs.RetentionDays.ONE_MONTH, encryptionKey: f.key, removalPolicy: RemovalPolicy.DESTROY }),
    });
    // No AgentCore IAM permissions on purpose: the Runtime authorizes the forwarded user JWT.

    const accessLogs = new logs.LogGroup(this, 'ApiAccessLogs', { logGroupName: `/aws/apigateway/${PREFIX}-api`,
      retention: logs.RetentionDays.ONE_MONTH, encryptionKey: f.key, removalPolicy: RemovalPolicy.DESTROY });
    this.api = new apigw.RestApi(this, 'Api', {
      restApiName: `${PREFIX}-api`, endpointTypes: [apigw.EndpointType.REGIONAL], cloudWatchRole: true,
      cloudWatchRoleRemovalPolicy: RemovalPolicy.DESTROY,
      deployOptions: {
        stageName: 'prod', tracingEnabled: true, metricsEnabled: true,
        throttlingRateLimit: 10, throttlingBurstLimit: 20,
        methodOptions: { '/api/chat/POST': { throttlingRateLimit: 5, throttlingBurstLimit: 10 } },
        accessLogDestination: new apigw.LogGroupLogDestination(accessLogs),
        // metadata only -- no bodies, no tokens
        accessLogFormat: apigw.AccessLogFormat.custom(JSON.stringify({
          requestId: '$context.requestId', ip: '$context.identity.sourceIp', method: '$context.httpMethod',
          path: '$context.resourcePath', status: '$context.status', latencyMs: '$context.responseLatency',
          user: '$context.authorizer.claims.sub', waf: '$context.wafResponseCode', xray: '$context.xrayTraceId' })),
      },
    });
    const authorizer = new apigw.CognitoUserPoolsAuthorizer(this, 'CognitoAuth', {
      cognitoUserPools: [cognito.UserPool.fromUserPoolArn(this, 'Pool', f.userPool.userPoolArn)],
      authorizerName: `${PREFIX}-cognito`, resultsCacheTtl: Duration.minutes(5),
    });
    const integration = new apigw.LambdaIntegration(this.proxyFn, {
      proxy: true, responseTransferMode: apigw.ResponseTransferMode.STREAM, timeout: Duration.minutes(5),
    });
    const apiRes = this.api.root.addResource('api');
    apiRes.addResource('health').addMethod('GET', integration);
    apiRes.addResource('chat').addMethod('POST', integration, {
      authorizer, authorizationType: apigw.AuthorizationType.COGNITO,
      // Any-of: hosted-UI tokens carry 'openid'; SRP/admin-auth tokens (smoke tests) carry the admin scope.
      // Setting scopes makes the authorizer validate ACCESS tokens rather than ID tokens.
      authorizationScopes: ['openid', 'aws.cognito.signin.user.admin'],
    });

    // Regional WAF: only requests carrying CloudFront's origin-verify header get through, so the
    // execute-api URL cannot be used to bypass CloudFront's WAF.
    const acl = new waf.CfnWebACL(this, 'ApiWaf', {
      name: `${PREFIX}-api-regional`, scope: 'REGIONAL', defaultAction: { block: {} },
      visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: `${PREFIX}-api-regional`, sampledRequestsEnabled: true },
      rules: [{
        name: 'AllowFromCloudFront', priority: 0, action: { allow: {} },
        visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: 'AllowFromCloudFront', sampledRequestsEnabled: true },
        statement: { byteMatchStatement: {
          fieldToMatch: { singleHeader: { Name: 'x-origin-verify' } }, positionalConstraint: 'EXACTLY',
          searchString: f.originSecret.secretValue.unsafeUnwrap(), // CFN dynamic reference, resolved server-side
          textTransformations: [{ priority: 0, type: 'NONE' }] } },
      }],
    });
    new waf.CfnWebACLAssociation(this, 'ApiWafAssoc', { webAclArn: acl.attrArn, resourceArn: this.api.deploymentStage.stageArn });

    new CfnOutput(this, 'ApiUrl', { value: this.api.url });
  }
}
