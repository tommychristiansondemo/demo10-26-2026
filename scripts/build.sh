#!/usr/bin/env bash
# Build deployable artifacts into build/:
#   build/<svc>.zip           AgentCore Runtime code packages (Python 3.12, linux/aarch64 wheels -- Runtime is ARM64)
#   build/identity_bootstrap/ Lambda dir with a current boto3 (needs the bedrock-agentcore-control API)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD="$ROOT/build"
PY="${PYTHON:-$ROOT/.venv/bin/python}"
mkdir -p "$BUILD"

COMMON_REQS=("boto3==1.43.118" "aws-opentelemetry-distro==0.21.0")
declare -A REQS=(
  [mcp_study]="mcp==1.30.0"
  [mcp_policy]="mcp==1.30.0"
  [agent]="strands-agents==1.62.0 bedrock-agentcore==1.25.0 mcp==1.30.0"
)

for svc in mcp_study mcp_policy agent; do
  out="$BUILD/$svc"
  rm -rf "$out" "$BUILD/$svc.zip"
  mkdir -p "$out"
  echo ">> $svc: installing aarch64 wheels"
  # shellcheck disable=SC2086
  "$PY" -m pip install --quiet --disable-pip-version-check --target "$out" \
    --platform manylinux2014_aarch64 --platform manylinux_2_28_aarch64 \
    --implementation cp --python-version 3.12 --only-binary=:all: \
    ${REQS[$svc]} "${COMMON_REQS[@]}"
  cp "$ROOT/services/$svc/"*.py "$ROOT/services/common/tslog.py" "$out/"
  find "$out" -name '__pycache__' -type d -prune -exec rm -rf {} +
  "$PY" - "$out" "$BUILD/$svc" <<'EOF'
import shutil, sys
shutil.make_archive(sys.argv[2], "zip", sys.argv[1])
EOF
  echo "   $(du -h "$BUILD/$svc.zip" | cut -f1)  build/$svc.zip"
done

echo ">> identity_bootstrap lambda"
rm -rf "$BUILD/identity_bootstrap" && mkdir -p "$BUILD/identity_bootstrap"
"$PY" -m pip install --quiet --disable-pip-version-check --target "$BUILD/identity_bootstrap" "boto3==1.43.118"
cp "$ROOT/lambdas/identity_bootstrap/index.py" "$BUILD/identity_bootstrap/"
echo "build complete"
