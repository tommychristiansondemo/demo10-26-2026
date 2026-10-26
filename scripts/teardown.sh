#!/usr/bin/env bash
# One-command teardown of everything TrialScout created (and nothing else):
#   1. cdk destroy all 6 stacks (reverse order; Insights first, which also turns Bedrock invocation logging off)
#   2. sweep runtime-created log groups, the www + insights ACM validation CNAMEs, and trialscout/* secrets
#   3. with --include-bootstrap: delete TrialScout-CDKToolkit and its RETAINED asset bucket
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export AWS_REGION=us-east-1 CDK_DEFAULT_REGION=us-east-1
export CDK_DEFAULT_ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
ZONE=Z02882605B7GUS0L3VHX
INCLUDE_BOOTSTRAP=false; [[ "${1:-}" == "--include-bootstrap" ]] && INCLUDE_BOOTSTRAP=true

# ACM validation CNAMEs for www + insights (CloudFormation leaves them behind); capture before the certs are deleted.
cnames=()
for host in www.awsteach.com insights.awsteach.com; do
  cert_arn=$(aws acm list-certificates --query "CertificateSummaryList[?DomainName=='$host'].CertificateArn|[0]" --output text)
  if [[ "$cert_arn" != "None" && -n "$cert_arn" ]]; then
    cnames+=("$(aws acm describe-certificate --certificate-arn "$cert_arn" --query 'Certificate.DomainValidationOptions[0].ResourceRecord' --output json)")
  fi
done

echo "== cdk destroy"
cd "$ROOT/infra"
for s in TrialScout-Insights TrialScout-Observability TrialScout-Web TrialScout-Api TrialScout-AgentCore TrialScout-Foundation; do
  if aws cloudformation describe-stacks --stack-name "$s" >/dev/null 2>&1; then
    npx cdk --app "npx tsx bin/app.ts" destroy "$s" --force --toolkit-stack-name TrialScout-CDKToolkit || { echo "!! $s failed"; exit 1; }
  fi
done

echo "== sweep runtime log groups"
for lg in $(aws logs describe-log-groups --log-group-name-prefix /aws/bedrock-agentcore/runtimes/trialscout --query 'logGroups[].logGroupName' --output text); do
  aws logs delete-log-group --log-group-name "$lg" && echo "deleted $lg"
done

echo "== sweep CDK helper Lambda log groups (created outside the stacks)"
for prefix in /aws/lambda/TrialScout- /aws/lambda/trialscout-; do
  for lg in $(aws logs describe-log-groups --log-group-name-prefix "$prefix" --query 'logGroups[].logGroupName' --output text); do
    aws logs delete-log-group --log-group-name "$lg" && echo "deleted $lg"
  done
done

echo "== sweep AgentCore Identity vault secret for our provider (if the service left it)"
for s in $(aws secretsmanager list-secrets --include-planned-deletion --filters Key=name,Values='bedrock-agentcore-identity!default/oauth2/trialscout-' --query 'SecretList[].ARN' --output text); do
  aws secretsmanager delete-secret --secret-id "$s" --force-delete-without-recovery >/dev/null && echo "deleted $s"
done

echo "== sweep secrets (trialscout/* only)"
for s in $(aws secretsmanager list-secrets --include-planned-deletion --filters Key=name,Values=trialscout/ --query 'SecretList[].ARN' --output text); do
  aws secretsmanager delete-secret --secret-id "$s" --force-delete-without-recovery >/dev/null && echo "deleted $s"
done

for cname_json in "${cnames[@]}"; do
  [[ -z "$cname_json" || "$cname_json" == "null" ]] && continue
  name=$(echo "$cname_json" | jq -r .Name); value=$(echo "$cname_json" | jq -r .Value)
  if aws route53 list-resource-record-sets --hosted-zone-id $ZONE --query "ResourceRecordSets[?Name=='$name']" --output text | grep -q CNAME; then
    aws route53 change-resource-record-sets --hosted-zone-id $ZONE --change-batch \
      "{\"Changes\":[{\"Action\":\"DELETE\",\"ResourceRecordSet\":{\"Name\":\"$name\",\"Type\":\"CNAME\",\"TTL\":300,\"ResourceRecords\":[{\"Value\":\"$value\"}]}}]}" >/dev/null \
      && echo "deleted ACM validation CNAME $name"
  fi
done

echo "== verify Bedrock model invocation logging is off (the Insights stack disables it on delete)"
aws bedrock get-model-invocation-logging-configuration --query loggingConfig --output json

if $INCLUDE_BOOTSTRAP; then
  echo "== delete bootstrap TrialScout-CDKToolkit"
  bucket=$(aws cloudformation describe-stack-resources --stack-name TrialScout-CDKToolkit --logical-resource-id StagingBucket --query 'StackResources[0].PhysicalResourceId' --output text 2>/dev/null)
  repo=$(aws cloudformation describe-stack-resources --stack-name TrialScout-CDKToolkit --logical-resource-id ContainerAssetsRepository --query 'StackResources[0].PhysicalResourceId' --output text 2>/dev/null)
  [[ -n "$repo" && "$repo" != "None" ]] && aws ecr delete-repository --repository-name "$repo" --force >/dev/null 2>&1
  aws cloudformation delete-stack --stack-name TrialScout-CDKToolkit
  aws cloudformation wait stack-delete-complete --stack-name TrialScout-CDKToolkit
  if [[ -n "$bucket" && "$bucket" != "None" ]] && aws s3api head-bucket --bucket "$bucket" 2>/dev/null; then
    "$ROOT/.venv/bin/python" - "$bucket" <<'EOF'
import boto3, sys
b = boto3.resource("s3").Bucket(sys.argv[1]); b.object_versions.delete(); b.delete(); print("deleted retained bucket", sys.argv[1])
EOF
  fi
fi

echo "== verify: remaining resources tagged Project=TrialScout"
aws resourcegroupstaggingapi get-resources --tag-filters Key=Project,Values=TrialScout --query 'ResourceTagMappingList[].ResourceARN' --output text
aws cloudformation list-stacks --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE ROLLBACK_COMPLETE DELETE_FAILED --query "StackSummaries[?starts_with(StackName,'TrialScout')].StackName" --output text
echo "teardown complete (KMS key is in its 7-day pending-deletion window)"
