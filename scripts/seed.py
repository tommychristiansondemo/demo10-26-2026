"""Load SYNTHETIC data into DynamoDB and the KMS-encrypted docs bucket (idempotent).

Reads table/bucket names from the TrialScout-Foundation stack outputs. Embeds every doc chunk with
Titan Text Embeddings v2 and uploads index/{index,rules,protocols}.json for the Policy MCP server.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import boto3

ROOT = Path(__file__).resolve().parents[1]
GEN = ROOT / "data" / "generated"
REGION = "us-east-1"


def outputs(stack: str) -> dict:
    cf = boto3.client("cloudformation", region_name=REGION)
    return {o["OutputKey"]: o["OutputValue"] for o in cf.describe_stacks(StackName=stack)["Stacks"][0].get("Outputs", [])}


def main() -> None:
    subprocess.run([sys.executable, str(ROOT / "data" / "generate.py")], check=True)
    subprocess.run([sys.executable, str(ROOT / "data" / "build_index.py"), "--embed", "--region", REGION], check=True)
    out = outputs("TrialScout-Foundation")
    ddb = boto3.resource("dynamodb", region_name=REGION)
    for kind, table, key in (("studies", out["StudiesTable"], "study_id"), ("sites", out["SitesTable"], "site_id")):
        rows = json.loads((GEN / f"{kind}.json").read_text())
        with ddb.Table(table).batch_writer(overwrite_by_pkeys=[key]) as bw:
            for r in rows:
                bw.put_item(Item={key: r[key], "doc": json.dumps(r)})
        print(f"{table}: {len(rows)} items")
    s3 = boto3.client("s3", region_name=REGION)
    bucket = out["DocsBucketName"]
    for name in ("index", "rules", "protocols"):
        s3.put_object(Bucket=bucket, Key=f"index/{name}.json", Body=(GEN / f"{name}.json").read_bytes(),
                      ContentType="application/json")
    for doc in sorted((GEN / "docs").glob("*.md")):
        s3.put_object(Bucket=bucket, Key=f"docs/{doc.name}", Body=doc.read_bytes(), ContentType="text/markdown")
    print(f"s3://{bucket}: index + {len(list((GEN / 'docs').glob('*.md')))} docs uploaded")


if __name__ == "__main__":
    main()
