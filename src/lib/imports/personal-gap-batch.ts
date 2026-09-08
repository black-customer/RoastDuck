import { createHash } from "node:crypto";
import { z } from "zod";
import { gapCandidateSchema } from "../answers/gap-contract";

export const GAP_BATCH_VERSION = "personal-gap-batch-v1";
export const gapHash = (text: string) => createHash("sha256").update(text).digest("hex");
export const gapId = (prefix: string, ...values: string[]) => `${prefix}_${gapHash(JSON.stringify(values)).slice(0, 24)}`;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().min(2).max(160);
const range = { start: z.number().int().nonnegative(), end: z.number().int().positive() };
const promptSchema = z.object({ version: id, sha256: hash });

export const gapBatchInputSchema = z.object({
  schemaVersion: z.literal(GAP_BATCH_VERSION), batchId: id,
  prompts: z.object({ generator: promptSchema, reviewer: promptSchema }),
  answers: z.array(z.object({
    answerId: id, answerVersionId: id, questionId: id,
    question: z.object({ textEn: z.string(), textZh: z.string(), part: z.number().int().min(1).max(3) }),
    rawText: z.string().min(1), rawSha256: hash, normalizedText: z.string(), versionSha256: hash,
    source: z.object({ importId: id, revisionId: id.nullable(), segmentId: id, startOffset: z.number().int().nonnegative(), endOffset: z.number().int().positive(), textSha256: hash }),
  })).min(1).max(10),
});

const runSchema = z.object({
  runId: id, sessionId: id, model: z.literal("development-agent"),
  inputSha256: hash, promptVersion: id, promptSha256: hash,
  noExternalRuntimeApi: z.literal(true), networkCalls: z.literal(0),
});
export const offlineGapCandidateSchema = z.object({
  ...range,
  clusterKey: z.string().regex(/^[a-z][a-z0-9_-]{2,99}$/),
  clusterTitleZh: z.string().min(2).max(160),
  gap: gapCandidateSchema,
});
const coverageSchema = z.array(z.object({
  ...range,
  status: z.enum(["diagnosed", "no_gap", "asr_uncertain", "not_answer", "unclassified"]),
  gapKeys: z.array(id), reason: z.string().trim().min(8).max(1000),
})).min(1).max(200);
export const gapBatchGenerationSchema = z.object({
  schemaVersion: z.literal(GAP_BATCH_VERSION), role: z.literal("gap_generator"), ...runSchema.shape,
  answers: z.array(z.object({ answerId: id, candidates: z.array(offlineGapCandidateSchema).max(100), coverage: coverageSchema })).min(1).max(10),
});
export const gapBatchReviewSchema = z.object({
  schemaVersion: z.literal(GAP_BATCH_VERSION), role: z.literal("gap_reviewer"), ...runSchema.shape,
  generationSha256: hash,
  answers: z.array(z.object({
    answerId: id, coverage: coverageSchema,
    coverageDecision: z.enum(["complete", "needs_revision"]), coverageReason: z.string().min(12).max(2000),
    items: z.array(z.object({
      key: id, verdict: z.enum(["approved", "edited", "rejected"]),
      evidenceQuote: z.string().min(1), reason: z.string().min(12).max(1500), candidate: offlineGapCandidateSchema,
    })).max(100),
  })).min(1).max(10),
});
export type GapBatchInput = z.infer<typeof gapBatchInputSchema>;
export type GapBatchGeneration = z.infer<typeof gapBatchGenerationSchema>;
export type GapBatchReview = z.infer<typeof gapBatchReviewSchema>;
export type OfflineGapCandidate = z.infer<typeof offlineGapCandidateSchema>;

function equalKeys(actual: string[], expected: string[], label: string) {
  const keys = new Set(actual);
  if (keys.size !== actual.length || keys.size !== expected.length || expected.some((key) => !keys.has(key))) throw new Error(`${label} 必须无重复且完整覆盖`);
}

function validateCandidate(raw: string, item: OfflineGapCandidate) {
  if (item.end <= item.start || item.end > raw.length || raw.slice(item.start, item.end) !== item.gap.evidenceText) throw new Error(`Gap ${item.gap.key} 的原文偏移不匹配`);
}

function validateCoverage(raw: string, coverage: z.infer<typeof coverageSchema>, candidates: OfflineGapCandidate[]) {
  const byKey = new Map(candidates.map((item) => [item.gap.key, item]));
  const covered = new Set<string>();
  let cursor = 0;
  for (const span of coverage) {
    if (span.start !== cursor || span.end <= span.start || span.end > raw.length) throw new Error("覆盖区间有遗漏、重叠或越界");
    if (span.status === "unclassified") throw new Error("仍有未分类的回答内容");
    if (["no_gap", "not_answer"].includes(span.status) && span.gapKeys.length) throw new Error("非 Gap 区间不能关联 Gap");
    if (["diagnosed", "asr_uncertain"].includes(span.status) && !span.gapKeys.length) throw new Error("问题区间缺少具体 Gap");
    if (new Set(span.gapKeys).size !== span.gapKeys.length) throw new Error("覆盖区间重复引用 Gap");
    for (const key of span.gapKeys) {
      const gap = byKey.get(key);
      if (!gap || gap.start >= span.end || gap.end <= span.start) throw new Error("覆盖引用了不存在或不相交的 Gap");
      if (span.status === "asr_uncertain" && gap.gap.gapType !== "asr_uncertain") throw new Error("不确定区间不得认定其他 Gap");
      covered.add(key);
    }
    cursor = span.end;
  }
  if (cursor !== raw.length || candidates.some((item) => !covered.has(item.gap.key))) throw new Error("原文或 Gap 尚未完整覆盖");
  // 不允许只覆盖一个词便把跨越整句的证据算作已审：整个证据都必须由对应分类承接。
  for (const item of candidates) {
    if (coverage.some((span) => span.start < item.end && span.end > item.start && !span.gapKeys.includes(item.gap.key))) throw new Error("Gap 证据有部分落在未关联的覆盖区间");
  }
}

export function validateGapBatch(inputValue: unknown, generationText: string, reviewText: string, inputText: string) {
  const input = gapBatchInputSchema.parse(inputValue);
  if (JSON.stringify(gapBatchInputSchema.parse(JSON.parse(inputText))) !== JSON.stringify(input)) throw new Error("输入文件与快照不一致");
  const generated = gapBatchGenerationSchema.parse(JSON.parse(generationText));
  const review = gapBatchReviewSchema.parse(JSON.parse(reviewText));
  if (generated.runId === review.runId || generated.sessionId === review.sessionId) throw new Error("Generator / Reviewer 必须使用独立运行和上下文");
  for (const [run, prompt] of [[generated, input.prompts.generator], [review, input.prompts.reviewer]] as const) {
    if (run.inputSha256 !== gapHash(inputText) || run.promptVersion !== prompt.version || run.promptSha256 !== prompt.sha256) throw new Error("输入或 Prompt 哈希/版本漂移");
  }
  if (input.prompts.generator.sha256 === input.prompts.reviewer.sha256) throw new Error("Generator / Reviewer 不能共用 Prompt");
  if (review.generationSha256 !== gapHash(generationText)) throw new Error("Reviewer 没有审核当前 Generator 产物");
  const ids = input.answers.map((a) => a.answerId);
  equalKeys(ids, [...new Set(ids)], "输入回答");
  equalKeys(generated.answers.map((a) => a.answerId), ids, "Generator 回答");
  equalKeys(review.answers.map((a) => a.answerId), ids, "Reviewer 回答");
  const reasons: string[] = [];
  let changed = 0;
  for (const answer of input.answers) {
    if (gapHash(answer.rawText) !== answer.rawSha256 || answer.source.endOffset - answer.source.startOffset !== answer.rawText.length) throw new Error("回答原文哈希或源偏移漂移");
    const g = generated.answers.find((a) => a.answerId === answer.answerId)!;
    const r = review.answers.find((a) => a.answerId === answer.answerId)!;
    equalKeys(g.candidates.map((c) => c.gap.key), [...new Set(g.candidates.map((c) => c.gap.key))], "候选 Gap");
    g.candidates.forEach((item) => validateCandidate(answer.rawText, item));
    validateCoverage(answer.rawText, g.coverage, g.candidates);
    equalKeys(r.items.map((item) => item.key), g.candidates.map((c) => c.gap.key), "Reviewer Gap");
    if (r.coverageDecision !== "complete") throw new Error(`回答 ${answer.answerId} 仍有遗漏，必须重新生成`);
    for (const item of r.items) {
      const original = g.candidates.find((c) => c.gap.key === item.key)!;
      if (item.key !== item.candidate.gap.key || !answer.rawText.includes(item.evidenceQuote) || !item.reason.includes(item.evidenceQuote) || !original.gap.evidenceText.includes(item.evidenceQuote)) throw new Error("Reviewer 必须引用当前候选的原句证据");
      validateCandidate(answer.rawText, item.candidate);
      const same = JSON.stringify(item.candidate) === JSON.stringify(original);
      if (item.verdict === "approved" && !same) throw new Error("修改候选必须标为 edited");
      if (item.verdict === "edited" && same) throw new Error("不能伪造零改动的 edited");
      if (item.verdict !== "approved") changed += 1;
      // 去掉逐项引用后检查完全重复套话；语义质量仍由独立 Reviewer 负责。
      reasons.push(item.reason.replaceAll(item.evidenceQuote, "").replace(/[\s\p{P}]/gu, ""));
    }
    validateCoverage(answer.rawText, r.coverage, r.items.filter((item) => item.verdict !== "rejected").map((item) => item.candidate));
  }
  if (reasons.length > 1 && new Set(reasons).size !== reasons.length) throw new Error("审核理由存在重复套话");
  if (reasons.length && changed === 0) throw new Error("整批全量零修改，需独立校准，不能直接入账");
  return { input, generated, review, inputSha256: gapHash(inputText), generationSha256: gapHash(generationText), reviewSha256: gapHash(reviewText) };
}

export type ValidatedGapBatch = ReturnType<typeof validateGapBatch>;
