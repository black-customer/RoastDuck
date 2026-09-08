# -*- coding: utf-8 -*-
"""M1 Source Import：把 8 份 PDF 的文本（含字体样式）提取为结构化 JSON。

输出：pipeline/sources/raw/<slug>.json
  [{page, lines: [{y, size, spans: [{font, size, text}], text}]}]

只负责忠实提取，不做业务解析（解析在 pipeline/src/stages/extract_content.ts）。
"""
import json
import re
import sys
import unicodedata
from pathlib import Path

import fitz

ROOT = Path(__file__).resolve().parents[2]
MATERIALS = ROOT / "materials"
OUT_DIR = ROOT / "pipeline" / "sources" / "raw"
OUT_DIR.mkdir(parents=True, exist_ok=True)


def normalize(s: str) -> str:
    """Kangxi 部首/兼容字符（U+2E80–U+2FDF）→ 统一汉字；其余原样保留。"""
    out = []
    for ch in s:
        cp = ord(ch)
        if 0x2E80 <= cp <= 0x2FDF:
            n = unicodedata.normalize("NFKC", ch)
            out.append(n if n else ch)
        else:
            out.append(ch)
    return "".join(out)


SLUGS = {
    "Part1新题.pdf": "part1_new_2026q1",
    "Part2人物类串题.pdf": "part2_people",
    "Part2全部新题串题.pdf": "part2_all_new",
    "Part3（一）.pdf": "part3_vol1",
    "Part3（二）.pdf": "part3_vol2",
    "【麦门雅思】2026年5-8月口语Part1新题高分demo.pdf": "mdoors_part1_demo_2026q2",
    "【麦门雅思】26年5-8月Part2新题保留题_全部串题.pdf": "mdoors_part2_2026q2",
    "【麦门雅思】26年5-8月Part3_十大话题高分示范.pdf": "mdoors_part3_2026q2",
}


def extract(pdf_path: Path) -> list:
    doc = fitz.open(pdf_path)
    pages = []
    for i, page in enumerate(doc):
        d = page.get_text("dict")
        lines = []
        for block in d.get("blocks", []):
            if block.get("type") != 0:
                continue
            for line in block.get("lines", []):
                spans = [
                    {
                        "font": normalize(s.get("font", "")),
                        "size": round(float(s.get("size", 0)), 1),
                        "text": normalize(s.get("text", "")),
                    }
                    for s in line.get("spans", [])
                    if s.get("text", "").strip()
                ]
                if not spans:
                    continue
                text = normalize("".join(s["text"] for s in spans)).strip()
                if not text:
                    continue
                lines.append({
                    "y": round(float(line["bbox"][1]), 1),
                    "size": round(max(s["size"] for s in spans), 1),
                    "spans": spans,
                    "text": text,
                })
        lines.sort(key=lambda l: l["y"])
        pages.append({"page": i + 1, "lines": lines})
    doc.close()
    return pages


def main() -> None:
    manifest = {}
    for filename, slug in SLUGS.items():
        pdf = MATERIALS / filename
        if not pdf.exists():
            print(f"MISSING: {filename}")
            continue
        pages = extract(pdf)
        out = OUT_DIR / f"{slug}.json"
        out.write_text(
            json.dumps({"slug": slug, "file": filename, "pages": pages}, ensure_ascii=False),
            encoding="utf-8",
        )
        n_lines = sum(len(p["lines"]) for p in pages)
        manifest[slug] = {"file": filename, "pages": len(pages), "lines": n_lines, "bytes": out.stat().st_size}
        print(f"OK {slug}: {len(pages)} pages, {n_lines} lines -> {out.name}")
    (OUT_DIR / "_manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )


if __name__ == "__main__":
    sys.exit(main())
