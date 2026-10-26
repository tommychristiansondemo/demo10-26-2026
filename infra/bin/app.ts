import { App, DefaultStackSynthesizer, Tags } from 'aws-cdk-lib';
import { TAGS } from '../lib/config';
import { FoundationStack } from '../lib/foundation-stack';
import { AgentCoreStack } from '../lib/agentcore-stack';
import { ApiStack } from '../lib/api-stack';
import { WebStack } from '../lib/web-stack';
import { ObservabilityStack } from '../lib/observability-stack';
import { InsightsStack } from '../lib/insights-stack';

const app = new App();
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1' };
const hostedZoneId = app.node.tryGetContext('hostedZoneId') ?? 'Z02882605B7GUS0L3VHX';
const synthesizer = new DefaultStackSynthesizer({ qualifier: 'tscout' });
const common = { env, synthesizer };

const foundation = new FoundationStack(app, 'TrialScout-Foundation', { ...common, description: 'TrialScout: KMS, data, Cognito, guardrail, alerting' });
const agentcore = new AgentCoreStack(app, 'TrialScout-AgentCore', { ...common, foundation, description: 'TrialScout: AgentCore Runtime x3, Gateway, Identity, Memory' });
const apiStack = new ApiStack(app, 'TrialScout-Api', { ...common, foundation, agentcore, description: 'TrialScout: streaming REST API + proxy' });
const web = new WebStack(app, 'TrialScout-Web', { ...common, foundation, apiStack, hostedZoneId, description: 'TrialScout: CloudFront, WAF, ACM, www alias' });
new ObservabilityStack(app, 'TrialScout-Observability', { ...common, foundation, agentcore, apiStack, web, description: 'TrialScout: dashboard + alarms' });
new InsightsStack(app, 'TrialScout-Insights', { ...common, foundation, hostedZoneId, description: 'TrialScout Insights: read-only teaching portal, knowledge bucket, Bedrock invocation logging' });

for (const [k, v] of Object.entries(TAGS)) Tags.of(app).add(k, v);
