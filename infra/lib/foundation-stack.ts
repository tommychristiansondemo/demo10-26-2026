import * as path from 'path';
import {
  Duration, RemovalPolicy, Stack, StackProps, CfnOutput,
  aws_kms as kms, aws_dynamodb as ddb, aws_s3 as s3, aws_cognito as cognito, aws_iam as iam,
  aws_secretsmanager as sm, aws_sns as sns, aws_bedrock as bedrock, aws_budgets as budgets,
  aws_lambda as lambda, aws_logs as logs,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { BUDGET_USD, PREFIX, SITE_HOST } from './config';

/** Shared data, identity, safety and alerting resources. Everything is KMS-encrypted with one CMK. */
export class FoundationStack extends Stack {
  readonly key: kms.Key;
  readonly studies: ddb.Table;
  readonly sites: ddb.Table;
  readonly docsBucket: s3.Bucket;
  readonly userPool: cognito.UserPool;
  readonly spaClient: cognito.UserPoolClient;
  readonly m2mClient: cognito.UserPoolClient;
  readonly cognitoDomain: string;
  readonly discoveryUrl: string;
  readonly guardrail: bedrock.CfnGuardrail;
  readonly alarmTopic: sns.Topic;
  readonly originSecret: sm.Secret;

  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    // ---------- KMS: one customer-managed key for data at rest ----------
    this.key = new kms.Key(this, 'DataKey', {
      alias: `alias/${PREFIX}-data`, enableKeyRotation: true, removalPolicy: RemovalPolicy.DESTROY,
      pendingWindow: Duration.days(7), description: 'TrialScout demo data key',
    });
    this.key.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowCloudWatchLogs', principals: [new iam.ServicePrincipal(`logs.${this.region}.amazonaws.com`)],
      actions: ['kms:Encrypt*', 'kms:Decrypt*', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:Describe*'], resources: ['*'],
      conditions: { ArnLike: { 'kms:EncryptionContext:aws:logs:arn': `arn:aws:logs:${this.region}:${this.account}:*` } },
    }));
    this.key.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowAlarmAndBudgetPublishers',
      principals: [new iam.ServicePrincipal('cloudwatch.amazonaws.com'), new iam.ServicePrincipal('budgets.amazonaws.com')],
      actions: ['kms:Decrypt', 'kms:GenerateDataKey*'], resources: ['*'],
    }));

    // ---------- Synthetic data stores ----------
    const table = (name: string, pk: string) => new ddb.Table(this, name, {
      tableName: `${PREFIX}-${name.toLowerCase()}`, partitionKey: { name: pk, type: ddb.AttributeType.STRING },
      billingMode: ddb.BillingMode.PAY_PER_REQUEST, encryption: ddb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: this.key, pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.DESTROY,
    });
    this.studies = table('Studies', 'study_id');
    this.sites = table('Sites', 'site_id');

    this.docsBucket = new s3.Bucket(this, 'DocsBucket', {
      bucketName: `${PREFIX}-docs-${this.account}`, encryption: s3.BucketEncryption.KMS, encryptionKey: this.key,
      bucketKeyEnabled: true, blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, enforceSSL: true,
      minimumTLSVersion: 1.2, removalPolicy: RemovalPolicy.DESTROY, autoDeleteObjects: true,
    });

    // ---------- Cognito: users (SPA, PKCE) + machine client for Gateway -> MCP runtimes ----------
    const signupTrigger = new lambda.Function(this, 'SignupTriggerFn', {
      functionName: `${PREFIX}-signup-trigger`, runtime: lambda.Runtime.PYTHON_3_13, architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler', code: lambda.Code.fromAsset(path.join(__dirname, '..', '..', 'lambdas', 'signup_trigger')),
      timeout: Duration.seconds(10), memorySize: 128, description: 'Cognito PreSignUp/PostConfirmation: role check, auto-confirm, group',
      logGroup: new logs.LogGroup(this, 'SignupTriggerLogs', { logGroupName: `/aws/lambda/${PREFIX}-signup-trigger`,
        retention: logs.RetentionDays.ONE_MONTH, encryptionKey: this.key, removalPolicy: RemovalPolicy.DESTROY }),
    });
    // Wildcard pool ARN: naming the pool here would create a pool -> trigger -> policy -> pool cycle.
    signupTrigger.addToRolePolicy(new iam.PolicyStatement({ actions: ['cognito-idp:AdminAddUserToGroup'],
      resources: [`arn:aws:cognito-idp:${this.region}:${this.account}:userpool/*`] }));
    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `${PREFIX}-users`, signInAliases: { username: true, email: true },
      // Classroom self-service: students create their own accounts and pick a role. No e-mail, no MFA,
      // 6-character minimum (Cognito's floor) with no complexity rules -- demo convenience, not production policy.
      selfSignUpEnabled: true, autoVerify: {}, mfa: cognito.Mfa.OFF,
      passwordPolicy: { minLength: 6, requireDigits: false, requireLowercase: false, requireUppercase: false, requireSymbols: false },
      customAttributes: { role: new cognito.StringAttribute({ minLen: 6, maxLen: 7, mutable: false }) }, // analyst | reader
      lambdaTriggers: { preSignUp: signupTrigger, postConfirmation: signupTrigger },
      accountRecovery: cognito.AccountRecovery.NONE, featurePlan: cognito.FeaturePlan.ESSENTIALS,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    for (const g of ['analyst', 'reader']) {
      new cognito.CfnUserPoolGroup(this, `Group-${g}`, { userPoolId: this.userPool.userPoolId, groupName: g,
        description: g === 'analyst' ? 'All six tools' : 'Read-only tools (search, site KPIs, documents)' });
    }
    const domainPrefix = `${PREFIX}-${this.account}`;
    this.userPool.addDomain('Domain', {
      cognitoDomain: { domainPrefix }, managedLoginVersion: cognito.ManagedLoginVersion.CLASSIC_HOSTED_UI,
    });
    this.cognitoDomain = `${domainPrefix}.auth.${this.region}.amazoncognito.com`;
    this.discoveryUrl = `https://cognito-idp.${this.region}.amazonaws.com/${this.userPool.userPoolId}/.well-known/openid-configuration`;

    const invokeScope = new cognito.ResourceServerScope({ scopeName: 'invoke', scopeDescription: 'Invoke TrialScout MCP runtimes' });
    const rs = this.userPool.addResourceServer('McpResourceServer', { identifier: 'trialscout-mcp', scopes: [invokeScope] });

    this.spaClient = this.userPool.addClient('SpaClient', {
      userPoolClientName: `${PREFIX}-spa`, generateSecret: false,
      authFlows: { userSrp: true, userPassword: true, adminUserPassword: true }, // userPassword: in-page sign-in form; adminUserPassword: smoke tests
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: [`https://${SITE_HOST}/`, 'http://localhost:5173/'],
        logoutUrls: [`https://${SITE_HOST}/`, 'http://localhost:5173/'],
      },
      accessTokenValidity: Duration.minutes(60), idTokenValidity: Duration.minutes(60),
      refreshTokenValidity: Duration.hours(8), preventUserExistenceErrors: true, enableTokenRevocation: true,
    });
    this.m2mClient = this.userPool.addClient('GatewayM2MClient', {
      userPoolClientName: `${PREFIX}-gateway-m2m`, generateSecret: true,
      oAuth: { flows: { clientCredentials: true }, scopes: [cognito.OAuthScope.resourceServer(rs, invokeScope)] },
      accessTokenValidity: Duration.minutes(60),
    });

    // Shared secret CloudFront sends to the API origin; a regional WAF on API Gateway requires it.
    this.originSecret = new sm.Secret(this, 'OriginVerifySecret', {
      secretName: `${PREFIX}/origin-verify`, encryptionKey: this.key, removalPolicy: RemovalPolicy.DESTROY,
      generateSecretString: { passwordLength: 40, excludePunctuation: true, includeSpace: false },
    });

    // ---------- Bedrock Guardrail ----------
    this.guardrail = new bedrock.CfnGuardrail(this, 'Guardrail', {
      name: `${PREFIX}-guardrail`, kmsKeyArn: this.key.keyArn,
      description: 'Prompt-attack, denied topics, PII masking for the TrialScout agent',
      blockedInputMessaging: 'TrialScout blocked this request because it looks like an attempt to override its instructions or asks for something outside its scope (for example individual medical advice or unblinding). Please rephrase your question about studies, sites or policies.',
      blockedOutputsMessaging: 'TrialScout withheld this response because it may have contained restricted content.',
      contentPolicyConfig: {
        filtersConfig: [
          // PROMPT_ATTACK is input-only: outputStrength must be NONE or creation fails.
          // MEDIUM: HIGH flagged benign follow-ups such as "Reply with only the study id" (measured false positive).
          { type: 'PROMPT_ATTACK', inputStrength: 'MEDIUM', outputStrength: 'NONE' },
          { type: 'HATE', inputStrength: 'MEDIUM', outputStrength: 'MEDIUM' },
          { type: 'INSULTS', inputStrength: 'MEDIUM', outputStrength: 'MEDIUM' },
          { type: 'SEXUAL', inputStrength: 'MEDIUM', outputStrength: 'MEDIUM' },
          { type: 'VIOLENCE', inputStrength: 'MEDIUM', outputStrength: 'MEDIUM' },
          { type: 'MISCONDUCT', inputStrength: 'MEDIUM', outputStrength: 'MEDIUM' },
        ],
      },
      topicPolicyConfig: {
        topicsConfig: [
          { name: 'IndividualMedicalAdvice', type: 'DENY', inputEnabled: true, outputEnabled: false,
            definition: 'Requests for diagnosis, treatment, medication or dosing recommendations for a specific person or patient.',
            examples: ['What dose of TSX-105 should my mother take?', 'Should I stop my medication to join this trial?'] },
          { name: 'TreatmentUnblinding', type: 'DENY', inputEnabled: true, outputEnabled: false,
            definition: 'Requests to reveal, infer or guess which participants received active drug versus placebo in a blinded study.',
            examples: ['Which participants in TS-004 are on placebo?', 'Unblind the treatment arms for site S-012.'] },
        ],
      },
      sensitiveInformationPolicyConfig: {
        piiEntitiesConfig: [
          { type: 'EMAIL', action: 'ANONYMIZE' },
          { type: 'PHONE', action: 'ANONYMIZE' },
          { type: 'US_SOCIAL_SECURITY_NUMBER', action: 'BLOCK' },
          { type: 'NAME', action: 'ANONYMIZE', inputEnabled: true, outputEnabled: false },
        ],
        regexesConfig: [{ name: 'MedicalRecordNumber', description: 'Synthetic MRN format', pattern: '\\bMRN[-: ]?\\d{6,10}\\b', action: 'ANONYMIZE' }],
      },
    });
    // Published (immutable) versions live in the AgentCore stack, next to their consumer, so publishing a
    // new version never hits CloudFormation's "export in use" lock.

    // ---------- Alerting + cost control ----------
    this.alarmTopic = new sns.Topic(this, 'AlarmTopic', { topicName: `${PREFIX}-alarms`, masterKey: this.key, enforceSSL: true });
    this.alarmTopic.addToResourcePolicy(new iam.PolicyStatement({
      principals: [new iam.ServicePrincipal('budgets.amazonaws.com')], actions: ['sns:Publish'],
      resources: [this.alarmTopic.topicArn], conditions: { StringEquals: { 'aws:SourceAccount': this.account } },
    }));
    const budget = new budgets.CfnBudget(this, 'Budget', {
      budget: { budgetName: `${PREFIX}-monthly`, budgetType: 'COST', timeUnit: 'MONTHLY',
        budgetLimit: { amount: BUDGET_USD, unit: 'USD' } },
      notificationsWithSubscribers: [
        { notification: { notificationType: 'ACTUAL', comparisonOperator: 'GREATER_THAN', threshold: 80, thresholdType: 'PERCENTAGE' },
          subscribers: [{ subscriptionType: 'SNS', address: this.alarmTopic.topicArn }] },
        { notification: { notificationType: 'FORECASTED', comparisonOperator: 'GREATER_THAN', threshold: 100, thresholdType: 'PERCENTAGE' },
          subscribers: [{ subscriptionType: 'SNS', address: this.alarmTopic.topicArn }] },
      ],
    });
    budget.node.addDependency(this.alarmTopic);

    new CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId });
    new CfnOutput(this, 'SpaClientId', { value: this.spaClient.userPoolClientId });
    new CfnOutput(this, 'CognitoDomain', { value: this.cognitoDomain });
    new CfnOutput(this, 'DocsBucketName', { value: this.docsBucket.bucketName });
    new CfnOutput(this, 'StudiesTable', { value: this.studies.tableName });
    new CfnOutput(this, 'SitesTable', { value: this.sites.tableName });
    new CfnOutput(this, 'GuardrailId', { value: this.guardrail.attrGuardrailId });
    new CfnOutput(this, 'AlarmTopicArn', { value: this.alarmTopic.topicArn });
  }
}
