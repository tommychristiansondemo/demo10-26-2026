"""Offline tests for the Gateway RBAC interceptor contract."""
import base64
import importlib.util
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "infra"))
os.environ["ROLE_TOOLS"] = json.dumps({"reader": ["search_studies", "get_site_performance", "search_documents"],
                                       "analyst": ["search_studies", "get_site_performance", "forecast_enrollment",
                                                   "search_documents", "check_compliance", "summarize_amendment"]})
spec = importlib.util.spec_from_file_location("interceptor", ROOT / "lambdas" / "rbac_interceptor" / "index.py")
ic = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ic)


def token(groups):
    b = lambda d: base64.urlsafe_b64encode(json.dumps(d).encode()).decode().rstrip("=")
    return f"Bearer {b({'alg': 'none'})}.{b({'sub': 'u1', 'cognito:groups': groups})}.sig"


def req(groups, method, name=None):
    body = {"jsonrpc": "2.0", "id": 7, "method": method}
    if name:
        body["params"] = {"name": name, "arguments": {}}
    return {"interceptorInputVersion": "1.0", "mcp": {"gatewayRequest": {"headers": {"Authorization": token(groups)}, "body": body},
                                                     "gatewayResponse": None}}


def test_reader_denied_forecast():
    out = ic.handler(req(["reader"], "tools/call", "study-portfolio___forecast_enrollment"), None)
    assert out["mcp"]["transformedGatewayResponse"]["body"]["error"]["code"] == -32003


def test_analyst_allowed_forecast_passthrough():
    out = ic.handler(req(["analyst"], "tools/call", "study-portfolio___forecast_enrollment"), None)
    assert "transformedGatewayResponse" not in out["mcp"]
    assert out["mcp"]["transformedGatewayRequest"]["body"]["params"]["name"].endswith("forecast_enrollment")


def test_no_group_gets_nothing():
    out = ic.handler(req([], "tools/call", "policy-protocol___search_documents"), None)
    assert "error" in out["mcp"]["transformedGatewayResponse"]["body"]


def test_tools_list_filtered_for_reader():
    ev = req(["reader"], "tools/list")
    names = [f"study-portfolio___{t}" for t in ("search_studies", "get_site_performance", "forecast_enrollment")] + \
            [f"policy-protocol___{t}" for t in ("search_documents", "check_compliance", "summarize_amendment")]
    ev["mcp"]["gatewayResponse"] = {"statusCode": 200, "body": {"jsonrpc": "2.0", "id": 7, "result": {"tools": [{"name": n} for n in names]}}}
    out = ic.handler(ev, None)
    kept = [t["name"].split("___")[1] for t in out["mcp"]["transformedGatewayResponse"]["body"]["result"]["tools"]]
    assert sorted(kept) == ["get_site_performance", "search_documents", "search_studies"]
