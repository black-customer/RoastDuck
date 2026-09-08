"""从 ECDICT 抽取本项目实际需要的离线词条，并生成稳定 ID 的注解与 Chunk 音标候选。"""

from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import json
import re
import sqlite3
from pathlib import Path
from typing import Any


TOKEN_RE = re.compile(r"[A-Za-z]+(?:['’][A-Za-z]+)*")
SOURCE_COMMIT = "bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b"
SOURCE_SHA256 = "1A6947E04785DB63613A92E14903CDAE7954F7E84860B10E68E5C7CBB3F9C3CF"


def normalize(value: str) -> str:
    return re.sub(r"\s+", " ", value.strip().lower().replace("’", "'"))


def stable_id(prefix: str, *parts: str) -> str:
    digest = hashlib.sha1("|".join(parts).encode("utf-8")).hexdigest()[:14]
    return f"{prefix}_{digest}"


def first_meaning(value: str) -> str:
    lines = [line.strip() for line in value.splitlines() if line.strip()]
    return "；".join(lines[:3])[:360]


def first_definition(value: str) -> str:
    lines = [line.strip() for line in value.splitlines() if line.strip()]
    return "; ".join(lines[:2])[:240]


def exchange_forms(value: str) -> list[str]:
    forms: list[str] = []
    for item in value.split("/"):
        if ":" not in item:
            continue
        _, words = item.split(":", 1)
        forms.extend(normalize(word) for word in words.split(",") if normalize(word))
    return forms


def read_project_content(connection: sqlite3.Connection) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    connection.row_factory = sqlite3.Row
    texts: list[dict[str, Any]] = []
    for content_type, table, text_column in [
        ("sentence", "source_sentences", "text"),
        ("example", "chunk_examples", "text_en"),
        ("question", "questions", "text"),
    ]:
        for row in connection.execute(f"SELECT id, {text_column} AS text FROM {table}"):
            texts.append({"contentType": content_type, "contentId": row["id"], "text": row["text"]})
    chunks = [dict(row) for row in connection.execute(
        "SELECT id, display_chunk, canonical_chunk, meaning_zh, english_gloss FROM chunks WHERE quality_status != 'rejected'"
    )]
    return texts, chunks


def load_dictionary(csv_path: Path, required: set[str]) -> dict[str, dict[str, str]]:
    found: dict[str, dict[str, str]] = {}
    with csv_path.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            word = normalize(row.get("word") or "")
            if not word:
                continue
            candidates = [word, *exchange_forms(row.get("exchange") or "")]
            matches = required.intersection(candidates)
            if not matches:
                continue
            meaning = first_meaning(row.get("translation") or "")
            if not meaning:
                continue
            entry = {
                "lemma": word,
                "meaningZh": meaning,
                "ipa": (row.get("phonetic") or "").strip(),
                "definition": first_definition(row.get("definition") or ""),
                "source": f"ECDICT@{SOURCE_COMMIT}",
                "status": "verified",
            }
            for match in matches:
                previous = found.get(match)
                if previous is None or (not previous["ipa"] and entry["ipa"]):
                    found[match] = entry
    return found


def apply_project_overrides(
    override_path: Path, required: set[str], dictionary: dict[str, dict[str, str]]
) -> None:
    """只接受随仓库审计的专名/拼写修正；不得用空泛兜底伪造词义。"""
    if not override_path.exists():
        raise SystemExit(f"项目词典修正不存在: {override_path}")
    payload = json.loads(override_path.read_text(encoding="utf-8"))
    if payload.get("schemaVersion") != 1 or not isinstance(payload.get("entries"), dict):
        raise SystemExit("lexicon_overrides.json 结构无效")
    for raw_surface, value in payload["entries"].items():
        surface = normalize(raw_surface)
        if surface not in required:
            continue
        if not isinstance(value, dict) or not value.get("meaningZh"):
            raise SystemExit(f"词典修正缺少 meaningZh: {raw_surface}")
        dictionary[surface] = {
            "lemma": normalize(value.get("lemma") or surface),
            "meaningZh": str(value["meaningZh"])[:360],
            "ipa": str(value.get("ipa") or "").strip(),
            "definition": str(value.get("definition") or "")[:240],
            "source": "project-override@v1",
            "status": "verified" if value.get("status") == "verified" else "pending",
        }

    # 所有格只复用已验证的基本词义，不声称拥有新的发音数据。
    for surface in sorted(required.difference(dictionary)):
        possessive = re.fullmatch(r"(.+)'s", surface)
        if not possessive:
            continue
        base_surface = possessive.group(1)
        base = dictionary.get(base_surface)
        if not base or base.get("status") != "verified":
            continue
        dictionary[surface] = {
            "lemma": base["lemma"],
            "meaningZh": f"{base['meaningZh']}；{base_surface} 的所有格形式"[:360],
            "ipa": "",
            "definition": base.get("definition", ""),
            "source": "project-derived-possessive@v1",
            "status": "verified",
        }


def build_annotations(
    texts: list[dict[str, Any]], chunks: list[dict[str, str]], dictionary: dict[str, dict[str, str]]
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    chunk_phrases = sorted(
        [(normalize(chunk["display_chunk"]), chunk) for chunk in chunks if normalize(chunk["display_chunk"])],
        key=lambda item: len(item[0]),
        reverse=True,
    )
    annotations: list[dict[str, Any]] = []
    uncovered: list[dict[str, Any]] = []
    for record in texts:
        text = record["text"] or ""
        lowered = text.lower().replace("’", "'")
        occupied: list[tuple[int, int]] = []
        for phrase, chunk in chunk_phrases:
            if phrase not in lowered:
                continue
            for match in re.finditer(rf"(?<![A-Za-z]){re.escape(phrase)}(?![A-Za-z])", lowered):
                start, end = match.span()
                if any(start < used_end and end > used_start for used_start, used_end in occupied):
                    continue
                annotations.append({
                    "id": stable_id("an", record["contentType"], record["contentId"], str(start), str(end)),
                    "contentType": record["contentType"],
                    "contentId": record["contentId"],
                    "startOffset": start,
                    "endOffset": end,
                    "surface": text[start:end],
                    "lexemeId": None,
                    "chunkId": chunk["id"],
                    "meaningZh": chunk["meaning_zh"],
                    "ipa": None,
                    "accent": "en-GB",
                })
                occupied.append((start, end))
        for match in TOKEN_RE.finditer(text):
            start, end = match.span()
            if any(start >= used_start and end <= used_end for used_start, used_end in occupied):
                continue
            key = normalize(match.group())
            entry = dictionary.get(key)
            if not entry:
                if len(uncovered) < 1000:
                    uncovered.append({
                        "contentType": record["contentType"],
                        "contentId": record["contentId"],
                        "surface": match.group(),
                        "startOffset": start,
                    })
                continue
            annotations.append({
                "id": stable_id("an", record["contentType"], record["contentId"], str(start), str(end)),
                "contentType": record["contentType"],
                "contentId": record["contentId"],
                "startOffset": start,
                "endOffset": end,
                "surface": match.group(),
                "lexemeId": stable_id("lx", key, "en-GB"),
                "chunkId": None,
                "meaningZh": entry["meaningZh"],
                "ipa": entry["ipa"] or None,
                "accent": "en-GB",
            })
    return annotations, uncovered


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", default="data/app.db")
    parser.add_argument("--ecdict", default="data/vendor/ecdict.csv")
    parser.add_argument("--overrides", default="pipeline/sources/lexicon_overrides.json")
    parser.add_argument("--output", default="pipeline/sources/lexicon_subset.json.gz")
    parser.add_argument("--report", default="pipeline/reports/lexicon-build.json")
    args = parser.parse_args()

    database_path = Path(args.db).resolve()
    csv_path = Path(args.ecdict).resolve()
    override_path = Path(args.overrides).resolve()
    if not database_path.exists():
        raise SystemExit(f"数据库不存在: {database_path}")
    if not csv_path.exists():
        raise SystemExit(f"ECDICT 不存在: {csv_path}")

    with sqlite3.connect(database_path) as connection:
        texts, chunks = read_project_content(connection)
    required = {normalize(match.group()) for record in texts for match in TOKEN_RE.finditer(record["text"] or "")}
    required.update(normalize(chunk["display_chunk"]) for chunk in chunks)
    lookup_required = set(required)
    for surface in required:
        possessive = re.fullmatch(r"(.+)'s", surface)
        if possessive:
            lookup_required.add(possessive.group(1))
    dictionary = load_dictionary(csv_path, lookup_required)
    apply_project_overrides(override_path, lookup_required, dictionary)

    lexemes = [
        {
            "id": stable_id("lx", surface, "en-GB"),
            "surface": surface,
            "normalized": surface,
            "lemma": entry["lemma"],
            "meaningZh": entry["meaningZh"],
            "ipa": entry["ipa"] or None,
            "accent": "en-GB",
            "source": entry["source"],
            "status": entry["status"],
            "definition": entry["definition"],
        }
        for surface, entry in sorted(dictionary.items())
    ]

    pronunciations: list[dict[str, Any]] = []
    for chunk in chunks:
        phrase = normalize(chunk["display_chunk"])
        exact = dictionary.get(phrase)
        token_entries = [dictionary.get(normalize(match.group())) for match in TOKEN_RE.finditer(chunk["display_chunk"])]
        ipa = exact["ipa"] if exact and exact["ipa"] else " ".join(entry["ipa"] for entry in token_entries if entry and entry["ipa"])
        if not ipa or any(entry is None or not entry["ipa"] for entry in token_entries):
            continue
        source = "ECDICT" if exact and exact["ipa"] else "ECDICT-composed"
        pronunciations.append({
            "id": stable_id("cp", chunk["id"], "en-GB", source),
            "chunkId": chunk["id"],
            "ipa": ipa,
            "accent": "en-GB",
            "audioUrl": None,
            "source": f"{source}@{SOURCE_COMMIT}",
            "isPrimary": 1,
        })
        if not chunk["english_gloss"] and exact and exact["definition"]:
            chunk["english_gloss"] = exact["definition"]

    annotations, uncovered = build_annotations(texts, chunks, dictionary)
    payload = {
        "schemaVersion": 1,
        "source": {
            "name": "ECDICT",
            "repository": "https://github.com/skywind3000/ECDICT",
            "commit": SOURCE_COMMIT,
            "inputSha256": SOURCE_SHA256,
            "license": "MIT",
        },
        "lexemes": lexemes,
        "chunkPronunciations": pronunciations,
        "chunkGlosses": [
            {"chunkId": chunk["id"], "englishGloss": chunk["english_gloss"]}
            for chunk in chunks if chunk["english_gloss"]
        ],
        "annotations": annotations,
    }
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    serialized = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    if output_path.suffix == ".gz":
        with gzip.open(output_path, "wt", encoding="utf-8", compresslevel=9) as handle:
            handle.write(serialized)
    else:
        output_path.write_text(serialized, encoding="utf-8")
    report = {
        "requiredTerms": len(required),
        "matchedTerms": len(dictionary),
        "lexemes": len(lexemes),
        "chunkPronunciations": len(pronunciations),
        "annotations": len(annotations),
        "uncoveredTokenSamples": uncovered,
        "output": output_path.as_posix(),
    }
    report_path = Path(args.report)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps({key: value for key, value in report.items() if key != "uncoveredTokenSamples"}, ensure_ascii=False))


if __name__ == "__main__":
    main()
