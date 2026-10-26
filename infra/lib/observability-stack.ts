import {
  Duration, Stack, StackProps, CfnOutput,
  aws_cloudwatch as cw, aws_cloudwatch_actions as cwa, aws_logs as logs,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { PREFIX } from './config';
import { FoundationStack } from './foundation-stack';
import { AgentCoreStack } from './agentcore-stack';
import { ApiStack } from './api-stack';
import { WebStack } from './web-stack';

interface Props extends StackProps { foundation: FoundationStack; agentcore: AgentCoreStack; apiStack: ApiStack; web: WebStack }

/** CloudWatch dashboard + alarms. Traces/spans live in CloudWatch GenAI Observability (AgentCore tab). */
export class ObservabilityStack extends Stack {
  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);
    const alarmAction = new cwa.SnsAction(props.foundation.alarmTopic);
    const p5 = Duration.minutes(5);
    const ts = (name: string, stat = 'Sum', dims: Record<string, string> = {}) =>
      new cw.Metric({ namespace: 'TrialScout', metricName: name, statistic: stat, period: p5, dimensionsMap: dims });
    const search = (expr: string, label: string) => new cw.MathExpression({ expression: expr, label, period: p5 });

    const api = props.apiStack.api;
    const fn = props.apiStack.proxyFn;

    // RBAC denials at the Gateway interceptor -> metric via log filter (interceptor logs JSON)
    const denied = new logs.MetricFilter(this, 'GatewayDenials', {
      logGroup: logs.LogGroup.fromLogGroupName(this, 'RbacLogs', `/aws/lambda/${PREFIX}-gateway-rbac`),
      metricNamespace: 'TrialScout', metricName: 'GatewayToolDenied', metricValue: '1', defaultValue: 0,
      filterPattern: logs.FilterPattern.stringValue('$.event', '=', 'tool_denied'),
    }).metric({ statistic: 'Sum', period: p5 });

    const alarm = (id: string, metric: cw.IMetric, threshold: number, desc: string) => {
      const a = new cw.Alarm(this, id, {
        alarmName: `${PREFIX}-${id}`, metric, threshold, evaluationPeriods: 1, alarmDescription: desc,
        comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD, treatMissingData: cw.TreatMissingData.NOT_BREACHING,
      });
      a.addAlarmAction(alarmAction);
      return a;
    };
    const alarms = [
      alarm('Api5xx', api.metricServerError({ period: p5, statistic: 'Sum' }), 3, 'API Gateway 5xx responses'),
      alarm('ProxyErrors', fn.metricErrors({ period: p5 }), 3, 'Chat proxy Lambda errors'),
      alarm('ProxyThrottles', fn.metricThrottles({ period: p5 }), 1, 'Chat proxy Lambda throttled'),
      alarm('AgentErrors', ts('AgentErrors', 'Sum', { Service: 'agent' }), 3, 'Agent invocation errors (EMF)'),
      alarm('ChatLatencyP90', ts('ChatLatency', 'p90', { Service: 'agent' }), 60000, 'p90 end-to-end agent latency >= 60s'),
      alarm('GuardrailBlockSpike', ts('GuardrailBlocked', 'Sum', { Service: 'agent' }), 10, 'Possible prompt-injection campaign'),
      alarm('GatewayDenialSpike', denied, 10, 'Many RBAC denials at the Gateway'),
    ];

    const dash = new cw.Dashboard(this, 'Dashboard', { dashboardName: `${PREFIX}-ops`, defaultInterval: Duration.hours(3) });
    dash.addWidgets(
      new cw.TextWidget({ width: 24, height: 2, markdown:
        '# TrialScout operations\nTraces and spans: **CloudWatch > GenAI Observability > Bedrock AgentCore**. ' +
        'Logs carry `correlation_id` (also returned as `X-Correlation-Id`). Content is never logged.' }),
      new cw.AlarmStatusWidget({ width: 24, height: 3, alarms, title: 'Alarms' }),
    );
    dash.addWidgets(
      new cw.GraphWidget({ title: 'API requests / errors', width: 8, left: [api.metricCount({ period: p5 })],
        right: [api.metricClientError({ period: p5 }), api.metricServerError({ period: p5 })] }),
      new cw.GraphWidget({ title: 'Agent latency (ms)', width: 8,
        left: [ts('ChatLatency', 'p50', { Service: 'agent' }), ts('ChatLatency', 'p90', { Service: 'agent' })] }),
      new cw.GraphWidget({ title: 'Safety: guardrail blocks, RBAC denials, flagged tool output', width: 8,
        left: [ts('GuardrailBlocked', 'Sum', { Service: 'agent' }), denied,
          search(`SEARCH('{TrialScout,Service,Tool} MetricName="SuspiciousToolOutput"', 'Sum', 300)`, 'SuspiciousToolOutput')] }),
    );
    dash.addWidgets(
      new cw.GraphWidget({ title: 'MCP tool invocations by tool', width: 12,
        left: [search(`SEARCH('{TrialScout,Service,Tool} MetricName="ToolInvocations"', 'Sum', 300)`, 'ToolInvocations')] }),
      new cw.GraphWidget({ title: 'MCP tool errors', width: 12,
        left: [search(`SEARCH('{TrialScout,Service,Tool} MetricName="ToolErrors"', 'Sum', 300)`, 'ToolErrors')] }),
    );
    dash.addWidgets(
      new cw.GraphWidget({ title: 'AgentCore Runtime / Gateway / Memory (vended metrics)', width: 12,
        left: [search(`SEARCH('{AWS/Bedrock-AgentCore} MetricName="Invocations"', 'Sum', 300)`, 'Invocations')],
        right: [search(`SEARCH('{AWS/Bedrock-AgentCore} (MetricName="SystemErrors" OR MetricName="UserErrors" OR MetricName="Throttles")', 'Sum', 300)`, 'Errors')] }),
      new cw.GraphWidget({ title: 'Proxy Lambda', width: 12,
        left: [fn.metricInvocations({ period: p5 }), fn.metricErrors({ period: p5 })], right: [fn.metricDuration({ period: p5, statistic: 'p90' })] }),
    );
    dash.addWidgets(new cw.LogQueryWidget({
      title: 'Recent agent invocations (metadata only)', width: 24, height: 6,
      logGroupNames: [`/aws/lambda/${PREFIX}-chat-proxy`],
      queryLines: ['fields @timestamp, event, correlation_id, status, latency_ms', 'filter ispresent(correlation_id)', 'sort @timestamp desc', 'limit 50'],
    }));

    new CfnOutput(this, 'DashboardUrl', {
      value: `https://${this.region}.console.aws.amazon.com/cloudwatch/home?region=${this.region}#dashboards/dashboard/${PREFIX}-ops` });
  }
}
