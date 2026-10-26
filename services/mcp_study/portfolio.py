"""Study Portfolio domain logic (pure functions over study/site records).

Kept separate from the MCP transport so it can be unit-tested without AWS.
"""
from __future__ import annotations

import math
import statistics
from datetime import date

PHASES = {"1": "Phase 1", "2": "Phase 2", "3": "Phase 3"}


def _norm_phase(phase: str | None) -> str | None:
    if not phase:
        return None
    p = phase.strip().lower().replace("phase", "").strip()
    return PHASES.get(p, phase)


def search_studies(studies: list[dict], query: str = "", therapeutic_area: str | None = None,
                   phase: str | None = None, status: str | None = None, limit: int = 10) -> dict:
    phase = _norm_phase(phase)
    terms = [t for t in query.lower().split() if t]
    hits = []
    for s in studies:
        if therapeutic_area and therapeutic_area.lower() not in s["therapeutic_area"].lower():
            continue
        if phase and s["phase"] != phase:
            continue
        if status and status.lower() not in s["status"].lower():
            continue
        hay = " ".join([s["study_id"], s["title"], s["program"], s["indication"], s["therapeutic_area"],
                        s["status"], s["cro"]]).lower()
        score = sum(hay.count(t) for t in terms) if terms else 1
        if terms and score == 0:
            continue
        hits.append((score, s))
    hits.sort(key=lambda x: (-x[0], x[1]["study_id"]))
    limit = max(1, min(int(limit), 25))
    return {
        "total_matches": len(hits),
        "studies": [{k: s[k] for k in ("study_id", "title", "therapeutic_area", "indication", "phase", "status", "cro",
                                       "enrolled", "target_enrollment", "planned_enrollment_end", "protocol_id")}
                    | {"pct_enrolled": round(100 * s["enrolled"] / s["target_enrollment"], 1)}
                    for _, s in hits[:limit]],
    }


def _site_metrics(site: dict) -> dict:
    screened = site["screened"] or 1
    months = max(site["months_active"], 1)
    rate = site["enrolled"] / months
    sf = site["screen_failures"] / screened
    dev_per_10 = 10 * site["protocol_deviations"] / max(site["enrolled"], 1)
    flags = []
    if site["months_active"] > 3 and rate < 0.5:
        flags.append("SOP-006 SP-1: enrollment below 0.5/month -> remediation plan")
    if site["screened"] >= 10 and sf > 0.40:
        flags.append("SOP-004 ES-2: screen-failure rate above 40% -> eligibility review")
    if dev_per_10 > 5 or site["avg_query_age_days"] > 15:
        flags.append("SOP-006 SP-2: quality threshold breached -> for-cause monitoring visit")
    if site["data_entry_lag_days"] > 5:
        flags.append("SOP-005 DM-1: data entry lag above 5 days")
    if site["sae_reports_late"]:
        flags.append("SOP-002 SR-1: late SAE report(s) recorded")
    score = 100 - 25 * len(flags) + min(20, rate * 4)
    return {
        **{k: site[k] for k in ("site_id", "study_id", "name", "region", "country", "status", "months_active",
                                "screened", "screen_failures", "enrolled", "protocol_deviations", "open_queries",
                                "avg_query_age_days", "data_entry_lag_days", "sae_reports_late")},
        "enrollment_rate_per_month": round(rate, 2),
        "screen_failure_rate_pct": round(100 * sf, 1),
        "deviations_per_10_enrolled": round(dev_per_10, 2),
        "performance_score": round(max(0, min(100, score)), 1),
        "policy_flags": flags,
    }


def get_site_performance(sites: list[dict], study_id: str | None = None, site_id: str | None = None,
                         only_flagged: bool = False, limit: int = 20) -> dict:
    rows = [s for s in sites if (not study_id or s["study_id"] == study_id.upper())
            and (not site_id or s["site_id"] == site_id.upper())]
    metrics = [_site_metrics(s) for s in rows]
    if only_flagged:
        metrics = [m for m in metrics if m["policy_flags"]]
    metrics.sort(key=lambda m: m["performance_score"])
    limit = max(1, min(int(limit), 60))
    return {
        "sites_evaluated": len(rows),
        "sites_flagged": sum(1 for m in metrics if m["policy_flags"]),
        "sites": metrics[:limit],
        "note": "Sorted worst-first by performance_score. Thresholds come from SOP-002/004/005/006.",
    }


def _month_add(ym: str, n: int) -> str:
    y, m = int(ym[:4]), int(ym[5:7])
    y, m = divmod((y * 12 + m - 1) + n, 12)
    return f"{y:04d}-{m + 1:02d}"


def forecast_enrollment(study: dict, window_months: int = 6, today: date | None = None) -> dict:
    hist = [h["enrolled"] for h in study["monthly_enrollment"]]
    remaining = study["target_enrollment"] - study["enrolled"]
    base = {"study_id": study["study_id"], "status": study["status"], "enrolled": study["enrolled"],
            "target_enrollment": study["target_enrollment"], "remaining": max(0, remaining),
            "planned_enrollment_end": study["planned_enrollment_end"][:7], "method": ""}
    if remaining <= 0:
        return base | {"method": "complete", "projected_completion": "already at target", "on_track": True}
    window_months = max(3, min(int(window_months), 12))
    recent = hist[-window_months:]
    mean = statistics.fmean(recent) if recent else 0.0
    if mean <= 0:
        return base | {"method": f"mean of last {window_months} months", "recent_monthly_rate": 0,
                       "projected_completion": None, "on_track": False,
                       "comment": "No enrollment in the window; cannot project completion (study may be paused or not started)."}
    sd = statistics.pstdev(recent) if len(recent) > 1 else 0.0
    # Simple +/-1.28 sigma band on the monthly rate ~ P10/P90 for teaching purposes.
    lo_rate, hi_rate = max(mean - 1.28 * sd, mean * 0.25), mean + 1.28 * sd
    last = study["monthly_enrollment"][-1]["month"]
    p50 = _month_add(last, math.ceil(remaining / mean))
    p90 = _month_add(last, math.ceil(remaining / lo_rate))
    p10 = _month_add(last, math.ceil(remaining / hi_rate))
    return base | {
        "method": f"mean monthly rate over last {window_months} months with +/-1.28 sd band",
        "recent_monthly_rate": round(mean, 1),
        "required_monthly_rate_for_plan": _required_rate(study, last, remaining),
        "projected_completion": {"optimistic_p10": p10, "expected_p50": p50, "conservative_p90": p90},
        "on_track": p50 <= study["planned_enrollment_end"][:7],
        "monthly_history": study["monthly_enrollment"][-window_months:],
    }


def _required_rate(study: dict, last: str, remaining: int) -> float | None:
    end = study["planned_enrollment_end"][:7]
    months = (int(end[:4]) * 12 + int(end[5:7])) - (int(last[:4]) * 12 + int(last[5:7]))
    return round(remaining / months, 1) if months > 0 else None
