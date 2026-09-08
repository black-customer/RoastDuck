# -*- coding: utf-8 -*-
"""将 _dimfix.json 的维度补丁语块插入 DB（insertOrMerge 语义）。"""
import json
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DB = ROOT / "data" / "app.db"


def h(text: str) -> str:
    h1, h2 = 0x811C9DC5, 0x01000193
    for ch in text:
        c = ord(ch)
        h1 = ((h1 ^ c) * 0x01000193) & 0xFFFFFFFF
        h2 = ((h2 + c * 31) * 0x85EBCA6B) & 0xFFFFFFFF
    return (format(h1, "x") + format(h2, "x")).ljust(12, "0")[:12]


def main():
    conn = sqlite3.connect(DB)
    cur = conn.cursor()
    fixes = json.load(open(ROOT / "pipeline/queue/_dimfix.json", encoding="utf-8"))
    for f in fixes:
        display = f["display"].strip()
        meaning = f.get("meaningZh") or ""
        dim = f.get("dim") or f.get("d")
        cid = "c_" + h(("book1_ielts_complete|" + display.lower()))
        cur.execute("""INSERT OR IGNORE INTO chunks (id, book_id, canonical_chunk, display_chunk,
            unit_type, meaning_zh, english_gloss, variants_json, difficulty, tags_json,
            content_version, quality_status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
            (cid, "book1_ielts_complete", display.lower(), display, f["unitType"], meaning,
             "", "[]", f["difficulty"], "[]", "v0.1.0", "approved"))
        rid = "cr_" + h(f"{cid}|question_dimension|{f['q']}|{dim}")
        cur.execute("""INSERT OR IGNORE INTO chunk_coverage_refs (id, chunk_id, ref_type,
            question_id, dim_id) VALUES (?,?,?,?,?)""", (rid, cid, "question_dimension", f["q"], dim))
        cur.execute("""INSERT OR IGNORE INTO chunk_sources (id, chunk_id, source_type, book_id,
            question_id, source_context) VALUES (?,?,?,?,?,?)""",
            ("cs_" + h(f"{cid}|question_bank|{f['q']}"), cid, "question_bank",
             "book1_ielts_complete", f["q"], ""))
        eid = "ce_" + h(f"{cid}|{f['example']}")
        cur.execute("""INSERT OR IGNORE INTO chunk_examples (id, chunk_id, text_en, text_zh) VALUES (?,?,?,?)""",
                    (eid, cid, f["example"], f.get("exampleZh", "")))
    conn.commit()
    n = cur.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]
    refs = cur.execute("SELECT COUNT(*) FROM chunk_coverage_refs").fetchone()[0]
    print(f"chunks={n}, refs={refs}")


if __name__ == "__main__":
    main()
