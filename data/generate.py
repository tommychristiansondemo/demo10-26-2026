"""Deterministic SYNTHETIC data generator for TrialScout.

Everything produced here is fictional: sponsor, programs, sites, cities-as-labels,
SOPs and protocols. There is no patient-level data at all -- only aggregate,
made-up site metrics. Re-running produces byte-identical output (fixed seed).

Outputs (data/generated/):
  studies.json    25 studies with 12-month enrollment history
  sites.json      60 sites, each attached to one study
  docs/*.md       8 SOP/policy documents + 5 protocol excerpts (v1 and amendment v2)
  protocols.json  structured protocol fields (both versions) used by check_compliance
  rules.json      machine-readable policy rules extracted from the SOPs
"""
from __future__ import annotations

import json
import random
from datetime import date
from pathlib import Path

OUT = Path(__file__).parent / "generated"
DOCS = OUT / "docs"
rng = random.Random(20261026)

SPONSOR = "Synthetica Bio (fictional sponsor)"
AREAS = {
    "Oncology": ["Non-small cell lung cancer", "Metastatic breast cancer", "Colorectal cancer"],
    "Cardiology": ["Heart failure with reduced ejection fraction", "Resistant hypertension"],
    "Neurology": ["Early Alzheimer's disease", "Relapsing multiple sclerosis", "Migraine prevention"],
    "Immunology": ["Moderate-to-severe plaque psoriasis", "Ulcerative colitis", "Rheumatoid arthritis"],
    "Metabolic": ["Type 2 diabetes", "Obesity", "NASH"],
    "Infectious Disease": ["RSV in older adults", "Recurrent C. difficile infection"],
}
PHASES = ["Phase 1", "Phase 2", "Phase 3"]
STATUSES = ["Recruiting"] * 12 + ["Active, not recruiting"] * 5 + ["On Hold"] * 2 + ["Planning"] * 3 + ["Completed"] * 3
CROS = ["Meridian CRO (fictional)", "Halcyon Research Partners (fictional)", "In-house"]
# Fictional site labels built from generic words -- not real institutions.
SITE_WORDS_A = ["Lakeview", "Riverside", "Summit", "Harbor", "Cedar", "Northgate", "Bayside", "Pinecrest",
                "Westfield", "Granite", "Maple", "Silverline", "Oakridge", "Bluewater", "Stonebridge"]
SITE_WORDS_B = ["Research Center", "Clinical Research Unit", "Medical Research Institute", "Trial Clinic",
                "Health Research Group"]
REGIONS = [("North America", "US"), ("North America", "CA"), ("Europe", "DE"), ("Europe", "ES"),
           ("Europe", "PL"), ("Asia Pacific", "JP"), ("Asia Pacific", "AU"), ("Latin America", "BR")]
TODAY = date(2026, 10, 1)


def month_add(d: date, months: int) -> date:
    y, m = divmod(d.month - 1 + months, 12)
    return date(d.year + y, m + 1, 1)


def make_studies() -> list[dict]:
    studies = []
    area_names = list(AREAS)
    statuses = STATUSES[:]
    rng.shuffle(statuses)
    for i in range(1, 26):
        area = area_names[(i - 1) % len(area_names)]
        indication = rng.choice(AREAS[area])
        phase = PHASES[0] if i % 7 == 0 else (PHASES[1] if i % 3 == 0 else PHASES[2])
        status = statuses[i - 1]
        target = {"Phase 1": rng.randint(30, 80), "Phase 2": rng.randint(120, 300), "Phase 3": rng.randint(400, 1200)}[phase]
        start = month_add(TODAY, -rng.randint(8, 30))
        planned_months = {"Phase 1": 14, "Phase 2": 24, "Phase 3": 36}[phase]
        base_rate = target / (planned_months * rng.uniform(0.7, 1.4))
        history = []
        enrolled = 0
        for m in range(12, 0, -1):
            mstart = month_add(TODAY, -m)
            if mstart < start or status == "Planning":
                n = 0
            elif status in ("Completed", "Active, not recruiting"):
                n = 0 if m < 4 else max(0, round(rng.gauss(base_rate, base_rate * 0.25)))
            elif status == "On Hold":
                n = 0 if m < 3 else max(0, round(rng.gauss(base_rate * 0.6, base_rate * 0.3)))
            else:
                trend = 1 + (12 - m) * rng.uniform(-0.02, 0.05)
                n = max(0, round(rng.gauss(base_rate * trend, base_rate * 0.2)))
            history.append({"month": mstart.isoformat()[:7], "enrolled": n})
            enrolled += n
        prior = 0 if status == "Planning" else round(base_rate * max(0, (TODAY.year - start.year) * 12 + TODAY.month - start.month - 12))
        enrolled_total = min(target, enrolled + prior) if status != "Completed" else target
        studies.append({
            "study_id": f"TS-{i:03d}",
            "title": f"A {phase} study of TSX-{100 + i} in {indication}",
            "program": f"TSX-{100 + i}",
            "sponsor": SPONSOR,
            "therapeutic_area": area,
            "indication": indication,
            "phase": phase,
            "status": status,
            "cro": rng.choice(CROS),
            "target_enrollment": target,
            "enrolled": enrolled_total,
            "start_date": start.isoformat(),
            "planned_enrollment_end": month_add(start, planned_months).isoformat(),
            "monthly_enrollment": history,
            "regions": sorted({r for r, _ in rng.sample(REGIONS, rng.randint(1, 4))}),
            "protocol_id": None,
        })
    return studies


def make_sites(studies: list[dict]) -> list[dict]:
    sites = []
    # every non-planning study gets >=1 site; remaining spread at random -> exactly 60
    eligible = [s for s in studies if s["status"] != "Planning"]
    assignment = [s["study_id"] for s in eligible]
    while len(assignment) < 60:
        assignment.append(rng.choice(eligible)["study_id"])
    rng.shuffle(assignment)
    by_id = {s["study_id"]: s for s in studies}
    for i, sid in enumerate(assignment, start=1):
        study = by_id[sid]
        region, country = rng.choice(REGIONS)
        months_active = rng.randint(2, 18)
        screened = rng.randint(4, 90)
        sf_rate = rng.uniform(0.12, 0.62)
        failures = round(screened * sf_rate)
        enrolled = screened - failures
        sites.append({
            "site_id": f"S-{i:03d}",
            "study_id": sid,
            "name": f"{rng.choice(SITE_WORDS_A)} {rng.choice(SITE_WORDS_B)} #{i:02d} (fictional)",
            "region": region,
            "country": country,
            "status": "Active" if study["status"] in ("Recruiting", "Active, not recruiting") else
                      ("Closed" if study["status"] == "Completed" else "Paused"),
            "months_active": months_active,
            "screened": screened,
            "screen_failures": failures,
            "enrolled": enrolled,
            "protocol_deviations": rng.randint(0, max(1, enrolled // 4)),
            "open_queries": rng.randint(0, 60),
            "avg_query_age_days": round(rng.uniform(2, 24), 1),
            "sae_reports_late": rng.choice([0] * 8 + [1, 2]),
            "data_entry_lag_days": round(rng.uniform(1, 9), 1),
        })
    return sites


SOPS = [
    ("SOP-001", "Informed Consent", [
        ("Purpose", "Defines how informed consent is obtained, documented and refreshed for all interventional studies."),
        ("Consent Version Control", "Only the IRB/EC-approved consent version listed in the protocol may be used. "
         "Rule IC-1: the protocol must reference an approved consent form version of 2.0 or higher for any amended protocol."),
        ("Re-consent", "Rule IC-2: when an amendment changes risks, procedures or visit burden, active participants must be "
         "re-consented within 30 days of IRB approval of the amendment."),
    ]),
    ("SOP-002", "Safety Reporting", [
        ("Purpose", "Sets timelines for reporting adverse events to the sponsor safety desk."),
        ("Serious Adverse Events", "Rule SR-1: investigators must report every serious adverse event (SAE) to the sponsor within "
         "24 hours of awareness. Protocols must not specify a longer window."),
        ("SUSARs", "Fatal or life-threatening SUSARs are expedited to regulators within 7 calendar days; all other SUSARs within 15."),
    ]),
    ("SOP-003", "Visit Windows and Scheduling", [
        ("Purpose", "Limits how far a protocol visit may drift from its nominal day."),
        ("Window Limits", "Rule VW-1: Phase 1 protocols may allow at most +/-3 days. Rule VW-2: Phase 2 and Phase 3 protocols "
         "may allow at most +/-7 days for treatment-period visits."),
        ("Out-of-window Visits", "An out-of-window visit is a protocol deviation and must be logged within 5 business days."),
    ]),
    ("SOP-004", "Eligibility and Screening", [
        ("Purpose", "Controls the screening period and escalation of high screen-failure rates."),
        ("Screening Period", "Rule ES-1: the screening period must not exceed 28 days from consent to randomization."),
        ("Screen Failure Escalation", "Rule ES-2: a site whose screen-failure rate exceeds 40% after 10 or more screened "
         "participants triggers an eligibility-criteria review with the medical monitor."),
    ]),
    ("SOP-005", "Clinical Data Management", [
        ("Purpose", "Sets timeliness expectations for electronic case report form (eCRF) data."),
        ("Data Entry", "Rule DM-1: visit data must be entered in the eCRF within 5 days of the visit."),
        ("Query Resolution", "Rule DM-2: data queries must be resolved within 10 business days; protocols may not relax this."),
    ]),
    ("SOP-006", "Site Selection and Performance Management", [
        ("Purpose", "Defines objective site performance thresholds and remediation."),
        ("Enrollment Performance", "Rule SP-1: a site enrolling fewer than 0.5 participants per month after its first 3 active "
         "months enters a remediation plan."),
        ("Quality Thresholds", "Rule SP-2: more than 5 protocol deviations per 10 enrolled participants, or average query age "
         "above 15 days, triggers a for-cause monitoring visit."),
    ]),
    ("SOP-007", "Protocol Amendments", [
        ("Purpose", "Governs how protocol amendments are classified, approved and implemented."),
        ("Substantial Amendments", "Rule PA-1: substantial amendments (changes to endpoints, sample size >10%, eligibility or "
         "safety monitoring) require IRB/EC approval before implementation and notification of the DSMB if one exists."),
        ("Phase 3 Oversight", "Rule PA-2: every Phase 3 protocol must name an independent Data Safety Monitoring Board (DSMB)."),
    ]),
    ("SOP-008", "Data Privacy and AI Tool Use", [
        ("Purpose", "Protects participant privacy when using analytics and AI assistants."),
        ("Identifiers", "Participant names, contact details, medical record numbers and dates of birth must never be entered "
         "into AI assistants. Use coded participant IDs only."),
        ("AI Assistant Use", "AI assistants may summarize aggregate operational data and policies. They must not provide "
         "medical advice, dosing recommendations for individual patients, or unblind treatment assignments."),
    ]),
]

PROTOCOL_STUDIES = ["TS-001", "TS-003", "TS-007", "TS-010", "TS-012"]


def make_protocols(studies: list[dict]) -> list[dict]:
    by_id = {s["study_id"]: s for s in studies}
    protos = []
    # (v1 overrides, v2 overrides) -- some amendments introduce deliberate policy violations for the demo
    variants = [
        ({}, {"visit_window_days": 10, "sample_size_delta_pct": 15}),
        ({"sae_reporting_hours": 48}, {"sae_reporting_hours": 24, "screening_period_days": 35}),
        ({}, {"consent_version": "1.0", "visit_window_days": 2}),
        ({"query_resolution_business_days": 15}, {"query_resolution_business_days": 10, "dsmb": False}),
        ({}, {"data_entry_days": 7, "new_exclusion": "Prior exposure to any GLP-1 receptor agonist within 90 days"}),
    ]
    for n, (sid, (v1o, v2o)) in enumerate(zip(PROTOCOL_STUDIES, variants), start=1):
        s = by_id[sid]
        pid = f"PRT-{sid}"
        s["protocol_id"] = pid
        base = {
            "protocol_id": pid, "study_id": sid, "title": s["title"], "phase": s["phase"],
            "visit_window_days": 3 if s["phase"] == "Phase 1" else 7,
            "screening_period_days": 28, "sae_reporting_hours": 24, "consent_version": "1.0",
            "data_entry_days": 5, "query_resolution_business_days": 10,
            "dsmb": s["phase"] == "Phase 3", "sample_size": s["target_enrollment"],
            "primary_endpoint": f"Change from baseline in the primary efficacy measure for {s['indication']} at week 24",
            "exclusions": ["Participation in another interventional study within 30 days",
                           "Clinically significant laboratory abnormality at screening"],
        }
        v1 = {**base, **{k: v for k, v in v1o.items()}, "version": "1.0", "effective": "2025-11-01"}
        v2 = {**v1, "version": "2.0", "effective": "2026-07-15", "consent_version": "2.0"}
        for k, v in v2o.items():
            if k == "sample_size_delta_pct":
                v2["sample_size"] = round(v1["sample_size"] * (1 + v / 100))
            elif k == "new_exclusion":
                v2["exclusions"] = v1["exclusions"] + [v]
            else:
                v2[k] = v
        protos.append({"protocol_id": pid, "study_id": sid, "versions": [v1, v2]})
    return protos


RULES = [
    {"rule_id": "IC-1", "sop": "SOP-001", "field": "consent_version", "op": "version_gte", "value": "2.0", "when": "amended",
     "text": "Amended protocols must reference consent version 2.0 or higher."},
    {"rule_id": "SR-1", "sop": "SOP-002", "field": "sae_reporting_hours", "op": "lte", "value": 24,
     "text": "SAEs must be reported within 24 hours."},
    {"rule_id": "VW-1", "sop": "SOP-003", "field": "visit_window_days", "op": "lte", "value": 3, "phase": ["Phase 1"],
     "text": "Phase 1 visit windows may not exceed +/-3 days."},
    {"rule_id": "VW-2", "sop": "SOP-003", "field": "visit_window_days", "op": "lte", "value": 7, "phase": ["Phase 2", "Phase 3"],
     "text": "Phase 2/3 visit windows may not exceed +/-7 days."},
    {"rule_id": "ES-1", "sop": "SOP-004", "field": "screening_period_days", "op": "lte", "value": 28,
     "text": "Screening period may not exceed 28 days."},
    {"rule_id": "DM-1", "sop": "SOP-005", "field": "data_entry_days", "op": "lte", "value": 5,
     "text": "eCRF data entry within 5 days of the visit."},
    {"rule_id": "DM-2", "sop": "SOP-005", "field": "query_resolution_business_days", "op": "lte", "value": 10,
     "text": "Queries resolved within 10 business days."},
    {"rule_id": "PA-2", "sop": "SOP-007", "field": "dsmb", "op": "eq", "value": True, "phase": ["Phase 3"],
     "text": "Phase 3 protocols must name an independent DSMB."},
]


def protocol_markdown(p: dict) -> str:
    v1, v2 = p["versions"]
    lines = [f"# Protocol {p['protocol_id']} -- {v1['title']}", "",
             "SYNTHETIC protocol excerpt generated for the TrialScout teaching demo. Not a real protocol.", ""]
    for v in (v1, v2):
        label = "Original protocol" if v["version"] == "1.0" else "Amendment 1"
        lines += [f"## Version {v['version']} ({label}, effective {v['effective']})", "",
                  f"- Phase: {v['phase']}",
                  f"- Planned sample size: {v['sample_size']} participants",
                  f"- Primary endpoint: {v['primary_endpoint']}",
                  f"- Visit window: +/-{v['visit_window_days']} days",
                  f"- Screening period: {v['screening_period_days']} days",
                  f"- SAE reporting to sponsor: within {v['sae_reporting_hours']} hours",
                  f"- Informed consent form version: {v['consent_version']}",
                  f"- eCRF data entry: within {v['data_entry_days']} days of visit",
                  f"- Query resolution: within {v['query_resolution_business_days']} business days",
                  f"- Independent DSMB: {'Yes' if v['dsmb'] else 'No'}",
                  "- Key exclusions: " + "; ".join(v["exclusions"]), ""]
    return "\n".join(lines)


def main() -> None:
    DOCS.mkdir(parents=True, exist_ok=True)
    studies = make_studies()
    protocols = make_protocols(studies)
    sites = make_sites(studies)
    for sop_id, title, sections in SOPS:
        body = [f"# {sop_id} {title}", "", "SYNTHETIC policy document for the TrialScout teaching demo.", ""]
        for h, t in sections:
            body += [f"## {h}", "", t, ""]
        (DOCS / f"{sop_id}.md").write_text("\n".join(body))
    for p in protocols:
        (DOCS / f"{p['protocol_id']}.md").write_text(protocol_markdown(p))
    (OUT / "studies.json").write_text(json.dumps(studies, indent=1))
    (OUT / "sites.json").write_text(json.dumps(sites, indent=1))
    (OUT / "protocols.json").write_text(json.dumps(protocols, indent=1))
    (OUT / "rules.json").write_text(json.dumps(RULES, indent=1))
    print(f"studies={len(studies)} sites={len(sites)} sops={len(SOPS)} protocols={len(protocols)}")


if __name__ == "__main__":
    main()
