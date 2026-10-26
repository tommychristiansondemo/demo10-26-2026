#!/usr/bin/env bash
# One-command deploy: preflight -> build -> bootstrap (own qualifier) -> Foundation -> seed -> remaining stacks.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export AWS_REGION=us-east-1 CDK_DEFAULT_REGION=us-east-1
export CDK_DEFAULT_ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
TAGS=(--tags Project=TrialScout --tags Owner=instructor --tags Environment=demo)
CDK=(npx --prefix "$ROOT/infra" cdk --app "npx tsx bin/app.ts")

echo "== preflight"
arn="$(aws sts get-caller-identity --query Arn --output text)"
[[ "$arn" == *":root" ]] && { echo "Refusing to run with root credentials"; exit 1; }
aws route53 get-hosted-zone --id Z02882605B7GUS0L3VHX --query HostedZone.Name --output text
aws bedrock-runtime converse --region us-east-1 --model-id us.anthropic.claude-sonnet-4-6 \
  --messages '[{"role":"user","content":[{"text":"ping"}]}]' --inference-config maxTokens=5 --query stopReason --output text

echo "== build"
"$ROOT/scripts/build.sh"

cd "$ROOT/infra"
if ! aws cloudformation describe-stacks --stack-name TrialScout-CDKToolkit >/dev/null 2>&1; then
  echo "== bootstrap (TrialScout-CDKToolkit, qualifier tscout)"
  "${CDK[@]}" bootstrap "aws://$CDK_DEFAULT_ACCOUNT/us-east-1" --qualifier tscout --toolkit-stack-name TrialScout-CDKToolkit "${TAGS[@]}"
fi

echo "== deploy Foundation"
"${CDK[@]}" deploy TrialScout-Foundation --require-approval never --toolkit-stack-name TrialScout-CDKToolkit --outputs-file "$ROOT/build/outputs-foundation.json"
echo "== seed synthetic data"
"$ROOT/.venv/bin/python" "$ROOT/scripts/seed.py"
echo "== deploy AgentCore, Api, Web, Observability, Insights"
"${CDK[@]}" deploy TrialScout-AgentCore TrialScout-Api TrialScout-Web TrialScout-Observability TrialScout-Insights \
  --require-approval never --toolkit-stack-name TrialScout-CDKToolkit --outputs-file "$ROOT/build/outputs.json"
echo "== publish projectknowledge.md + source snapshot to the Insights knowledge bucket"
"$ROOT/.venv/bin/python" "$ROOT/scripts/publish_knowledge.py"
echo "== done: https://www.awsteach.com  |  https://insights.awsteach.com"
