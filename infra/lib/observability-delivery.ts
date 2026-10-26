import { RemovalPolicy, Stack, aws_logs as logs, aws_xray as xray, aws_kms as kms } from 'aws-cdk-lib';
import { Construct } from 'constructs';

/**
 * Vended log + trace delivery for AgentCore resources (Runtime, Gateway, Memory):
 *   APPLICATION_LOGS -> CloudWatch Logs group under /aws/vendedlogs/ (KMS-encrypted)
 *   TRACES           -> X-Ray (lands in CloudWatch Transaction Search / GenAI Observability)
 * One shared X-Ray resource policy per stack (account quota on X-Ray resource policies is small).
 */
export class AgentCoreDelivery extends Construct {
  private readonly arns: string[] = [];
  private readonly xrayPolicyName: string;

  constructor(scope: Construct, id: string, private readonly key: kms.IKey) {
    super(scope, id);
    const stack = Stack.of(this);
    this.xrayPolicyName = `${stack.stackName}-agentcore-traces`;
  }

  add(id: string, resourceArn: string, logGroupName: string): logs.LogGroup {
    const stack = Stack.of(this);
    this.arns.push(resourceArn);
    const group = new logs.LogGroup(this, `${id}Logs`, {
      logGroupName, retention: logs.RetentionDays.ONE_MONTH, encryptionKey: this.key, removalPolicy: RemovalPolicy.DESTROY,
    });
    const logSrc = new logs.CfnDeliverySource(this, `${id}LogSrc`, { name: `trialscout-${id}-logs`.slice(0, 60), logType: 'APPLICATION_LOGS', resourceArn });
    const logDst = new logs.CfnDeliveryDestination(this, `${id}LogDst`, { name: `trialscout-${id}-logs-dst`.slice(0, 60), destinationResourceArn: group.logGroupArn });
    const logDel = new logs.CfnDelivery(this, `${id}LogDel`, { deliverySourceName: logSrc.name, deliveryDestinationArn: logDst.attrArn });
    logDel.addResourceDependency(logSrc);

    const trSrc = new logs.CfnDeliverySource(this, `${id}TraceSrc`, { name: `trialscout-${id}-traces`.slice(0, 60), logType: 'TRACES', resourceArn });
    const trDst = new logs.CfnDeliveryDestination(this, `${id}TraceDst`, { name: `trialscout-${id}-traces-dst`.slice(0, 60), deliveryDestinationType: 'XRAY' });
    const trDel = new logs.CfnDelivery(this, `${id}TraceDel`, { deliverySourceName: trSrc.name, deliveryDestinationArn: trDst.attrArn });
    trDel.addResourceDependency(trSrc);
    trDst.node.addDependency(this.policy(stack));
    return group;
  }

  private policyResource?: xray.CfnResourcePolicy;
  private policy(stack: Stack): xray.CfnResourcePolicy {
    if (!this.policyResource) {
      this.policyResource = new xray.CfnResourcePolicy(this, 'XRayDeliveryPolicy', {
        policyName: this.xrayPolicyName,
        policyDocument: stack.toJsonString({
          Version: '2012-10-17',
          Statement: [{
            Sid: 'AgentCoreTraceDelivery', Effect: 'Allow', Principal: { Service: 'delivery.logs.amazonaws.com' },
            Action: 'xray:PutTraceSegments', Resource: '*',
            Condition: {
              'ForAllValues:ArnLike': { 'logs:LogGeneratingResourceArns': this.arns },
              StringEquals: { 'aws:SourceAccount': stack.account },
              ArnLike: { 'aws:SourceArn': `arn:aws:logs:${stack.region}:${stack.account}:delivery-source:*` },
            },
          }],
        }),
      });
    }
    return this.policyResource;
  }
}
