"""Study Portfolio MCP server -- runs on AgentCore Runtime (protocol MCP, stateless streamable HTTP).

AgentCore Runtime expects an MCP server listening on 0.0.0.0:8000 at path /mcp. Inbound auth
(JWT from the Gateway's machine client) is enforced by Runtime before any request reaches this code.
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path

os.environ.setdefault("TS_SERVICE", "mcp-study")

import boto3  # noqa: E402
from botocore.config import Config  # noqa: E402
from mcp.server.fastmcp import FastMCP  # noqa: E402

import portfolio  # noqa: E402
from tslog import log, metric  # noqa: E402

REGION = os.environ.get("AWS_REGION", "us-east-1")
STUDIES_TABLE = os.environ.get("STUDIES_TABLE", "")
SITES_TABLE = os.environ.get("SITES_TABLE", "")
LOCAL_DATA = os.environ.get("TS_LOCAL_DATA")  # unit tests / local runs read JSON instead of DynamoDB
CACHE_TTL = 300

_ddb = boto3.resource("dynamodb", region_name=REGION, config=Config(
    retries={"max_attempts": 5, "mode": "adaptive"}, connect_timeout=3, read_timeout=10))
_cache: dict[str, tuple[float, list[dict]]] = {}

mcp = FastMCP("study-portfolio", host="0.0.0.0", port=8000, stateless_http=True)


def _scan(table: str) -> list[dict]:
    items, kwargs = [], {}
    t = _ddb.Table(table)
    while True:
        page = t.scan(**kwargs)
        items += [json.loads(i["doc"]) for i in page["Items"]]
        if "LastEvaluatedKey" not in page:
            return items
        kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]


def _load(kind: str) -> list[dict]:
    hit = _cache.get(kind)
    if hit and time.time() - hit[0] < CACHE_TTL:
        return hit[1]
    if LOCAL_DATA:
        data = json.loads((Path(LOCAL_DATA) / f"{kind}.json").read_text())
    else:
        data = _scan(STUDIES_TABLE if kind == "studies" else SITES_TABLE)
    _cache[kind] = (time.time(), data)
    return data


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
def search_studies(query: str = "", therapeutic_area: str | None = None, phase: str | None = None,
                   status: str | None = None, limit: int = 10) -> dict:
    """Search the SYNTHETIC clinical-study portfolio.

    Args:
        query: free-text terms matched against study id, title, program, indication and CRO.
        therapeutic_area: e.g. Oncology, Cardiology, Neurology, Immunology, Metabolic, Infectious Disease.
        phase: "1", "2", "3" or "Phase 2".
        status: e.g. Recruiting, On Hold, Planning, Completed, "Active, not recruiting".
        limit: max studies to return (1-25).
    """
    return _run("search_studies", lambda: portfolio.search_studies(
        _load("studies"), query, therapeutic_area, phase, status, limit), has_query=bool(query), limit=limit)


@mcp.tool()
def get_site_performance(study_id: str | None = None, site_id: str | None = None,
                         only_flagged: bool = False, limit: int = 20) -> dict:
    """Site KPIs (enrollment rate, screen-failure rate, deviations, query age) with SOP policy flags.

    Args:
        study_id: restrict to one study, e.g. TS-005.
        site_id: a single site, e.g. S-014.
        only_flagged: return only sites breaching an SOP threshold.
        limit: max sites to return (1-60), worst performers first.
    """
    return _run("get_site_performance", lambda: portfolio.get_site_performance(
        _load("sites"), study_id, site_id, only_flagged, limit), study_id=study_id, site_id=site_id)


@mcp.tool()
def forecast_enrollment(study_id: str, window_months: int = 6) -> dict:
    """Project when a study reaches its enrollment target (P10/P50/P90) and whether it is on plan.

    Args:
        study_id: the study to forecast, e.g. TS-001.
        window_months: months of recent history used for the rate (3-12).
    """
    def go():
        study = next((s for s in _load("studies") if s["study_id"] == study_id.upper()), None)
        if not study:
            return {"error": f"Unknown study_id {study_id!r}. Use search_studies to find valid ids."}
        return portfolio.forecast_enrollment(study, window_months)
    return _run("forecast_enrollment", go, study_id=study_id)


if __name__ == "__main__":
    log("server_start", tables_configured=bool(STUDIES_TABLE and SITES_TABLE))
    mcp.run(transport="streamable-http")
