# -*- coding: utf-8 -*-
"""合并同类 pending 批次，减少批次数量（topic 2→6，sentence 40→100）。"""
import json
import glob
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
QUEUE = ROOT / "pipeline/queue/chunk_candidate/pending"

for kind, size in [("topic", 6), ("sentence", 100)]:
    files = []
    for f in sorted(glob.glob(str(QUEUE / "*.json"))):
        b = json.load(open(f, encoding="utf-8"))
        if not b.get("output") and b["inputs"][0]["kind"] == kind:
            files.append((f, b))
    print(f"{kind}: {len(files)} pending batches -> merge into groups of {size}")
    group, moved = [], 0
    def flush(group):
        if not group:
            return
        units = [u for _, b in group for u in b["inputs"]]
        new_batch = {
            "batchId": group[0][1]["batchId"] + "+m",
            "stage": "chunk_candidate",
            "promptVersion": group[0][1]["promptVersion"],
            "createdAt": group[0][1]["createdAt"],
            "inputs": units,
            "output": None,
            "attempts": 0,
        }
        json.dump(new_batch, open(QUEUE / f"{new_batch['batchId']}.json", "w", encoding="utf-8"),
                  ensure_ascii=False, indent=1)
        for f, _ in group:
            os.remove(f)
    for f, b in files:
        group.append((f, b))
        moved += len(b["inputs"])
        if len(group) >= size:
            flush(group)
            group = []
    flush(group)
    print(f"  merged {moved} units")

