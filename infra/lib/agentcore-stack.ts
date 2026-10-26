import * as path from 'path';
import {
  CfnOutput, CustomResource, Duration, Fn, RemovalPolicy, Stack, StackProps,
  aws_bedrock as bedrock, aws_bedrockagentcore as agentcore, aws_iam as iam, aws_lambda as lambda, aws_logs as logs,
  aws_s3_assets as assets, custom_resources as cr,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { EMBED_MODEL_ID, MCP_SCOPE, MODEL_ID, PREFIX, ROLE_TOOLS } from './config';
import { FoundationStack } from './foundation-stack';
import { AgentCoreDelivery } from './observability-delivery';

const ROOT = path.join(__dirname, '..', '..');

interface Props extends StackProps { foundation: FoundationStack }

/**
 * AgentCore components:
 *   Runtime  x3  -- study_portfolio (MCP), policy_protocol (MCP), trialscout_agent (HTTP/SSE)
 *   Identity     -- JWT authorizers on every Runtime + the Gateway; OAuth2 credential provider (outbound)
 *   Gateway      -- one MCP endpoint aggregating both MCP runtimes; RBAC interceptor Lambda
 *   Memory       -- short-term events + long-term user-preference strategy
 *   Observability-- APPLICATION_LOGS + TRACES delivery for each resource; ADOT inside each runtime
 */
export class AgentCoreStack extends Stack {
  readonly agentRuntime: agentcore.CfnRuntime;
  readonly gateway: agentcore.CfnGateway;
  readonly interceptorFn: lambda.Function;
  readonly runtimeNames: string[];

  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);
    const f = props.foundation;
    const delivery = new AgentCoreDelivery(this, 'Delivery', f.key);

    // -------- shared helpers --------
    const runtimeRole = (name: string, runtimeName: string) => {
      const role = new iam.Role(this, `${name}Role`, {
        roleName: `${PREFIX}-${name.toLowerCase()}-runtime`,
        assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com', {
          conditions: { StringEquals: { 'aws:SourceAccount': this.account },
            ArnLike: { 'aws:SourceArn': `arn:aws:bedrock-agentcore:${this.region}:${this.account}:*` } },
        }),
        description: `AgentCore Runtime execution role for ${runtimeName}`,
      });
      role.addToPolicy(new iam.PolicyStatement({ sid: 'RuntimeLogs',
        actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents', 'logs:DescribeLogStreams', 'logs:DescribeLogGroups'],
        resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:/aws/bedrock-agentcore/runtimes/*`,
          `arn:aws:logs:${this.region}:${this.account}:log-group:aws/spans`, `arn:aws:logs:${this.region}:${this.account}:log-group:aws/spans:*`] }));
      role.addToPolicy(new iam.PolicyStatement({ sid: 'Tracing',
        actions: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords', 'xray:PutSpans', 'xray:PutSpansForIndexing',
          'xray:GetSamplingRules', 'xray:GetSamplingTargets'], resources: ['*'] }));
      role.addToPolicy(new iam.PolicyStatement({ sid: 'Metrics', actions: ['cloudwatch:PutMetricData'], resources: ['*'],
        conditions: { StringEquals: { 'cloudwatch:namespace': 'bedrock-agentcore' } } }));
      role.addToPolicy(new iam.PolicyStatement({ sid: 'WorkloadIdentity',
        actions: ['bedrock-agentcore:GetWorkloadAccessToken', 'bedrock-agentcore:GetWorkloadAccessTokenForJWT',
          'bedrock-agentcore:GetWorkloadAccessTokenForUserId'],
        resources: [`arn:aws:bedrock-agentcore:${this.region}:${this.account}:workload-identity-directory/default`,
          `arn:aws:bedrock-agentcore:${this.region}:${this.account}:workload-identity-directory/default/workload-identity/${runtimeName}-*`] }));
      return role;
    };
    const codeAsset = (svc: string, role: iam.Role) => {
      const a = new assets.Asset(this, `${svc}Code`, { path: path.join(ROOT, 'build', `${svc}.zip`) });
      a.grantRead(role);
      return a;
    };
    const jwt = (clientId: string) => ({ customJwtAuthorizer: { discoveryUrl: f.discoveryUrl, allowedClients: [clientId] } });
    const runtime = (id: string, runtimeName: string, svc: string, role: iam.Role, protocol: 'MCP' | 'HTTP',
      allowedClient: string, env: Record<string, string>, headerAllowlist?: string[]) => {
      const code = codeAsset(svc, role);
      const rt = new agentcore.CfnRuntime(this, id, {
        agentRuntimeName: runtimeName, roleArn: role.roleArn, protocolConfiguration: protocol,
        description: `TrialScout ${svc} (${protocol})`,
        agentRuntimeArtifact: { codeConfiguration: {
          code: { s3: { bucket: code.s3BucketName, prefix: code.s3ObjectKey } },
          runtime: 'PYTHON_3_12', entryPoint: ['opentelemetry-instrument', 'main.py'] } },
        networkConfiguration: { networkMode: 'PUBLIC' },
        authorizerConfiguration: jwt(allowedClient),
        environmentVariables: { TS_SERVICE: svc, AGENT_OBSERVABILITY_ENABLED: 'true',
          OTEL_RESOURCE_ATTRIBUTES: `service.name=${runtimeName}`, ...env },
        lifecycleConfiguration: { idleRuntimeSessionTimeout: 900, maxLifetime: 3600 },
        ...(headerAllowlist ? { requestHeaderConfiguration: { requestHeaderAllowlist: headerAllowlist } } : {}),
      });
      rt.node.addDependency(role);
      delivery.add(id, rt.attrAgentRuntimeArn, `/aws/vendedlogs/bedrock-agentcore/${runtimeName}`);
      return rt;
    };
    // Gateway target URL for a Runtime-hosted MCP server: the runtime ARN must be URL-encoded.
    const runtimeMcpUrl = (rt: agentcore.CfnRuntime) => Fn.join('', [
      `https://bedrock-agentcore.${this.region}.amazonaws.com/runtimes/`,
      `arn%3Aaws%3Abedrock-agentcore%3A${this.region}%3A${this.account}%3Aruntime%2F`, rt.attrAgentRuntimeId,
      '/invocations?qualifier=DEFAULT']);

    // ======== Runtime: Study Portfolio MCP ========
    const studyRole = runtimeRole('StudyMcp', 'trialscout_study_mcp');
    f.studies.grantReadData(studyRole);
    f.sites.grantReadData(studyRole);
    const studyRt = runtime('StudyMcpRuntime', 'trialscout_study_mcp', 'mcp_study', studyRole, 'MCP',
      f.m2mClient.userPoolClientId, { STUDIES_TABLE: f.studies.tableName, SITES_TABLE: f.sites.tableName });

    // ======== Runtime: Policy & Protocol MCP ========
    const policyRole = runtimeRole('PolicyMcp', 'trialscout_policy_mcp');
    f.docsBucket.grantRead(policyRole, 'index/*');
    policyRole.addToPolicy(new iam.PolicyStatement({ sid: 'Embeddings', actions: ['bedrock:InvokeModel'],
      resources: [`arn:aws:bedrock:${this.region}::foundation-model/${EMBED_MODEL_ID}`] }));
    const policyRt = runtime('PolicyMcpRuntime', 'trialscout_policy_mcp', 'mcp_policy', policyRole, 'MCP',
      f.m2mClient.userPoolClientId, { DOCS_BUCKET: f.docsBucket.bucketName, EMBED_MODEL_ID });

    // ======== Identity: outbound OAuth2 credential provider (Gateway -> MCP runtimes) ========
    const bootstrapFn = new lambda.Function(this, 'IdentityBootstrapFn', {
      functionName: `${PREFIX}-identity-bootstrap`, runtime: lambda.Runtime.PYTHON_3_13, architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler', code: lambda.Code.fromAsset(path.join(ROOT, 'build', 'identity_bootstrap')),
      timeout: Duration.minutes(2), memorySize: 256,
      logGroup: new logs.LogGroup(this, 'IdentityBootstrapLogs', { retention: logs.RetentionDays.ONE_MONTH, encryptionKey: f.key, removalPolicy: RemovalPolicy.DESTROY }),
    });
    bootstrapFn.addToRolePolicy(new iam.PolicyStatement({ sid: 'CognitoAdmin', resources: [f.userPool.userPoolArn],
      actions: ['cognito-idp:DescribeUserPoolClient'] }));
    bootstrapFn.addToRolePolicy(new iam.PolicyStatement({ sid: 'CredentialProvider',
      actions: ['bedrock-agentcore:CreateOauth2CredentialProvider', 'bedrock-agentcore:UpdateOauth2CredentialProvider',
        'bedrock-agentcore:DeleteOauth2CredentialProvider', 'bedrock-agentcore:GetOauth2CredentialProvider',
        'bedrock-agentcore:CreateTokenVault', 'bedrock-agentcore:GetTokenVault'],
      resources: [`arn:aws:bedrock-agentcore:${this.region}:${this.account}:token-vault/*`] }));
    bootstrapFn.addToRolePolicy(new iam.PolicyStatement({ sid: 'IdentityVaultSecrets',
      actions: ['secretsmanager:CreateSecret', 'secretsmanager:PutSecretValue', 'secretsmanager:UpdateSecret',
        'secretsmanager:DeleteSecret', 'secretsmanager:DescribeSecret', 'secretsmanager:TagResource'],
      resources: [`arn:aws:secretsmanager:${this.region}:${this.account}:secret:bedrock-agentcore-identity!*`] }));
    const provider = new cr.Provider(this, 'IdentityBootstrapProvider', { onEventHandler: bootstrapFn });
    const providerName = `${PREFIX}-gateway-to-mcp`;
    const identity = new CustomResource(this, 'IdentityBootstrap', {
      serviceToken: provider.serviceToken, resourceType: 'Custom::AgentCoreIdentityBootstrap',
      properties: {
        ProviderName: providerName, UserPoolId: f.userPool.userPoolId, M2MClientId: f.m2mClient.userPoolClientId,
        DiscoveryUrl: f.discoveryUrl, Version: '2',
      },
    });
    const providerArn = identity.getAttString('ProviderArn');

    // ======== Gateway RBAC interceptor ========
    this.interceptorFn = new lambda.Function(this, 'RbacInterceptorFn', {
      functionName: `${PREFIX}-gateway-rbac`, runtime: lambda.Runtime.PYTHON_3_13, architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler', code: lambda.Code.fromAsset(path.join(ROOT, 'lambdas', 'rbac_interceptor')),
      timeout: Duration.seconds(5), memorySize: 256, environment: { ROLE_TOOLS: JSON.stringify(ROLE_TOOLS) },
      logGroup: new logs.LogGroup(this, 'RbacInterceptorLogs', { logGroupName: `/aws/lambda/${PREFIX}-gateway-rbac`,
        retention: logs.RetentionDays.ONE_MONTH, encryptionKey: f.key, removalPolicy: RemovalPolicy.DESTROY }),
    });

    // ======== Gateway ========
    const gatewayRole = new iam.Role(this, 'GatewayRole', {
      roleName: `${PREFIX}-gateway`, description: 'AgentCore Gateway service role',
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com', {
        conditions: { StringEquals: { 'aws:SourceAccount': this.account } } }),
    });
    this.interceptorFn.grantInvoke(gatewayRole);
    gatewayRole.addToPolicy(new iam.PolicyStatement({ sid: 'OutboundOAuth',
      actions: ['bedrock-agentcore:GetWorkloadAccessToken', 'bedrock-agentcore:GetResourceOauth2Token'],
      resources: [`arn:aws:bedrock-agentcore:${this.region}:${this.account}:workload-identity-directory/default`,
        `arn:aws:bedrock-agentcore:${this.region}:${this.account}:workload-identity-directory/default/workload-identity/*`,
        `arn:aws:bedrock-agentcore:${this.region}:${this.account}:token-vault/default`,
        `arn:aws:bedrock-agentcore:${this.region}:${this.account}:token-vault/default/oauth2credentialprovider/${providerName}`] }));
    gatewayRole.addToPolicy(new iam.PolicyStatement({ sid: 'OutboundOAuthSecret', actions: ['secretsmanager:GetSecretValue'],
      resources: [`arn:aws:secretsmanager:${this.region}:${this.account}:secret:bedrock-agentcore-identity!default/oauth2/${providerName}*`] }));

    this.gateway = new agentcore.CfnGateway(this, 'Gateway', {
      name: `${PREFIX}-gateway`, description: 'Aggregates Study Portfolio + Policy & Protocol MCP tools',
      roleArn: gatewayRole.roleArn, protocolType: 'MCP',
      protocolConfiguration: { mcp: { supportedVersions: ['2025-03-26', '2025-06-18'] } },
      authorizerType: 'CUSTOM_JWT', authorizerConfiguration: jwt(f.spaClient.userPoolClientId), // end-user tokens only
      interceptorConfigurations: [{
        interceptor: { lambda: { arn: this.interceptorFn.functionArn } },
        interceptionPoints: ['REQUEST', 'RESPONSE'], inputConfiguration: { passRequestHeaders: true },
      }],
    });
    this.gateway.node.addDependency(gatewayRole);
    delivery.add('Gateway', this.gateway.attrGatewayArn, `/aws/vendedlogs/bedrock-agentcore/${PREFIX}-gateway`);

    const target = (id: string, name: string, rt: agentcore.CfnRuntime, desc: string) => {
      const t = new agentcore.CfnGatewayTarget(this, id, {
        gatewayIdentifier: this.gateway.attrGatewayIdentifier, name, description: desc,
        targetConfiguration: { mcp: { mcpServer: { endpoint: runtimeMcpUrl(rt) } } },
        credentialProviderConfigurations: [{ credentialProviderType: 'OAUTH',
          credentialProvider: { oauthCredentialProvider: { providerArn, scopes: [MCP_SCOPE] } } }],
      });
      t.node.addDependency(identity);
      t.node.addDependency(rt);
      return t;
    };
    const studyTarget = target('StudyTarget', 'study-portfolio', studyRt, 'Study Portfolio MCP on AgentCore Runtime');
    const policyTarget = target('PolicyTarget', 'policy-protocol', policyRt, 'Policy & Protocol MCP on AgentCore Runtime');
    policyTarget.node.addDependency(studyTarget); // serialize target creation

    // ======== Memory ========
    const memory = new agentcore.CfnMemory(this, 'Memory', {
      name: `${PREFIX}_memory`, description: 'TrialScout short-term turns + long-term user preferences',
      eventExpiryDuration: 30, encryptionKeyArn: f.key.keyArn,
      memoryStrategies: [{ userPreferenceMemoryStrategy: { name: 'UserPreferences',
        description: 'Durable preferences such as favourite therapeutic areas or output format',
        namespaces: ['/users/{actorId}/preferences'] } }],
    });
    delivery.add('Memory', memory.attrMemoryArn, `/aws/vendedlogs/bedrock-agentcore/${PREFIX}-memory`);

    // ======== Runtime: the agent ========
    const agentRole = runtimeRole('Agent', 'trialscout_agent');
    agentRole.addToPolicy(new iam.PolicyStatement({ sid: 'InvokeClaude',
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: [`arn:aws:bedrock:${this.region}:${this.account}:inference-profile/${MODEL_ID}`,
        `arn:aws:bedrock:*::foundation-model/${MODEL_ID.replace(/^us\./, '')}`] }));
    agentRole.addToPolicy(new iam.PolicyStatement({ sid: 'Guardrail', actions: ['bedrock:ApplyGuardrail'],
      resources: [f.guardrail.attrGuardrailArn] }));
    agentRole.addToPolicy(new iam.PolicyStatement({ sid: 'Memory',
      actions: ['bedrock-agentcore:CreateEvent', 'bedrock-agentcore:GetEvent', 'bedrock-agentcore:ListEvents',
        'bedrock-agentcore:ListSessions', 'bedrock-agentcore:RetrieveMemoryRecords', 'bedrock-agentcore:ListMemoryRecords',
        'bedrock-agentcore:GetMemory'], resources: [memory.attrMemoryArn] }));
    f.key.grantEncryptDecrypt(agentRole); // memory + guardrail are encrypted with the CMK
    agentRole.addToPolicy(new iam.PolicyStatement({ sid: 'MemoryCmkViaAgentCore',
      actions: ['kms:CreateGrant', 'kms:DescribeKey', 'kms:GenerateDataKeyWithoutPlaintext'], resources: [f.key.keyArn],
      conditions: { StringEquals: { 'kms:ViaService': `bedrock-agentcore.${this.region}.amazonaws.com` } } }));

    // Bump the description to publish a new immutable guardrail version after changing the draft.
    const guardrailVersion = new bedrock.CfnGuardrailVersion(this, 'GuardrailVersion', {
      guardrailIdentifier: f.guardrail.attrGuardrailId, description: 'v2: prompt-attack MEDIUM',
    });

    this.agentRuntime = runtime('AgentRuntime', 'trialscout_agent', 'agent', agentRole, 'HTTP',
      f.spaClient.userPoolClientId, {
        MODEL_ID, GATEWAY_URL: this.gateway.attrGatewayUrl, MEMORY_ID: memory.attrMemoryId,
        GUARDRAIL_ID: f.guardrail.attrGuardrailId, GUARDRAIL_VERSION: guardrailVersion.attrVersion,
      }, ['Authorization', 'X-Amzn-Bedrock-AgentCore-Runtime-Custom-Correlation-Id']);
    this.agentRuntime.addResourceDependency(policyTarget);

    this.runtimeNames = ['trialscout_study_mcp', 'trialscout_policy_mcp', 'trialscout_agent'];
    new CfnOutput(this, 'StudyMcpRuntimeArn', { value: studyRt.attrAgentRuntimeArn });
    new CfnOutput(this, 'PolicyMcpRuntimeArn', { value: policyRt.attrAgentRuntimeArn });
    new CfnOutput(this, 'AgentRuntimeArn', { value: this.agentRuntime.attrAgentRuntimeArn });
    new CfnOutput(this, 'GatewayUrl', { value: this.gateway.attrGatewayUrl });
    new CfnOutput(this, 'GatewayId', { value: this.gateway.attrGatewayIdentifier });
    new CfnOutput(this, 'GuardrailVersionNumber', { value: guardrailVersion.attrVersion });
    new CfnOutput(this, 'MemoryId', { value: memory.attrMemoryId });
    new CfnOutput(this, 'M2MClientId', { value: f.m2mClient.userPoolClientId });
    new CfnOutput(this, 'CredentialProviderArn', { value: providerArn });
  }
}
