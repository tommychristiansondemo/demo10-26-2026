import * as path from 'path';
import {
  CfnOutput, Duration, RemovalPolicy, Stack, StackProps,
  aws_certificatemanager as acm, aws_cloudfront as cf, aws_cloudfront_origins as origins, aws_route53 as r53,
  aws_route53_targets as targets, aws_s3 as s3, aws_s3_deployment as s3deploy, aws_wafv2 as waf,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { DOMAIN_ZONE, PREFIX, SITE_HOST } from './config';
import { FoundationStack } from './foundation-stack';
import { ApiStack } from './api-stack';

interface Props extends StackProps { foundation: FoundationStack; apiStack: ApiStack; hostedZoneId: string }

/** CloudFront (+WAF, TLS 1.2+, security headers) in front of the S3 SPA and the /api/* REST API. */
export class WebStack extends Stack {
  readonly distribution: cf.Distribution;
  readonly webAcl: waf.CfnWebACL;

  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);
    const f = props.foundation;

    const zone = r53.HostedZone.fromHostedZoneAttributes(this, 'Zone', { hostedZoneId: props.hostedZoneId, zoneName: DOMAIN_ZONE });
    const cert = new acm.Certificate(this, 'Cert', {
      domainName: SITE_HOST, validation: acm.CertificateValidation.fromDns(zone), certificateName: `${PREFIX}-www`,
    });

    // CloudFront-scope WAF (must live in us-east-1).
    const managed = (name: string, priority: number) => ({
      name, priority, overrideAction: { none: {} },
      statement: { managedRuleGroupStatement: { vendorName: 'AWS', name } },
      visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: name, sampledRequestsEnabled: true },
    });
    this.webAcl = new waf.CfnWebACL(this, 'WebAcl', {
      name: `${PREFIX}-cloudfront`, scope: 'CLOUDFRONT', defaultAction: { allow: {} },
      visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: `${PREFIX}-cloudfront`, sampledRequestsEnabled: true },
      rules: [
        { name: 'ApiRateLimitPerIp', priority: 0, action: { block: {} },
          statement: { rateBasedStatement: { limit: 300, evaluationWindowSec: 300, aggregateKeyType: 'IP',
            scopeDownStatement: { byteMatchStatement: { fieldToMatch: { uriPath: {} }, positionalConstraint: 'STARTS_WITH',
              searchString: '/api/', textTransformations: [{ priority: 0, type: 'NONE' }] } } } },
          visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: 'ApiRateLimitPerIp', sampledRequestsEnabled: true } },
        managed('AWSManagedRulesAmazonIpReputationList', 1),
        managed('AWSManagedRulesCommonRuleSet', 2),
        managed('AWSManagedRulesKnownBadInputsRuleSet', 3),
      ],
    });

    const siteBucket = new s3.Bucket(this, 'SiteBucket', {
      bucketName: `${PREFIX}-site-${this.account}`, encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, enforceSSL: true, minimumTLSVersion: 1.2,
      removalPolicy: RemovalPolicy.DESTROY, autoDeleteObjects: true,
    });

    const headers = new cf.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      responseHeadersPolicyName: `${PREFIX}-security-headers`,
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
    // SPA deep links -> /index.html (a function, not distribution errorResponses, so API 4xx stay intact).
    const spaRewrite = new cf.Function(this, 'SpaRewrite', {
      functionName: `${PREFIX}-spa-rewrite`, runtime: cf.FunctionRuntime.JS_2_0,
      code: cf.FunctionCode.fromInline(
        'function handler(event){var r=event.request;if(!r.uri.includes(".")){r.uri="/index.html";}return r;}'),
    });

    const apiOrigin = new origins.RestApiOrigin(props.apiStack.api, {
      customHeaders: { 'x-origin-verify': f.originSecret.secretValue.unsafeUnwrap() }, // CFN dynamic reference
      readTimeout: Duration.seconds(60), keepaliveTimeout: Duration.seconds(60),
    });

    this.distribution = new cf.Distribution(this, 'Distribution', {
      comment: 'TrialScout demo', domainNames: [SITE_HOST], certificate: cert, webAclId: this.webAcl.attrArn,
      minimumProtocolVersion: cf.SecurityPolicyProtocol.TLS_V1_2_2021, httpVersion: cf.HttpVersion.HTTP2_AND_3,
      defaultRootObject: 'index.html', priceClass: cf.PriceClass.PRICE_CLASS_100,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cf.ViewerProtocolPolicy.REDIRECT_TO_HTTPS, cachePolicy: cf.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: headers, functionAssociations: [{ function: spaRewrite, eventType: cf.FunctionEventType.VIEWER_REQUEST }],
      },
      additionalBehaviors: {
        '/api/*': {
          origin: apiOrigin, viewerProtocolPolicy: cf.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cf.AllowedMethods.ALLOW_ALL, cachePolicy: cf.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cf.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER, responseHeadersPolicy: headers,
        },
      },
    });

    for (const [rid, Rec] of [['WwwA', r53.ARecord], ['WwwAAAA', r53.AaaaRecord]] as const) {
      new Rec(this, rid, { zone, recordName: 'www', target: r53.RecordTarget.fromAlias(new targets.CloudFrontTarget(this.distribution)) });
    }

    new s3deploy.BucketDeployment(this, 'DeploySite', {
      destinationBucket: siteBucket, distribution: this.distribution, distributionPaths: ['/*'], memoryLimit: 512,
      sources: [
        s3deploy.Source.asset(path.join(__dirname, '..', '..', 'web')),
        s3deploy.Source.jsonData('config.json', {
          region: this.region, userPoolId: f.userPool.userPoolId, clientId: f.spaClient.userPoolClientId,
          cognitoDomain: f.cognitoDomain, redirectUri: `https://${SITE_HOST}/`,
        }),
      ],
    });

    new CfnOutput(this, 'SiteUrl', { value: `https://${SITE_HOST}` });
    new CfnOutput(this, 'DistributionId', { value: this.distribution.distributionId });
    new CfnOutput(this, 'DistributionDomain', { value: this.distribution.distributionDomainName });
  }
}
