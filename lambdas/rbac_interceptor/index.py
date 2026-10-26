"""AgentCore Gateway interceptor -- per-role tool authorization (REQUEST + RESPONSE).

REQUEST : tools/call for a tool outside the caller's role -> short-circuit with a JSON-RPC error.
RESPONSE: tools/list -> remove tools the caller's role may not see.

The bearer token was already validated by the Gateway's JWT authorizer before this runs, so we only
decode its claims here. The token itself is never logged.
"""
import base64
import json
import os

ROLE_TOOLS = json.loads(os.environ["ROLE_TOOLS"])  # {"reader": [...], "analyst": [...]}
DENIED_CODE = -32003


def _log(**fields):
    print(json.dumps({"service": "gateway-interceptor", **fields}))


def _groups(headers: dict) -> list:
    auth = next((v for k, v in (headers or {}).items() if k.lower() == "authorization"), "")
    try:
        payload = auth.split()[1].split(".")[1]
        claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
        return claims.get("cognito:groups", [])
    except Exception:
        return []


def _allowed(groups: list) -> set:
    allowed = set()
    for g in groups:
        allowed |= set(ROLE_TOOLS.get(g, []))
    return allowed  # no recognised group -> no tools


def _short(name: str) -> str:
    return name.split("___")[-1]


def handler(event, _context):
    mcp = event.get("mcp", {})
    req = mcp.get("gatewayRequest") or {}
    body = req.get("body") or {}
    method = body.get("method")
    allowed = _allowed(_groups(req.get("headers")))
    resp = mcp.get("gatewayResponse")  # null/absent on REQUEST events -> dispatch on truthiness

    if not resp:  # ---- REQUEST interception
        if method == "tools/call":
            tool = _short(body.get("params", {}).get("name", ""))
            if tool not in allowed:
                _log(event="tool_denied", tool=tool, groups=sorted(_groups(req.get("headers"))))
                return {"interceptorOutputVersion": "1.0", "mcp": {"transformedGatewayResponse": {
                    "statusCode": 200,
                    "body": {"jsonrpc": "2.0", "id": body.get("id"),
                             "error": {"code": DENIED_CODE, "message": f"Access denied: your role may not call '{tool}'."}}}}}
            _log(event="tool_allowed", tool=tool)
        return {"interceptorOutputVersion": "1.0", "mcp": {"transformedGatewayRequest": {"body": body}}}

    # ---- RESPONSE interception
    rbody = resp.get("body") or {}
    if method == "tools/list" and isinstance(rbody.get("result"), dict):
        tools = rbody["result"].get("tools", [])
        kept = [t for t in tools if _short(t.get("name", "")) in allowed]
        rbody["result"]["tools"] = kept
        _log(event="tools_filtered", total=len(tools), visible=len(kept))
    return {"interceptorOutputVersion": "1.0",
            "mcp": {"transformedGatewayResponse": {"statusCode": resp.get("statusCode", 200), "body": rbody}}}
