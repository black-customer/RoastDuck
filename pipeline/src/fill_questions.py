# -*- coding: utf-8 -*-
"""question/topic 批次紧凑填充器。

spec 文本行格式（| 分隔，question/topic 通用）：
  <unitKey> | <dimIds 逗号分隔> | <displayChunk> | <meaningZh> | <unitType> | <difficulty> | <exampleEn>[| <exampleZh>[| <pattern>[| var1;var2]]]

用法：python pipeline/src/fill_questions.py <batchId> <spec.txt>
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
VALID_TYPES = {"collocation", "lexical_chunk", "phrasal_verb", "sentence_frame",
               "construction", "functional_expression", "idiom"}


def main() -> None:
    batch_id, spec_path = sys.argv[1], sys.argv[2]
    f = ROOT / "pipeline/queue/chunk_candidate/pending" / f"{batch_id}.json"
    b = json.load(open(f, encoding="utf-8"))
    # unitKey 可能含 '|'（如 q|q_xxx），spec 中可只写最后一段 id
    by_key: dict[str, dict] = {}
    for u in b["inputs"]:
        by_key[u["unitKey"]] = u
        by_key[u["unitKey"].split("|")[-1]] = u

    items: dict[str, dict] = {}
    with open(spec_path, encoding="utf-8") as fh:
        for raw in fh:
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            parts = [p.strip() for p in line.split("|")]
            key = parts[0]
            if key not in by_key:
                raise SystemExit(f"未知 unitKey: {key}")
            dims = [d.strip() for d in parts[1].split(",") if d.strip()]
            display, meaning, utype, difficulty, example = parts[2], parts[3], parts[4], parts[5] or "intermediate", parts[6] if len(parts) > 6 else ""
            example_zh = parts[7] if len(parts) > 7 else ""
            pattern = parts[8] if len(parts) > 8 and parts[8] else None
            variants = [v.strip() for v in parts[9].split(";") if v.strip()] if len(parts) > 9 else []
            if utype not in VALID_TYPES:
                raise SystemExit(f"非法 unitType: {utype} @ {line}")
            if not example:
                raise SystemExit(f"缺少例句: {line[:50]}")
            item = items.setdefault(key, {"unitKey": key, "chunks": []})
            item["chunks"].append({
                "displayChunk": display,
                "unitType": utype,
                "meaningZh": meaning,
                "englishGloss": "",
                "variants": variants,
                "exampleEn": example,
                "exampleZh": example_zh,
                "difficulty": difficulty,
                "tags": [],
                "dimIds": dims,
            })

    missing = [u["unitKey"] for u in b["inputs"] if u["unitKey"].split("|")[-1] not in items]
    if missing:
        raise SystemExit(f"缺少单元: {missing}")
    empty = [k for k, v in items.items() if not v["chunks"]]
    if empty:
        raise SystemExit(f"题/话题无产出必须给 noNewUnitReason（question/topic 不允许）: {empty}")
    ordered = []
    for u in b["inputs"]:
        ordered.append(items[u["unitKey"].split("|")[-1]])
    b["output"] = {"items": ordered}
    json.dump(b, open(f, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    n = sum(len(i["chunks"]) for i in b["output"]["items"])
    print(f"filled {batch_id}: {len(items)} 单元, {n} chunks")


if __name__ == "__main__":
    main()
