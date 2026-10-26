"""Policy & Protocol domain logic: hybrid retrieval, rule-based compliance, amendment diff.

Pure functions over the index/rules/protocols loaded by main.py, so they can be unit-tested offline.
"""
from __future__ import annotations

import math
import re

_WORD = re.compile(r"[a-z0-9][a-z0-9\-.]+")
_STOP = {"the", "and", "for", "with", "that", "this", "are", "must", "may", "what", "which", "does", "our", "how", "any"}


def _tokens(text: str) -> list[str]:
    return [t for t in _WORD.findall(text.lower()) if t not in _STOP]


def _cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na, nb = math.sqrt(sum(x * x for x in a)), math.sqrt(sum(y * y for y in b))
    return dot / (na * nb) if na and nb else 0.0


def search_documents(chunks: list[dict], query: str, query_embedding: list[float] | None,
                     top_k: int = 4, doc_type: str | None = None) -> dict:
    """Hybrid search: 0.7 * vector cosine + 0.3 * keyword overlap. Keyword-only if no embedding."""
    q = set(_tokens(query))
    scored = []
    for c in chunks:
        if doc_type and c["doc_type"] != doc_type.lower():
            continue
        kw = len(q & set(_tokens(c["title"] + " " + c["section"] + " " + c["text"]))) / max(len(q), 1)
        vec = _cosine(query_embedding, c["embedding"]) if query_embedding and c.get("embedding") else None
        score = 0.7 * vec + 0.3 * kw if vec is not None else kw
        scored.append((score, c))
    scored.sort(key=lambda x: -x[0])
    top_k = max(1, min(int(top_k), 8))
    return {
        "retrieval": "hybrid (Titan v2 cosine + keyword)" if query_embedding else "keyword-only (embedding unavailable)",
        "results": [{"doc_id": c["doc_id"], "title": c["title"], "section": c["section"], "doc_type": c["doc_type"],
                     "score": round(s, 3), "text": c["text"]} for s, c in scored[:top_k] if s > 0],
    }


def _version_tuple(v: str) -> tuple[int, ...]:
    return tuple(int(x) for x in re.findall(r"\d+", str(v)))


def _evaluate(rule: dict, proto: dict) -> dict:
    observed = proto.get(rule["field"])
    applies = (not rule.get("phase") or proto["phase"] in rule["phase"]) and \
              (rule.get("when") != "amended" or proto["version"] != "1.0")
    if not applies:
        status = "NOT_APPLICABLE"
    elif rule["op"] == "lte":
        status = "PASS" if observed <= rule["value"] else "FAIL"
    elif rule["op"] == "eq":
        status = "PASS" if observed == rule["value"] else "FAIL"
    elif rule["op"] == "version_gte":
        status = "PASS" if _version_tuple(observed) >= _version_tuple(rule["value"]) else "FAIL"
    else:
        status = "UNKNOWN_RULE"
    return {"rule_id": rule["rule_id"], "sop": rule["sop"], "requirement": rule["text"], "field": rule["field"],
            "observed": observed, "status": status}


def _find(protocols: list[dict], protocol_id: str) -> dict | None:
    pid = protocol_id.upper()
    if not pid.startswith("PRT-"):
        pid = f"PRT-{pid}"  # accept a bare study id such as TS-003
    return next((p for p in protocols if p["protocol_id"] == pid), None)


def _version(p: dict, version: str | None) -> dict | None:
    if not version or version == "latest":
        return p["versions"][-1]
    return next((v for v in p["versions"] if v["version"] == str(version)), None)


def check_compliance(protocols: list[dict], rules: list[dict], protocol_id: str, version: str | None = "latest") -> dict:
    p = _find(protocols, protocol_id)
    if not p:
        return {"error": f"Unknown protocol {protocol_id!r}. Known: {[x['protocol_id'] for x in protocols]}"}
    v = _version(p, version)
    if not v:
        return {"error": f"Unknown version {version!r}. Known: {[x['version'] for x in p['versions']]}"}
    findings = [_evaluate(r, v) for r in rules]
    fails = [f for f in findings if f["status"] == "FAIL"]
    return {"protocol_id": p["protocol_id"], "study_id": p["study_id"], "version": v["version"], "phase": v["phase"],
            "overall": "NON_COMPLIANT" if fails else "COMPLIANT", "failed_rules": len(fails),
            "findings": findings,
            "note": "Deterministic rule check against SOP rules in rules.json; cite the SOP id when reporting."}


_LABELS = {"sample_size": "Planned sample size", "primary_endpoint": "Primary endpoint", "visit_window_days": "Visit window (+/- days)",
           "screening_period_days": "Screening period (days)", "sae_reporting_hours": "SAE reporting (hours)",
           "consent_version": "Consent form version", "data_entry_days": "eCRF data entry (days)",
           "query_resolution_business_days": "Query resolution (business days)", "dsmb": "Independent DSMB",
           "exclusions": "Exclusion criteria"}
_RISK_OR_BURDEN = {"visit_window_days", "screening_period_days", "exclusions", "sae_reporting_hours", "dsmb", "primary_endpoint"}


def summarize_amendment(protocols: list[dict], rules: list[dict], protocol_id: str,
                        from_version: str = "1.0", to_version: str = "2.0") -> dict:
    p = _find(protocols, protocol_id)
    if not p:
        return {"error": f"Unknown protocol {protocol_id!r}."}
    a, b = _version(p, from_version), _version(p, to_version)
    if not a or not b:
        return {"error": "Unknown version(s).", "known_versions": [x["version"] for x in p["versions"]]}
    changes = []
    for field, label in _LABELS.items():
        if a.get(field) != b.get(field):
            change = {"field": field, "label": label, "from": a.get(field), "to": b.get(field)}
            if field == "exclusions":
                change = {"field": field, "label": label,
                          "added": [x for x in b[field] if x not in a[field]],
                          "removed": [x for x in a[field] if x not in b[field]]}
            changes.append(change)
    size_delta = abs(b["sample_size"] - a["sample_size"]) / a["sample_size"]
    substantial_reasons = []
    if size_delta > 0.10:
        substantial_reasons.append(f"sample size changed by {round(100 * size_delta)}% (>10%)")
    if a["primary_endpoint"] != b["primary_endpoint"]:
        substantial_reasons.append("primary endpoint changed")
    if a["exclusions"] != b["exclusions"]:
        substantial_reasons.append("eligibility criteria changed")
    if a["sae_reporting_hours"] != b["sae_reporting_hours"] or a["dsmb"] != b["dsmb"]:
        substantial_reasons.append("safety monitoring changed")
    before = {f["rule_id"]: f["status"] for f in check_compliance(protocols, rules, p["protocol_id"], a["version"])["findings"]}
    after = {f["rule_id"]: f["status"] for f in check_compliance(protocols, rules, p["protocol_id"], b["version"])["findings"]}
    actions = []
    if substantial_reasons:
        actions.append("SOP-007 PA-1: obtain IRB/EC approval before implementation" + ("; notify the DSMB" if a["dsmb"] or b["dsmb"] else ""))
    if any(c["field"] in _RISK_OR_BURDEN for c in changes):
        actions.append("SOP-001 IC-2: re-consent active participants within 30 days of IRB approval")
    return {
        "protocol_id": p["protocol_id"], "from_version": a["version"], "to_version": b["version"],
        "effective": b["effective"], "changes": changes,
        "classification": "SUBSTANTIAL" if substantial_reasons else "NON_SUBSTANTIAL",
        "substantial_reasons": substantial_reasons,
        "newly_failing_rules": sorted(r for r, s in after.items() if s == "FAIL" and before.get(r) != "FAIL"),
        "resolved_rules": sorted(r for r, s in after.items() if s == "PASS" and before.get(r) == "FAIL"),
        "required_actions": actions,
    }
