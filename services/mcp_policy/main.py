"""Policy & Protocol MCP server -- runs on AgentCore Runtime (protocol MCP, stateless streamable HTTP).

Corpus: 8 SYNTHETIC SOPs + 5 protocol excerpts, chunked by section and embedded with Titan Text
Embeddings v2 at seed time. The index (chunks + vectors), rules and structured protocols live in a
KMS-encrypted S3 bucket and are loaded once per microVM.
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path

os.environ.setdefault("TS_SERVICE", "mcp-policy")

import boto3  # noqa: E402
from botocore.config import Config  # noqa: E402
from mcp.server.fastmcp import FastMCP  # noqa: E402

import policy  # noqa: E402
from tslog import log, metric  # noqa: E402

REGION = os.environ.get("AWS_REGION", "us-east-1")
DOCS_BUCKET = os.environ.get("DOCS_BUCKET", "")
EMBED_MODEL = os.environ.get("EMBED_MODEL_ID", "amazon.titan-embed-text-v2:0")
EMBED_DIM = 512
LOCAL_DATA = os.environ.get("TS_LOCAL_DATA")

_cfg = Config(retries={"max_attempts": 4, "mode": "adaptive"}, connect_timeout=3, read_timeout=15)
_s3 = boto3.client("s3", region_name=REGION, config=_cfg)
_bedrock = boto3.client("bedrock-runtime", region_name=REGION, config=_cfg)
_store: dict[str, object] = {}

mcp = FastMCP("policy-protocol", host="0.0.0.0", port=8000, stateless_http=True)


def _get(name: str):
    if name not in _store:
        if LOCAL_DATA:
            _store[name] = json.loads((Path(LOCAL_DATA) / f"{name}.json").read_text())
        else:
            obj = _s3.get_object(Bucket=DOCS_BUCKET, Key=f"index/{name}.json")
            _store[name] = json.loads(obj["Body"].read())
    return _store[name]


def embed(text: str) -> list[float] | None:
    try:
        resp = _bedrock.invoke_model(modelId=EMBED_MODEL, body=json.dumps(
            {"inputText": text[:4000], "dimensions": EMBED_DIM, "normalize": True}))
        return json.loads(resp["body"].read())["embedding"]
    except Exception as e:  # degrade to keyword search rather than fail the tool
        log("embed_failed", level="WARN", error_type=type(e).__name__)
        metric("EmbeddingFallbacks")
        return None


def _run(tool: str, fn, **meta):
    t0 = time.time()
    try:
        result = fn()
        log("tool_ok", tool=tool, latency_ms=round(1000 * (time.time() - t0)), **meta)
        metric("ToolInvocations", Tool=tool)
        return result
    except Exception as e:
        log("tool_error", level="ERROR", tool=tool, error_type=type(e).__name__, **meta)
        metric("ToolErrors", Tool=tool)
        return {"error": f"{tool} failed: {type(e).__name__}. Try again or narrow the request."}


@mcp.tool()
def search_documents(query: str, top_k: int = 4, doc_type: str | None = None) -> dict:
    """Retrieve passages from SYNTHETIC SOP/policy documents and protocol excerpts.

    Args:
        query: what to look for, e.g. "SAE reporting timeline" or "re-consent after amendment".
        top_k: number of passages (1-8).
        doc_type: optional filter, "sop" or "protocol".
    """
    return _run("search_documents", lambda: policy.search_documents(
        _get("index"), query, None if LOCAL_DATA else embed(query), top_k, doc_type), top_k=top_k, doc_type=doc_type)


@mcp.tool()
def check_compliance(protocol_id: str, version: str = "latest") -> dict:
    """Check a protocol version against the SOP rule set (visit windows, SAE timelines, consent, DSMB, ...).

    Args:
        protocol_id: e.g. PRT-TS-003 (a bare study id like TS-003 also works).
        version: "1.0", "2.0" or "latest".
    """
    return _run("check_compliance", lambda: policy.check_compliance(
        _get("protocols"), _get("rules"), protocol_id, version), protocol_id=protocol_id, version=version)


@mcp.tool()
def summarize_amendment(protocol_id: str, from_version: str = "1.0", to_version: str = "2.0") -> dict:
    """Structured summary of a protocol amendment: field changes, SOP-007 classification,
    compliance delta and required follow-up actions.

    Args:
        protocol_id: e.g. PRT-TS-001.
        from_version: baseline version (default "1.0").
        to_version: amended version (default "2.0").
    """
    return _run("summarize_amendment", lambda: policy.summarize_amendment(
        _get("protocols"), _get("rules"), protocol_id, from_version, to_version), protocol_id=protocol_id)


if __name__ == "__main__":
    log("server_start", bucket_configured=bool(DOCS_BUCKET))
    mcp.run(transport="streamable-http")
