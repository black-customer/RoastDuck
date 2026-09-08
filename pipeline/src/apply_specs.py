# -*- coding: utf-8 -*-
"""把累计的句子判定 spec 直接应用到 DB（insertOrMerge 语义 + 状态更新）。"""
import json
import glob
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DB = ROOT / "data" / "app.db"

VALID = {"collocation", "lexical_chunk", "phrasal_verb", "sentence_frame",
         "construction", "functional_expression", "idiom"}


def chunk_id(canonical, book):
    text = f"{book}|{canonical}"
    h1, h2 = 0x811c9dc5, 0x01000193
    for ch in text:
        c = ord(ch)
        h1 = ((h1 ^ c) * 0x01000193) & 0xFFFFFFFF
        h2 = ((h2 + c * 31) * 0x85ebca6b) & 0xFFFFFFFF
    return "c_" + ((format(h1, 'x') + format(h2, 'x')).ljust(12, '0'))[:12]


def sentence_id(text, book):
    return "s_" + chunk_id(text, book)[2:]


def main():
    conn = sqlite3.connect(DB)
    cur = conn.cursor()
    applied = 0
    for fn in ["pipeline/queue/_spec_a2.txt", "pipeline/queue/_spec_b1.txt",
               "pipeline/queue/_spec_c1.txt", "pipeline/queue/_spec_d1.txt"]:
        p = ROOT / fn
        if not p.exists():
            continue
        by_sid = {}
        for line in p.read_text(encoding="utf-8").splitlines():
            t = line.strip()
            if not t or t.startswith("#"):
                continue
            parts = [x.strip() for x in t.split("|")]
            by_sid.setdefault(parts[0], []).append(parts)
        for sid, lines in by_sid.items():
            row = cur.execute("SELECT status, text FROM source_sentences WHERE id=?", (sid,)).fetchone()
            if not row:
                continue
            status, text = row
            if status != "pending":
                continue
            skips = [l for l in lines if l[1] == "SKIP"]
            chunks = [l for l in lines if l[1] != "SKIP"]
            if skips and not chunks:
                reason = skips[0][2] if len(skips[0]) > 2 else "filler"
                cur.execute("UPDATE source_sentences SET status='no_new_unit', no_new_unit_reason=? WHERE id=?",
                            (reason, sid))
                applied += 1
                continue
            for l in chunks:
                if len(l) < 5:
                    continue
                display, meaning, utype, difficulty = l[1], l[2], l[3], l[4] if len(l) > 4 else "intermediate"
                if utype not in VALID:
                    continue
                canonical = display.lower()
                cid = chunk_id(canonical, "book1_ielts_complete")
                cur.execute("""INSERT OR IGNORE INTO chunks (id, book_id, canonical_chunk, display_chunk,
                    unit_type, meaning_zh, english_gloss, pattern, variants_json, difficulty, tags_json,
                    content_version, quality_status)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (cid, "book1_ielts_complete", canonical, display, utype, meaning, "", None,
                     "[]", difficulty, "[]", "v0.1.0", "pending_review"))
                cur.execute("INSERT OR IGNORE INTO chunk_examples (id, chunk_id, text_en, text_zh, is_source_sentence) VALUES (?,?,?,?,1)",
                            ("ce_" + cid[2:] + "_" + sid[2:], cid, text, ""))
                cur.execute("INSERT OR IGNORE INTO chunk_sources (id, chunk_id, source_type, book_id, sentence_id, source_context) VALUES (?,?,?,?,?,?)",
                            ("cs_" + cid[2:] + "_" + sid[2:], cid, "demo_answer", "book1_ielts_complete", sid, ""))
            cur.execute("UPDATE source_sentences SET status='chunked' WHERE id=?", (sid,))
            applied += 1
    conn.commit()
    left = cur.execute("SELECT COUNT(*) FROM source_sentences WHERE status='pending'").fetchone()[0]
    total = cur.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]
    print(f"applied={applied}, remaining pending={left}, chunks total={total}")


if __name__ == "__main__":
    main()
