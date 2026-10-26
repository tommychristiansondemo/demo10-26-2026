"""Chunk the synthetic docs by section and (optionally) embed them with Titan Text Embeddings v2.

    python data/build_index.py            # keyword-only index (offline, used by unit tests)
    python data/build_index.py --embed    # adds 512-dim normalized vectors via Bedrock

Writes data/generated/index.json.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

GEN = Path(__file__).parent / "generated"


def chunk_docs() -> list[dict]:
    chunks = []
    for path in sorted((GEN / "docs").glob("*.md")):
        lines = path.read_text().splitlines()
        title = lines[0].lstrip("# ").strip()
        doc_type = "protocol" if path.stem.startswith("PRT-") else "sop"
        section, buf = None, []

        def flush():
            if section and any(x.strip() for x in buf):
                chunks.append({"chunk_id": f"{path.stem}#{len(chunks)}", "doc_id": path.stem, "title": title,
                               "doc_type": doc_type, "section": section, "text": "\n".join(buf).strip()})

        for line in lines[1:]:
            if line.startswith("## "):
                flush()
                section, buf = line[3:].strip(), []
            else:
                buf.append(line)
        flush()
    return chunks


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--embed", action="store_true")
    ap.add_argument("--region", default="us-east-1")
    args = ap.parse_args()
    chunks = chunk_docs()
    if args.embed:
        import boto3
        from botocore.config import Config

        br = boto3.client("bedrock-runtime", region_name=args.region,
                          config=Config(retries={"max_attempts": 6, "mode": "adaptive"}))
        for c in chunks:
            body = json.dumps({"inputText": f"{c['title']} - {c['section']}\n{c['text']}", "dimensions": 512, "normalize": True})
            c["embedding"] = json.loads(br.invoke_model(modelId="amazon.titan-embed-text-v2:0", body=body)["body"].read())["embedding"]
    (GEN / "index.json").write_text(json.dumps(chunks))
    print(f"chunks={len(chunks)} embedded={args.embed}")


if __name__ == "__main__":
    main()
