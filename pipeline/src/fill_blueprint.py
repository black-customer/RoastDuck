# -*- coding: utf-8 -*-
"""Agent 批次填充辅助：把 output 写入指定批次文件。
用法：
  python pipeline/src/fill_blueprint.py <batchId> <spec.json>
spec.json: [{questionId, dimensions: [{dimId,dimZh,dimEn}]}]
"""
import json
import sys
import glob
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
QUEUE = ROOT / "pipeline" / "queue"


def fill(stage: str, batch_id: str, output: dict) -> None:
    f = QUEUE / stage / "pending" / f"{batch_id}.json"
    if not f.exists():
        raise SystemExit(f"missing: {f}")
    b = json.load(open(f, encoding="utf-8"))
    b["output"] = output
    json.dump(b, open(f, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"filled {stage}/{batch_id}")


def fill_blueprints(batch_id: str, items) -> None:
    fill("blueprint", batch_id, {"blueprints": items})


if __name__ == "__main__":
    stage, batch_id, spec = sys.argv[1], sys.argv[2], json.load(open(sys.argv[3], encoding="utf-8"))
    if stage == "blueprint":
        fill_blueprints(batch_id, spec)
    else:
        fill(stage, batch_id, spec)
