"""Regenerate projectknowledge.md from the hand-written template + live AWS state, and publish it (plus a
source-code snapshot) to the TrialScout Insights knowledge bucket. Run after every deployment (make deploy does).

  .venv/bin/python scripts/publish_knowledge.py [--dry-run]

Safety: never reads secret values; drops stack outputs whose key contains "secret"; refuses to publish any
source file that matches a credential pattern.
"""
from __future__ import annotations

import collections
import datetime as dt
import json
import re
import sys
from pathlib import Path

import boto3

ROOT = Path(__file__).resolve().parent.parent
REGION = "us-east-1"
TEMPLATE = ROOT / "docs/knowledge/projectknowledge.template.md"
OUT = ROOT / "build/projectknowledge.md"
SOURCE_GLOBS = ["README.md", "Makefile", "requirements-dev.txt", "data/*.py", "services/**/*.py", "services/**/requirements.txt",
                "lambdas/**/*.py", "lambdas/**/*.mjs", "infra/bin/*.ts", "infra/lib/*.ts", "infra/package.json", "infra/cdk.json",
                "infra/tsconfig.json", "web/*", "insights-web/*", "scripts/*", "tests/*.py", "tests/ui/*.mjs", "tests/ui/package.json",
                "docs/knowledge/*.md", "data/generated/docs/*.md", "data/generated/rules.json"]
CREDENTIAL_PATTERNS = re.compile(
    r"(AKIA|ASIA)[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|aws_secret_access_key\s*=|"
    r"(password|client_secret)\s*[:=]\s*['\"][^'\"\s{}$]{8,}['\"]", re.I)

session = boto3.Session(region_name=REGION)
cfn, tagging, logs, bedrock, sts = (session.client(s) for s in
                                     ("cloudformation", "resourcegroupstaggingapi", "logs", "bedrock", "sts"))


def stacks() -> list[dict]:
    out = []
    for page in cfn.get_paginator("describe_stacks").paginate():
        out += [s for s in page["Stacks"] if s["StackName"].startswith("TrialScout")]
    order = ["CDKToolkit", "Foundation", "AgentCore", "Api", "Web", "Observability", "Insights"]
    return sorted(out, key=lambda s: next((i for i, k in enumerate(order) if s["StackName"].endswith(k)), 99))


def stack_resources(name: str) -> list[dict]:
    res = []
    for page in cfn.get_paginator("list_stack_resources").paginate(StackName=name):
        res += page["StackResourceSummaries"]
    return res


def live_inventory(all_stacks: list[dict]) -> str:
    by_type: collections.Counter = collections.Counter()
    lines = ["## 11. Live inventory *(live)*", "",
             f"Collected from CloudFormation and the Resource Groups Tagging API at {now()}. The Insights chatbot's "
             "`get_inventory` tool returns the current state at any time.", "",
             "| Stack | Status | Resources | Last updated | Description |", "|---|---|---|---|---|"]
    per_stack = {}
    for s in all_stacks:
        res = stack_resources(s["StackName"])
        per_stack[s["StackName"]] = res
        by_type.update(r["ResourceType"] for r in res)
        when = (s.get("LastUpdatedTime") or s["CreationTime"]).strftime("%Y-%m-%d %H:%M")
        lines.append(f"| `{s['StackName']}` | {s['StackStatus']} | {len(res)} | {when} | {s.get('Description', '')} |")
    total = sum(by_type.values())
    services = sorted({t.split("::")[1] for t in by_type if t.startswith("AWS::") and t != "AWS::CDK::Metadata"})
    tagged = sum(len(p["ResourceTagMappingList"]) for p in tagging.get_paginator("get_resources").paginate(
        TagFilters=[{"Key": "Project", "Values": ["TrialScout"]}]))
    lines += ["", f"**Totals:** {len(all_stacks)} stacks, **{total} CloudFormation resources**, **{len(by_type)} distinct "
              f"CloudFormation resource types** across **{len(services)} AWS services** (custom resources such as `Custom::*` are counted as types but not as services) ({', '.join(services)}). "
              f"The tagging API reports **{tagged} tagged resources** with `Project=TrialScout` (that count also includes "
              "resources created at runtime, and leaves out some CloudFormation helper types).", "",
              "### Resource types (count)", "", "| Resource type | Count |", "|---|---|"]
    lines += [f"| `{t}` | {n} |" for t, n in sorted(by_type.items(), key=lambda x: (-x[1], x[0]))]
    lines += ["", "### Resources per stack", ""]
    for name, res in per_stack.items():
        lines += [f"<details><summary><b>{name}</b> ({len(res)})</summary>", "", "| Logical id | Type |", "|---|---|"]
        lines += [f"| {r['LogicalResourceId']} | `{r['ResourceType']}` |" for r in sorted(res, key=lambda r: r["ResourceType"])]
        lines += ["", "</details>", ""]
    lines += ["### Stack outputs (non-secret)", "", "| Stack | Output | Value |", "|---|---|---|"]
    for s in all_stacks:
        for o in s.get("Outputs", []):
            if "secret" not in o["OutputKey"].lower():
                lines.append(f"| {s['StackName']} | {o['OutputKey']} | `{o['OutputValue']}` |")
    # Resources created by services at runtime (not in any template).
    runtime_groups = [g["logGroupName"] for p in ("/aws/bedrock-agentcore/runtimes/trialscout",)
                      for g in logs.describe_log_groups(logGroupNamePrefix=p)["logGroups"]]
    cfg = bedrock.get_model_invocation_logging_configuration().get("loggingConfig", {})
    lines += ["", "### Created outside CloudFormation (by services at runtime)", "",
              *[f"* Log group `{g}` (AgentCore Runtime stdout/stderr; deleted by `scripts/teardown.sh`)" for g in runtime_groups],
              "* Secret `bedrock-agentcore-identity!default/oauth2/trialscout-gateway-to-mcp` (AgentCore Identity token vault; "
              "holds the M2M client secret; swept by teardown)",
              "* Log group `aws/spans` (account-level CloudWatch Transaction Search destination; pre-existing account setting, kept)",
              f"* Bedrock model invocation logging: **{'enabled' if cfg else 'disabled'}**"
              + (f" → `{cfg.get('cloudWatchConfig', {}).get('logGroupName')}` (text={cfg.get('textDataDeliveryEnabled')}, "
                 f"embeddings={cfg.get('embeddingDataDeliveryEnabled')})" if cfg else ""), ""]
    return "\n".join(lines)


def data_catalog() -> str:
    gen = ROOT / "data/generated"
    studies = json.loads((gen / "studies.json").read_text())
    sites = json.loads((gen / "sites.json").read_text())
    protocols = json.loads((gen / "protocols.json").read_text())
    rules = json.loads((gen / "rules.json").read_text())
    lines = ["### Data catalog (generated from `data/generated/`)", "",
             f"**{len(studies)} studies**: " + ", ".join(f"{k} {v}" for k, v in
                                                       collections.Counter(s["therapeutic_area"] for s in studies).items())
             + "; status " + ", ".join(f"{k} {v}" for k, v in collections.Counter(s["status"] for s in studies).items()) + ".", "",
             "| Study | Area | Indication | Phase | Status | Enrolled / target | Sites |", "|---|---|---|---|---|---|---|"]
    site_count = collections.Counter(s["study_id"] for s in sites)
    for s in studies:
        lines.append(f"| {s['study_id']} | {s['therapeutic_area']} | {s['indication']} | {s['phase']} | {s['status']} | "
                     f"{s['enrolled']} / {s['target_enrollment']} | {site_count.get(s['study_id'], 0)} |")
    lines += ["", f"**{len(sites)} sites** by region: " + ", ".join(
        f"{k} {v}" for k, v in collections.Counter(s["region"] for s in sites).items()) + "; status " + ", ".join(
        f"{k} {v}" for k, v in collections.Counter(s["status"] for s in sites).items())
        + ". Site fields: " + ", ".join(f"`{k}`" for k in sites[0]) + ".", ""]
    docs = sorted((gen / "docs").glob("*.md"))
    lines += ["**Documents** (S3 `docs/`, chunked and embedded into `index/index.json`):", ""]
    for d in docs:
        title = next((l.lstrip("# ").strip() for l in d.read_text().splitlines() if l.startswith("# ")), d.stem)
        lines.append(f"* `{d.name}`: {title}")
    lines += ["", f"**Protocols with amendments:** " + ", ".join(f"{p['protocol_id']} ({p['study_id']})" for p in protocols) + ".",
              "", "**Compliance rules** (`rules.json`, used by `check_compliance`):", "",
              "| Rule | SOP | Field | Check | Applies | Text |", "|---|---|---|---|---|---|"]
    lines += [f"| {r['rule_id']} | {r['sop']} | `{r['field']}` | {r['op']} {r['value']} | {r.get('when') or 'always'} | {r['text']} |"
              for r in rules]
    return "\n".join(lines)


def source_files() -> list[Path]:
    seen: dict[str, Path] = {}
    for g in SOURCE_GLOBS:
        for p in ROOT.glob(g):
            if p.is_file() and "__pycache__" not in p.parts and "node_modules" not in p.parts:
                seen[str(p.relative_to(ROOT))] = p
    return [seen[k] for k in sorted(seen)]


def source_index(files: list[Path]) -> str:
    lines = ["## 12. Source files *(live snapshot)*", "",
             "The full source is published to the knowledge bucket under `source/`. Students can browse it in the Insights **Source** "
             "tab, and the chatbot can read any file with `read_source_file`.", "", "| Path | Bytes |", "|---|---|"]
    lines += [f"| `{p.relative_to(ROOT)}` | {p.stat().st_size} |" for p in files]
    return "\n".join(lines)


def now() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d %H:%M UTC")


def main() -> None:
    dry = "--dry-run" in sys.argv
    all_stacks = stacks()
    outputs = {o["OutputKey"]: o["OutputValue"] for s in all_stacks for o in s.get("Outputs", [])}
    bucket = outputs.get("KnowledgeBucketName")
    if not bucket and not dry:
        sys.exit("TrialScout-Insights is not deployed (no KnowledgeBucketName output).")
    files = source_files()
    for p in files:
        if CREDENTIAL_PATTERNS.search(p.read_text(errors="ignore")):
            sys.exit(f"Refusing to publish: credential-like content in {p.relative_to(ROOT)}")

    md = TEMPLATE.read_text()
    for key, val in {
        "GENERATED_AT": now(), "ACCOUNT": sts.get_caller_identity()["Account"], "KNOWLEDGE_BUCKET": bucket or "<bucket>",
        "DATA_CATALOG": data_catalog(), "LIVE_INVENTORY": live_inventory(all_stacks), "SOURCE_INDEX": source_index(files),
        "CHANGELOG": (ROOT / "docs/knowledge/changelog.md").read_text().strip(),
        "README": re.sub(r"^(#+)", r"#\1", (ROOT / "README.md").read_text().strip(), flags=re.M),  # demote headings
    }.items():
        md = md.replace("{{" + key + "}}", val)
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(md)
    print(f"wrote {OUT.relative_to(ROOT)} ({len(md):,} chars, ~{len(md) // 4:,} tokens)")
    if dry:
        return

    s3 = session.client("s3")
    manifest = {"generated": now(), "files": []}
    for p in files:
        rel = str(p.relative_to(ROOT))
        s3.put_object(Bucket=bucket, Key=f"source/{rel}", Body=p.read_bytes(), ContentType="text/plain; charset=utf-8")
        manifest["files"].append({"path": rel, "bytes": p.stat().st_size})
    keep = {f"source/{f['path']}" for f in manifest["files"]} | {"source/manifest.json"}
    for page in s3.get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix="source/"):
        for obj in page.get("Contents", []):
            if obj["Key"] not in keep:
                s3.delete_object(Bucket=bucket, Key=obj["Key"])
    s3.put_object(Bucket=bucket, Key="source/manifest.json", Body=json.dumps(manifest).encode(), ContentType="application/json")
    r = s3.put_object(Bucket=bucket, Key="projectknowledge.md", Body=md.encode(), ContentType="text/markdown; charset=utf-8")
    print(f"published s3://{bucket}/projectknowledge.md (version {r.get('VersionId')}) + {len(files)} source files")


if __name__ == "__main__":
    main()
