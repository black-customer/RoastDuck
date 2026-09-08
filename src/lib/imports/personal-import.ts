import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { z } from "zod";

export const IMPORT_PARSER_VERSION = "personal-transcript-parser-v1";
export const IMPORT_PROMPT_VERSION = "offline-agent-personal-gap-v2";
export const IMPORT_SCHEMA_VERSION = "personal-import-v2";

export const SegmentTypeSchema = z.enum([
  "question",
  "answer",
  "retry_answer",
  "instruction",
  "self_comment",
  "abandoned",
  "asr_uncertain",
  "unclassified",
]);
export type SegmentType = z.infer<typeof SegmentTypeSchema>;

export const ImportSegmentSchema = z.object({
  id: z.string(),
  sourceOrder: z.number().int().nonnegative(),
  startOffset: z.number().int().nonnegative(),
  endOffset: z.number().int().nonnegative(),
  type: SegmentTypeSchema,
  rawText: z.string(),
  normalizedText: z.string(),
  questionId: z.string().nullable(),
  matchMethod: z.enum(["exact", "alias", "fuzzy", "reviewer", "personal_import"]).nullable(),
  matchConfidence: z.number().min(0).max(1).nullable(),
});
export type ImportSegment = z.infer<typeof ImportSegmentSchema>;

export type QuestionForMatch = {
  id: string;
  text: string;
  normText: string;
  part: number;
  topicId: string | null;
};

export type QuestionAliasForMatch = {
  questionId: string;
  aliasText: string;
  normalizedAlias: string;
};

export type QuestionMatch = {
  questionId: string | null;
  method: "exact" | "alias" | "fuzzy" | "reviewer" | "personal_import";
  confidence: number;
  margin: number;
};

export type GapCandidate = {
  ruleId: string;
  gapType: "lexical_gap" | "grammar_construction" | "discourse_gap" | "content_gap";
  evidenceText: string;
  intentZh: string;
  recommendedExpression: string;
  explanationZh: string;
  confidence: number;
  impactLevel: "high" | "medium" | "low";
  learningFit: boolean;
  reviewerReason: string;
  canonicalChunk: string;
  displayChunk: string;
  meaningZh: string;
  englishGloss: string;
  pattern: string;
  ipa: string;
  commonUsage: {
    settingZh: string;
    relationshipZh: string;
    purposeZh: string;
    lines: Array<{ speaker: string; en: string; zh: string; target?: boolean }>;
  };
  questionRepair: {
    settingZh: string;
    relationshipZh: string;
    purposeZh: string;
    lines: Array<{ speaker: string; en: string; zh: string; target?: boolean }>;
  };
};

const ScenarioSchema = z.object({
  settingZh: z.string().min(1),
  relationshipZh: z.string().min(1),
  purposeZh: z.string().min(1),
  lines: z.array(z.object({
    speaker: z.string().min(1),
    en: z.string().min(1),
    zh: z.string().min(1),
    target: z.boolean().optional(),
  })).min(1),
});

export const GapCandidateSchema: z.ZodType<GapCandidate> = z.object({
  ruleId: z.string().min(1),
  gapType: z.enum(["lexical_gap", "grammar_construction", "discourse_gap", "content_gap"]),
  evidenceText: z.string().min(1),
  intentZh: z.string(),
  recommendedExpression: z.string(),
  explanationZh: z.string().min(1),
  confidence: z.number().min(0).max(1),
  impactLevel: z.enum(["high", "medium", "low"]),
  learningFit: z.boolean(),
  reviewerReason: z.string().min(1),
  canonicalChunk: z.string(),
  displayChunk: z.string(),
  meaningZh: z.string(),
  englishGloss: z.string(),
  pattern: z.string(),
  ipa: z.string(),
  commonUsage: ScenarioSchema,
  questionRepair: ScenarioSchema,
});

const ReviewExecutionSchema = z.object({
  runId: z.string().min(1),
  sessionId: z.string().min(1),
  promptVersion: z.string().min(1),
  schemaVersion: z.string().min(1),
  inputSha256: z.string().regex(/^[a-f0-9]{64}$/),
  outputSha256: z.string().regex(/^[a-f0-9]{64}$/),
});

export const ReviewedGapVerdictSchema = z.object({
  gapId: z.string().min(1),
  ruleId: z.string().min(1),
  sourceSegmentId: z.string().min(1),
  startOffset: z.number().int().nonnegative(),
  endOffset: z.number().int().positive(),
  evidenceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  decision: z.enum(["approved", "edited", "rejected"]),
  disposition: z.enum(["publish", "ledger_only", "asr_uncertain", "drop", "needs_edit"]),
  reason: z.string().min(1),
  candidate: GapCandidateSchema.nullable(),
  generator: ReviewExecutionSchema,
  gapReviewer: ReviewExecutionSchema,
  scenarioReviewers: z.array(ReviewExecutionSchema).max(2),
}).superRefine((value, context) => {
  if (value.generator.runId === value.gapReviewer.runId || value.generator.sessionId === value.gapReviewer.sessionId) {
    context.addIssue({ code: "custom", message: "Generator 与 Gap Reviewer 必须是独立 run/session" });
  }
  if (value.disposition === "publish" && (!value.candidate || !value.candidate.learningFit || value.decision === "rejected")) {
    context.addIssue({ code: "custom", message: "发布项必须携带通过审核且适合学习的候选" });
  }
  if (value.disposition === "publish" && value.scenarioReviewers.length !== 2) {
    context.addIssue({ code: "custom", message: "发布项必须有两个独立语境 Reviewer 记录" });
  }
  if (new Set(value.scenarioReviewers.flatMap((item) => [item.runId, item.sessionId])).size !== value.scenarioReviewers.length * 2) {
    context.addIssue({ code: "custom", message: "两个 Scenario Reviewer 必须使用不同 run/session" });
  }
  for (const reviewer of value.scenarioReviewers) {
    if (reviewer.sessionId === value.generator.sessionId || reviewer.runId === value.generator.runId) {
      context.addIssue({ code: "custom", message: "Scenario Reviewer 不得复用 Generator run/session" });
    }
  }
});

export const PersonalReviewCheckpointSchema = z.object({
  version: z.literal("personal-review-checkpoint-v2"),
  importId: z.string().min(1),
  inputSnapshotSha256: z.string().regex(/^[a-f0-9]{64}$/),
  verdicts: z.array(ReviewedGapVerdictSchema),
  counts: z.object({
    approved: z.number().int().nonnegative(),
    edited: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative(),
  }),
}).superRefine((value, context) => {
  for (const decision of ["approved", "edited", "rejected"] as const) {
    const actual = value.verdicts.filter((item) => item.decision === decision).length;
    if (actual !== value.counts[decision]) context.addIssue({ code: "custom", message: `${decision} 计数与 verdicts 不一致` });
  }
  if (new Set(value.verdicts.map((item) => item.gapId)).size !== value.verdicts.length) {
    context.addIssue({ code: "custom", message: "Review checkpoint 存在重复 gapId" });
  }
});

export type PersonalReviewCheckpoint = z.infer<typeof PersonalReviewCheckpointSchema>;

export function stableId(prefix: string, ...parts: Array<string | number | null | undefined>): string {
  const digest = createHash("sha256").update(parts.map((part) => String(part ?? "")).join("\u001f")).digest("hex");
  return prefix + "_" + digest.slice(0, 20);
}

export function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export function normalizeForMatch(input: string): string {
  return input
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^\p{L}\p{N}']+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const saved = previous[j];
      previous[j] = Math.min(
        previous[j] + 1,
        previous[j - 1] + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diagonal = saved;
    }
  }
  return 1 - previous[b.length] / Math.max(a.length, b.length);
}

export function matchQuestion(
  candidate: string,
  questions: QuestionForMatch[],
  aliases: QuestionAliasForMatch[],
): QuestionMatch {
  const normalized = normalizeForMatch(candidate);
  const exact = questions.find((question) => normalizeForMatch(question.normText || question.text) === normalized);
  if (exact) return { questionId: exact.id, method: "exact", confidence: 1, margin: 1 };
  const alias = aliases.find((item) => normalizeForMatch(item.normalizedAlias || item.aliasText) === normalized);
  if (alias) return { questionId: alias.questionId, method: "alias", confidence: 1, margin: 1 };

  const ranked = questions
    .map((question) => ({ questionId: question.id, score: similarity(normalized, normalizeForMatch(question.normText || question.text)) }))
    .sort((a, b) => b.score - a.score);
  const best = ranked[0] ?? { questionId: "", score: 0 };
  const second = ranked[1]?.score ?? 0;
  const margin = best.score - second;
  if (best.score >= 0.92 && margin >= 0.08) {
    return { questionId: best.questionId, method: "fuzzy", confidence: best.score, margin };
  }
  return { questionId: null, method: "personal_import", confidence: best.score, margin };
}

function normalizedWithMap(input: string): { text: string; map: number[] } {
  let text = "";
  const map: number[] = [];
  let pendingSpace = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index].normalize("NFKC").toLowerCase();
    if (/[\p{L}\p{N}']/u.test(char)) {
      if (pendingSpace && text.length) {
        text += " ";
        map.push(index);
      }
      text += char;
      map.push(index);
      pendingSpace = false;
    } else {
      pendingSpace = true;
    }
  }
  return { text, map };
}

type Anchor = {
  start: number;
  end: number;
  rawQuestion: string;
  questionId: string | null;
  method: QuestionMatch["method"];
  confidence: number;
};

function directAnchors(text: string, questions: QuestionForMatch[], aliases: QuestionAliasForMatch[]): Anchor[] {
  const normalizedSource = normalizedWithMap(text);
  const candidates = [
    ...questions.map((question) => ({ questionId: question.id, value: question.normText || question.text, method: "exact" as const })),
    ...aliases.map((alias) => ({ questionId: alias.questionId, value: alias.normalizedAlias || alias.aliasText, method: "alias" as const })),
  ];
  const anchors: Anchor[] = [];
  for (const candidate of candidates) {
    const needle = normalizeForMatch(candidate.value);
    if (needle.length < 12) continue;
    let from = 0;
    while (from < normalizedSource.text.length) {
      const found = normalizedSource.text.indexOf(needle, from);
      if (found < 0) break;
      const start = normalizedSource.map[found];
      const end = (normalizedSource.map[found + needle.length - 1] ?? start) + 1;
      anchors.push({
        start,
        end,
        rawQuestion: text.slice(start, end),
        questionId: candidate.questionId,
        method: candidate.method,
        confidence: 1,
      });
      from = found + Math.max(needle.length, 1);
    }
  }
  return anchors;
}

function markerAnchors(text: string, questions: QuestionForMatch[], aliases: QuestionAliasForMatch[]): Anchor[] {
  const pattern = /(?:the\s+(?:first|second|third|fourth|fifth|sixth|next)\s+question(?:\s+is|,)|the\s+question\s+is|question\s+is)[\s,:-]*([^?\r\n]{5,240}\?)/giu;
  const anchors: Anchor[] = [];
  for (const match of text.matchAll(pattern)) {
    const rawQuestion = match[1];
    const full = match[0];
    const fullStart = match.index ?? 0;
    const relative = full.lastIndexOf(rawQuestion);
    const start = fullStart + Math.max(relative, 0);
    const end = start + rawQuestion.length;
    const resolved = matchQuestion(rawQuestion, questions, aliases);
    anchors.push({ start, end, rawQuestion, questionId: resolved.questionId, method: resolved.method, confidence: resolved.confidence });
  }
  return anchors;
}

function classifyBody(raw: string, questionId: string | null, attemptNo: number): SegmentType {
  const normalized = normalizeForMatch(raw);
  if (!normalized) return "instruction";
  if (/\b(?:messed me up|change the question|let'?s change the question|i don'?t have)\b/i.test(raw) && raw.length < 900) {
    return "abandoned";
  }
  if (/\b(?:what(?:'s| is) my score|i performed worse|give me (?:a )?(?:score|feedback)|evaluate my)\b/i.test(raw) && raw.length < 900) {
    return "self_comment";
  }
  if (/\bplease (?:ask|act|give|review|correct|summarize)|\bi hope you could\b/i.test(raw) && raw.length < 1200) {
    return "instruction";
  }
  if (!questionId) return /\b(?:uh|um|unclear|inaudible)\b/i.test(raw) ? "asr_uncertain" : "unclassified";
  return attemptNo > 0 ? "retry_answer" : "answer";
}

export function segmentTranscript(
  importId: string,
  text: string,
  questions: QuestionForMatch[],
  aliases: QuestionAliasForMatch[],
): ImportSegment[] {
  const ranked = [...directAnchors(text, questions, aliases), ...markerAnchors(text, questions, aliases)]
    .sort((a, b) => a.start - b.start || (a.method === "exact" ? -1 : 1) || (b.end - b.start) - (a.end - a.start));
  const anchors: Anchor[] = [];
  for (const anchor of ranked) {
    const previous = anchors.at(-1);
    if (previous && anchor.start < previous.end) {
      if (anchor.start === previous.start && anchor.end > previous.end && anchor.method === previous.method) anchors[anchors.length - 1] = anchor;
      continue;
    }
    anchors.push(anchor);
  }

  const segments: ImportSegment[] = [];
  const attempts = new Map<string, number>();
  let cursor = 0;
  let currentQuestionId: string | null = null;
  let currentQuestionMethod: QuestionMatch["method"] | null = null;
  let currentConfidence: number | null = null;

  const push = (start: number, end: number, type: SegmentType, questionId: string | null, method: QuestionMatch["method"] | null, confidence: number | null) => {
    if (end <= start) return;
    const rawText = text.slice(start, end);
    segments.push(ImportSegmentSchema.parse({
      id: stableId("seg", importId, start, end, type),
      sourceOrder: segments.length,
      startOffset: start,
      endOffset: end,
      type,
      rawText,
      normalizedText: normalizeForMatch(rawText),
      questionId,
      matchMethod: method,
      matchConfidence: confidence,
    }));
  };

  for (const anchor of anchors) {
    if (anchor.start > cursor) {
      const attemptNo = currentQuestionId ? attempts.get(currentQuestionId) ?? 0 : 0;
      const body = text.slice(cursor, anchor.start);
      let bodyQuestionId = currentQuestionId;
      let bodyMethod = currentQuestionMethod;
      let bodyConfidence = currentConfidence;
      let type = classifyBody(body, currentQuestionId, attemptNo);
      if (!currentQuestionId && type === "unclassified") {
        if (normalizeForMatch(body).length >= 120) {
          type = "answer";
          bodyQuestionId = stableId("q_personal", importId, "opening_answer");
          bodyMethod = "personal_import";
          bodyConfidence = 0;
        } else {
          type = "instruction";
        }
      }
      push(cursor, anchor.start, type, bodyQuestionId, bodyMethod, bodyConfidence);
      if ((type === "answer" || type === "retry_answer") && bodyQuestionId) attempts.set(bodyQuestionId, attemptNo + 1);
    }

    currentQuestionId = anchor.questionId ?? stableId("q_personal", importId, anchor.rawQuestion);
    currentQuestionMethod = anchor.questionId ? anchor.method : "personal_import";
    currentConfidence = anchor.confidence;
    push(anchor.start, anchor.end, "question", currentQuestionId, currentQuestionMethod, currentConfidence);
    cursor = anchor.end;
  }

  if (cursor < text.length) {
    const attemptNo = currentQuestionId ? attempts.get(currentQuestionId) ?? 0 : 0;
    const body = text.slice(cursor);
    let type = classifyBody(body, currentQuestionId, attemptNo);
    let bodyQuestionId = currentQuestionId;
    let bodyMethod = currentQuestionMethod;
    let bodyConfidence = currentConfidence;
    if (!currentQuestionId && type === "unclassified") {
      if (normalizeForMatch(body).length >= 120) {
        type = "answer";
        bodyQuestionId = stableId("q_personal", importId, "opening_answer");
        bodyMethod = "personal_import";
        bodyConfidence = 0;
      } else {
        type = "instruction";
      }
    }
    push(cursor, text.length, type, bodyQuestionId, bodyMethod, bodyConfidence);
  }

  if (!segments.length && text.length) {
    push(0, text.length, "unclassified", null, null, null);
  }
  return segments;
}

export function normalizeTranscript(input: string): string {
  return input
    .replace(/\s+/g, " ")
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/([.!?])(?=[A-Z])/g, "$1 ")
    .trim();
}

export function detectInputLanguage(input: string): "zh" | "en" | "mixed" {
  const hasCjk = /[\p{Script=Han}]/u.test(input);
  const hasLatin = /[A-Za-z]/.test(input);
  return hasCjk && hasLatin ? "mixed" : hasCjk ? "zh" : "en";
}

export function splitAnswerSentences(input: string): string[] {
  return normalizeTranscript(input)
    .split(/(?<=[.!?。！？])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/** 无第三方依赖的最小 DOCX 读取器，只读取 word/document.xml。 */
export function extractDocxText(buffer: Buffer): string {
  let eocd = -1;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65_557); offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error("DOCX ZIP 目录不存在");
  const entryCount = buffer.readUInt16LE(eocd + 10);
  let cursor = buffer.readUInt32LE(eocd + 16);
  for (let entry = 0; entry < entryCount; entry += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error("DOCX ZIP 中央目录损坏");
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const fileNameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const fileName = buffer.subarray(cursor + 46, cursor + 46 + fileNameLength).toString("utf8");
    if (fileName === "word/document.xml") {
      if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("DOCX ZIP 本地文件头损坏");
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
      const xml = (method === 0 ? compressed : method === 8 ? inflateRawSync(compressed) : null)?.toString("utf8");
      if (!xml) throw new Error("DOCX 使用了不支持的压缩方式");
      return decodeXml(
        xml
          .replace(/<w:tab\s*\/>/g, "\t")
          .replace(/<w:br\s*\/>/g, "\n")
          .replace(/<\/w:p>/g, "\n")
          .replace(/<[^>]+>/g, ""),
      )
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    }
    cursor += 46 + fileNameLength + extraLength + commentLength;
  }
  throw new Error("DOCX 中缺少 word/document.xml");
}
