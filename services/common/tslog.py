"""Structured JSON logging + CloudWatch EMF metrics shared by every TrialScout service.

Rules enforced here (so callers cannot forget them):
  * Every line is one JSON object with service, level, event and correlation_id.
  * correlation_id = explicit ID if the caller set one, else the active OpenTelemetry trace id,
    so a log line can always be joined to its X-Ray / GenAI Observability trace.
  * Free text (prompts, answers, tool arguments/results) is never logged. `safe_fields` keeps
    only scalar metadata (ids, counts, latencies, names) and drops long strings.
"""
from __future__ import annotations

import contextvars
import json
import os
import sys
import time
from typing import Any

SERVICE = os.environ.get("TS_SERVICE", "trialscout")
METRIC_NAMESPACE = "TrialScout"
_correlation: contextvars.ContextVar[str | None] = contextvars.ContextVar("ts_correlation", default=None)

# Keys whose values may contain user text or document content -- always dropped.
_BLOCKED_KEYS = {"prompt", "query", "text", "answer", "content", "message", "body", "arguments", "result", "authorization", "token"}


def set_correlation_id(value: str | None) -> None:
    _correlation.set(value)


def correlation_id() -> str | None:
    cid = _correlation.get()
    if cid:
        return cid
    try:  # fall back to the OTel trace id injected by ADOT on AgentCore Runtime
        from opentelemetry import trace

        ctx = trace.get_current_span().get_span_context()
        if ctx and ctx.trace_id:
            return format(ctx.trace_id, "032x")
    except Exception:  # pragma: no cover - otel not installed locally
        pass
    return None


def safe_fields(fields: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for k, v in fields.items():
        if k.lower() in _BLOCKED_KEYS:
            continue
        if isinstance(v, str) and len(v) > 80:
            out[k] = f"<str len={len(v)}>"
        elif isinstance(v, (str, int, float, bool)) or v is None:
            out[k] = v
        elif isinstance(v, (list, tuple)) and all(isinstance(i, (str, int, float)) and len(str(i)) <= 64 for i in v):
            out[k] = list(v)[:20]
        else:
            out[k] = f"<{type(v).__name__}>"
    return out


def log(event: str, level: str = "INFO", **fields: Any) -> None:
    rec = {"ts": round(time.time(), 3), "level": level, "service": SERVICE, "event": event,
           "correlation_id": correlation_id(), **safe_fields(fields)}
    print(json.dumps(rec, default=str), file=sys.stdout, flush=True)


def metric(name: str, value: float = 1.0, unit: str = "Count", **dims: str) -> None:
    """Emit one CloudWatch Embedded Metric Format record (extracted from the log stream)."""
    dims = {"Service": SERVICE, **dims}
    rec = {
        "_aws": {"Timestamp": int(time.time() * 1000),
                 "CloudWatchMetrics": [{"Namespace": METRIC_NAMESPACE, "Dimensions": [list(dims)],
                                        "Metrics": [{"Name": name, "Unit": unit}]}]},
        name: value, **dims, "correlation_id": correlation_id(),
    }
    print(json.dumps(rec), file=sys.stdout, flush=True)
