import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDbReady } from "@db/client";
import { lexemes, textAnnotations } from "@db/schema";
import { buildInteractiveText } from "@/lib/learning/content";
import type { InteractiveText } from "@/lib/learning/types";
import type { RuntimeGlossaryEntry } from "./schemas";

const englishWordPattern = /[A-Za-z]+(?:['’][A-Za-z]+)?/g;

function stableId(prefix: string, ...parts: string[]) {
  return `${prefix}_${createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 24)}`;
}

function canonicalize(value: string) {
  return value.normalize("NFKC").toLowerCase().replace(/[‘’]/g, "'").replace(/[^a-z0-9'\s-]/g, " ").replace(/\s+/g, " ").trim();
}

function glossaryMap(glossary: RuntimeGlossaryEntry[]) {
  return new Map(glossary.map((entry) => [canonicalize(entry.surface), entry]));
}

export function assertRuntimeGlossaryCoverage(texts: string[], glossary: RuntimeGlossaryEntry[]) {
  const entries = glossaryMap(glossary);
  const missing = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(englishWordPattern)) {
      if (!entries.has(canonicalize(match[0]))) missing.add(match[0]);
    }
  }
  if (missing.size) throw new Error(`AI 英文词汇注解不完整：${[...missing].join("、")}`);
}

async function ensureLexeme(entry: RuntimeGlossaryEntry) {
  const db = await getDbReady();
  const normalized = canonicalize(entry.surface);
  const [existing] = await db.select({ id: lexemes.id }).from(lexemes)
    .where(and(eq(lexemes.normalized, normalized), eq(lexemes.accent, "en-US"))).limit(1);
  if (existing) return existing.id;
  const id = stableId("lexeme", normalized, "en-US");
  await db.insert(lexemes).values({
    id,
    surface: entry.surface,
    normalized,
    lemma: normalized,
    meaningZh: entry.meaningZh,
    ipa: entry.ipa,
    accent: "en-US",
    source: "speaking_runtime_ai",
    status: "verified",
  }).onConflictDoNothing({ target: [lexemes.normalized, lexemes.accent] });
  const [stored] = await db.select({ id: lexemes.id }).from(lexemes)
    .where(and(eq(lexemes.normalized, normalized), eq(lexemes.accent, "en-US"))).limit(1);
  if (!stored) throw new Error(`口语词项写入失败：${entry.surface}`);
  return stored.id;
}

export async function annotateRuntimeEnglish(input: {
  contentType: Extract<InteractiveText["contentType"], "speaking_hint" | "speaking_feedback" | "speaking_message" | "scenario_line">;
  contentId: string;
  text: string;
  glossary: RuntimeGlossaryEntry[];
  phraseMeaningZh?: string;
}) {
  const db = await getDbReady();
  const entries = glossaryMap(input.glossary);
  assertRuntimeGlossaryCoverage([input.text], input.glossary);

  if (input.phraseMeaningZh && [...input.text.matchAll(englishWordPattern)].length > 1) {
    await db.insert(textAnnotations).values({
      id: stableId("annotation", input.contentType, input.contentId, "phrase"),
      contentType: input.contentType,
      contentId: input.contentId,
      startOffset: 0,
      endOffset: input.text.length,
      surface: input.text,
      meaningZh: input.phraseMeaningZh,
      accent: "en-US",
    }).onConflictDoNothing();
  }

  for (const match of input.text.matchAll(englishWordPattern)) {
    const start = match.index;
    const end = start + match[0].length;
    const entry = entries.get(canonicalize(match[0]));
    if (!entry) throw new Error(`AI 英文词汇注解不完整：${match[0]}`);
    const lexemeId = await ensureLexeme(entry);
    await db.insert(textAnnotations).values({
      id: stableId("annotation", input.contentType, input.contentId, String(start), String(end)),
      contentType: input.contentType,
      contentId: input.contentId,
      startOffset: start,
      endOffset: end,
      surface: match[0],
      lexemeId,
      meaningZh: entry.meaningZh,
      ipa: entry.ipa,
      accent: "en-US",
    }).onConflictDoNothing();
  }

  return buildInteractiveText(input.contentType, input.contentId, input.text);
}
