"""Offline unit tests for the MCP domain logic (no AWS calls)."""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GEN = ROOT / "data" / "generated"
sys.path[:0] = [str(ROOT / "services" / "mcp_study"), str(ROOT / "services" / "mcp_policy")]

import policy  # noqa: E402
import portfolio  # noqa: E402

studies = json.loads((GEN / "studies.json").read_text())
sites = json.loads((GEN / "sites.json").read_text())
protocols = json.loads((GEN / "protocols.json").read_text())
rules = json.loads((GEN / "rules.json").read_text())
index = json.loads((GEN / "index.json").read_text())


def test_dataset_sizes():
    assert len(studies) == 25 and len(sites) == 60 and len(protocols) == 5
    assert len({c["doc_id"] for c in index}) == 13


def test_search_studies_filters():
    r = portfolio.search_studies(studies, therapeutic_area="oncology", phase="3")
    assert r["total_matches"] > 0
    assert all(s["phase"] == "Phase 3" and s["therapeutic_area"] == "Oncology" for s in r["studies"])


def test_site_performance_flags_sorted_worst_first():
    r = portfolio.get_site_performance(sites, only_flagged=True, limit=60)
    assert r["sites_flagged"] == len(r["sites"]) > 0
    scores = [s["performance_score"] for s in r["sites"]]
    assert scores == sorted(scores)


def test_forecast_recruiting_study():
    s = next(x for x in studies if x["status"] == "Recruiting" and x["enrolled"] < x["target_enrollment"])
    f = portfolio.forecast_enrollment(s)
    p = f["projected_completion"]
    assert p["optimistic_p10"] <= p["expected_p50"] <= p["conservative_p90"]


def test_forecast_planning_study_has_no_projection():
    s = next(x for x in studies if x["status"] == "Planning")
    assert portfolio.forecast_enrollment(s)["projected_completion"] is None


def test_compliance_detects_seeded_violations():
    r = policy.check_compliance(protocols, rules, "TS-003", "latest")
    assert r["overall"] == "NON_COMPLIANT"
    assert {f["rule_id"] for f in r["findings"] if f["status"] == "FAIL"} == {"ES-1"}
    r1 = policy.check_compliance(protocols, rules, "PRT-TS-003", "1.0")
    assert {f["rule_id"] for f in r1["findings"] if f["status"] == "FAIL"} == {"SR-1"}


def test_amendment_summary():
    r = policy.summarize_amendment(protocols, rules, "PRT-TS-001")
    assert r["classification"] == "SUBSTANTIAL"
    assert "VW-2" in r["newly_failing_rules"]
    assert any("IRB" in a for a in r["required_actions"])


def test_keyword_search_finds_sae_policy():
    r = policy.search_documents(index, "serious adverse event reporting hours", None, top_k=3)
    assert r["results"][0]["doc_id"] in {"SOP-002"} | {p["protocol_id"] for p in protocols}
    assert any(x["doc_id"] == "SOP-002" for x in r["results"])


def test_unknown_ids_return_errors_not_exceptions():
    assert "error" in policy.check_compliance(protocols, rules, "PRT-NOPE")
    assert "error" in policy.summarize_amendment(protocols, rules, "PRT-NOPE")
