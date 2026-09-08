# -*- coding: utf-8 -*-
"""句子批次紧凑填充器。

spec 文本行格式（| 分隔）：
  <sentenceId> | SKIP | <noNewUnitReason>
  <sentenceId> | <displayChunk> | <meaningZh> | <unitType> | <difficulty>[| variant1;variant2]
一个句子可跟多行 chunk。unitType: collocation/lexical_chunk/phrasal_verb/sentence_frame/construction/functional_expression/idiom
例句自动使用原句（来源句）；gloss/译文留空由质检阶段处理。

用法：python pipeline/src/fill_sentences.py <batchId> <spec.txt>
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
    existing = (b.get("output") or {}).get("items", [])
    known = {i["unitKey"]: i for i in existing if i.get("alreadyProcessed")}
    by_sid = {u["sentenceId"]: u for u in b["inputs"]}
    text_by_sid = {u["sentenceId"]: u["text"] for u in b["inputs"]}

    items: dict[str, dict] = {}
    with open(spec_path, encoding="utf-8") as fh:
        for raw in fh:
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            parts = [p.strip() for p in line.split("|")]
            sid = parts[0]
            if sid not in by_sid:
                raise SystemExit(f"未知 sentenceId: {sid}")
            if parts[1] == "SKIP":
                if sid in items and items[sid]["chunks"]:
                    continue
                item = {"unitKey": by_sid[sid]["unitKey"], "chunks": []}
                if len(parts) > 2 and parts[2]:
                    item["noNewUnitReason"] = parts[2]
                items[sid] = item
                continue
            display, meaning, utype, difficulty = parts[1], parts[2], parts[3], parts[4] if len(parts) > 4 else "intermediate"
            variants = [v.strip() for v in parts[5].split(";") if v.strip()] if len(parts) > 5 else []
            if utype not in VALID_TYPES:
                raise SystemExit(f"非法 unitType: {utype} @ {line}")
            item = items.setdefault(sid, {"unitKey": by_sid[sid]["unitKey"], "chunks": []})
            item["chunks"].append({
                "displayChunk": display,
                "unitType": utype,
                "meaningZh": meaning,
                "englishGloss": "",
                "variants": variants,
                "exampleEn": text_by_sid[sid],
                "exampleZh": "",
                "difficulty": difficulty,
                "tags": [],
                "dimIds": [],
            })

    missing = [u["sentenceId"] for u in b["inputs"] if u["sentenceId"] not in items]
    if missing:
        raise SystemExit(f"缺少句子的判定: {missing}")
    for u in b["inputs"]:
        if u["sentenceId"] not in items and u["unitKey"] in known:
            items[u["sentenceId"]] = known[u["unitKey"]]
    b["output"] = {"items": [items[u["sentenceId"]] for u in b["inputs"]]}
    json.dump(b, open(f, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    n_chunks = sum(len(i["chunks"]) for i in b["output"]["items"])
    print(f"filled {batch_id}: {len(b['output']['items'])} 句, {n_chunks} chunks")


if __name__ == "__main__":
    main()
