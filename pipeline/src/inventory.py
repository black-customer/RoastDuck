# -*- coding: utf-8 -*-
"""M0 材料盘点：逐 PDF 检测文本层、页数、文本样本，输出盘点报告 JSON + MD。"""
import json
import sys
import hashlib
from pathlib import Path

import fitz  # PyMuPDF

ROOT = Path(__file__).resolve().parents[2]
MATERIALS = ROOT / "materials"
OUT_DIR = ROOT / "pipeline" / "reports"
OUT_DIR.mkdir(parents=True, exist_ok=True)


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def sample_text(text: str, n: int = 400) -> str:
    text = " ".join(text.split())
    return text[:n]


def main() -> None:
    pdfs = sorted(MATERIALS.glob("*.pdf"))
    inventory = []
    for pdf in pdfs:
        doc = fitz.open(pdf)
        pages = []
        total_chars = 0
        text_pages = 0
        sample = ""
        for i, page in enumerate(doc):
            txt = page.get_text("text").strip()
            total_chars += len(txt)
            has_text = len(txt) >= 30
            if has_text:
                text_pages += 1
                if not sample:
                    sample = sample_text(txt)
            pages.append({
                "page": i + 1,
                "text_chars": len(txt),
                "has_text_layer": has_text,
                "images": len(page.get_images(full=True)),
            })
        text_ratio = text_pages / len(pages) if pages else 0
        inventory.append({
            "file": pdf.name,
            "sha256": sha256(pdf)[:16],
            "pages": len(pages),
            "text_pages": text_pages,
            "text_ratio": round(text_ratio, 3),
            "total_text_chars": total_chars,
            "text_layer_verdict": "text" if text_ratio >= 0.8 and total_chars > 200 * len(pages) else ("mixed" if text_pages > 0 else "image"),
            "first_text_sample": sample,
            "per_page": pages,
        })
        doc.close()

    out_json = OUT_DIR / "material-inventory.json"
    out_json.write_text(json.dumps(inventory, ensure_ascii=False, indent=2), encoding="utf-8")

    lines = ["# 材料盘点报告（M0）", ""]
    lines.append("| 文件 | 页数 | 有文本层页 | 文本率 | 判定 |")
    lines.append("| --- | --- | --- | --- | --- |")
    for item in inventory:
        lines.append(
            f"| {item['file']} | {item['pages']} | {item['text_pages']} | "
            f"{item['text_ratio']:.0%} | {item['text_layer_verdict']} |"
        )
    lines.append("")
    for item in inventory:
        lines.append(f"## {item['file']}")
        lines.append(f"- SHA256(前16): `{item['sha256']}`，共 {item['pages']} 页，文本字符总量 {item['total_text_chars']}")
        lines.append(f"- 首个有文本层页样本: `{item['first_text_sample'][:200] or '（无）'}`")
        lines.append("")
    out_md = OUT_DIR / "material-inventory.md"
    out_md.write_text("\n".join(lines), encoding="utf-8")
    print(f"OK: {out_json}")
    print("\n".join(lines[:len(inventory) + 4]))


if __name__ == "__main__":
    sys.exit(main())
