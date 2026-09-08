/**
 * quality_review 阶段：由独立 Reviewer 对已补全的 Chunk 做八维终审。
 * chunks.quality_status: pending_review → approved | edited | rejected
 */
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getDbReady } from "../../../db/client";
import { chunkExamples, chunkPronunciations, chunks, chunkSources } from "../../../db/schema";
import { qualityBatchOutputSchema } from "../lib/schemas";
import { applyBatches, createBatches, listPendingBatches, moveBatch, type BatchFile } from "../lib/queue";
import { batchInputHash, stableJson, verifyAgentReviewerEvidence, verifyArtifact } from "../agent/evidence";
import fs from 'node:fs';
import path from 'node:path';
import { QUEUE_DIR } from '../lib/queue';

export const QUALITY_PROMPT_VERSION = "quality_review-v3";

interface ReviewExampleInput {
  exampleId: string;
  textEn: string;
  textZh: string;
  contextType: string;
  generated: boolean;
  sourceSentenceId: string | null;
  questionIds: string[];
}

interface ReviewSourceInput {
  sourceType: string;
  bookId: string;
  questionId: string | null;
  sentenceId: string | null;
  sourceContext: string;
}

interface ReviewPronunciationInput {
  pronunciationId: string;
  ipa: string;
  accent: string;
  source: string;
}

export interface ReviewInput {
  unitKey: string;
  chunkId: string;
  displayChunk: string;
  unitType: string;
  meaningZh: string;
  englishGloss: string;
  difficulty: string;
  examples: ReviewExampleInput[];
  sources: ReviewSourceInput[];
  pronunciations: ReviewPronunciationInput[];
}

function completeForReview(input: ReviewInput): boolean {
  return (
    input.englishGloss.trim().length > 0 &&
    input.examples.length > 0 &&
    input.examples.every((example) => Boolean(example.textEn.trim() && example.textZh.trim())) &&
    input.sources.length > 0 &&
    input.pronunciations.some((pronunciation) => pronunciation.ipa.trim())
  );
}

function parseQuestionIds(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export async function qualityCreate(maxBatches = 50): Promise<number> {
  for (const batch of listPendingBatches<ReviewInput, unknown>("quality_review")) {
    if (batch.promptVersion !== QUALITY_PROMPT_VERSION) {
      moveBatch(batch, "rejected", `Prompt 版本过期：${batch.promptVersion}，已由 ${QUALITY_PROMPT_VERSION} 重建`);
      continue;
    }
    if (!batch.inputs.every(completeForReview)) {
      moveBatch(batch, "rejected", "输入尚未完成英文简释、全部例句中译、IPA 或来源补齐，禁止提前进入 Reviewer");
    }
  }

  const units = (await getReviewInputs()).filter((input) => completeForReview(input));
  const db = await getDbReady();
  const pending = new Set((await db.select({ id: chunks.id }).from(chunks).where(eq(chunks.qualityStatus, 'pending_review'))).map((row) => row.id));
  return createBatches<ReviewInput, unknown>({
    stage: 'quality_review', promptVersion: QUALITY_PROMPT_VERSION,
    units: units.filter((input) => pending.has(input.chunkId)), batchSize: 14, maxBatches,
    getUnitKey: (unit) => unit.unitKey,
  });
}

/** 发布与 apply 共享当前内容快照，避免审核后修改内容仍沿用旧证据。 */
export async function getReviewInputs(): Promise<ReviewInput[]> {
  const db = await getDbReady();
  const [rows, exampleRows, sourceRows, pronunciationRows] = await Promise.all([
    db.select().from(chunks).where(sql`${chunks.bookId} IN (SELECT id FROM books WHERE source_type != 'personal_answers')`),
    db.select().from(chunkExamples),
    db.select().from(chunkSources),
    db.select().from(chunkPronunciations),
  ]);
  const examplesByChunk = new Map<string, typeof exampleRows>();
  for (const example of exampleRows) {
    const values = examplesByChunk.get(example.chunkId) ?? [];
    values.push(example);
    examplesByChunk.set(example.chunkId, values);
  }
  const sourcesByChunk = new Map<string, typeof sourceRows>();
  for (const source of sourceRows) {
    const values = sourcesByChunk.get(source.chunkId) ?? [];
    values.push(source);
    sourcesByChunk.set(source.chunkId, values);
  }
  const pronunciationsByChunk = new Map<string, typeof pronunciationRows>();
  for (const pronunciation of pronunciationRows) {
    const values = pronunciationsByChunk.get(pronunciation.chunkId) ?? [];
    values.push(pronunciation);
    pronunciationsByChunk.set(pronunciation.chunkId, values);
  }

  const units: ReviewInput[] = rows
    .map((row) => ({
      unitKey: row.id,
      chunkId: row.id,
      displayChunk: row.displayChunk,
      unitType: row.unitType,
      meaningZh: row.meaningZh,
      englishGloss: row.englishGloss,
      difficulty: row.difficulty,
      examples: (examplesByChunk.get(row.id) ?? [])
        .sort((a, b) => a.sort - b.sort)
        .map((example) => ({
          exampleId: example.id,
          textEn: example.textEn,
          textZh: example.textZh,
          contextType: example.contextType,
          generated: example.generated === 1,
          sourceSentenceId: example.sourceSentenceId,
          questionIds: parseQuestionIds(example.questionIdsJson),
        })),
      sources: (sourcesByChunk.get(row.id) ?? []).map((source) => ({
        sourceType: source.sourceType,
        bookId: source.bookId,
        questionId: source.questionId,
        sentenceId: source.sentenceId,
        sourceContext: source.sourceContext,
      })),
      pronunciations: (pronunciationsByChunk.get(row.id) ?? []).map((pronunciation) => ({
        pronunciationId: pronunciation.id,
        ipa: pronunciation.ipa,
        accent: pronunciation.accent,
        source: pronunciation.source,
      })),
    }));

  return units;
}

export async function qualityApply(
  batchIds?: ReadonlySet<string>,
): Promise<{ applied: number; rejected: number; pending: number }> {
  /**
   * 此入口只发布公共内容，必须使用离线独立 Agent 证据；Runtime 私人内容另走应用服务。
   */
  const verifyReviewerEvidence = async (
    batch: BatchFile<ReviewInput, z.infer<typeof qualityBatchOutputSchema>>,
    reviewer: { provider: string; model: string; runId: string },
  ): Promise<string | null> => {
    if (reviewer.provider === "deepseek") {
      return '公共内容禁止使用 Runtime Reviewer，请通过独立离线 Agent 审核';
    }
    if (reviewer.provider === "codex_agent") {
      return verifyAgentReviewerEvidence({
        runId: reviewer.runId,
        batchId: batch.batchId,
        inputSha256: batchInputHash(batch),
        provider: reviewer.provider,
        model: reviewer.model,
      });
    }
    return `未知 Reviewer provider：${reviewer.provider}；只允许 deepseek 或 codex_agent`;
  };

  return applyBatches<ReviewInput, z.infer<typeof qualityBatchOutputSchema>>({
    stage: "quality_review",
    batchIds,
    outputSchema: qualityBatchOutputSchema,
    transactional: true,
    crossCheck: async (batch, output) => {
      if (batch.promptVersion !== QUALITY_PROMPT_VERSION) {
        return `Prompt 版本过期：${batch.promptVersion}，必须用 ${QUALITY_PROMPT_VERSION} 重新审查`;
      }
      if (!batch.inputs.every(completeForReview)) return "输入尚未补全，不能形成 Reviewer 裁决";
      const reviewerError = await verifyReviewerEvidence(batch, output.reviewer);
      if (reviewerError) return reviewerError;
      const currentInputs = new Map((await getReviewInputs()).map((input) => [input.chunkId, input]));
      for (const input of batch.inputs) {
        const current = currentInputs.get(input.chunkId);
        if (!current || !sameReviewInput(input, current)) return `${input.chunkId} 当前内容与审核输入不一致，必须重新审核`;
      }
      const inputById = new Map(batch.inputs.map((input) => [input.chunkId, input]));
      const seen = new Set<string>();
      for (const verdict of output.verdicts) {
        const input = inputById.get(verdict.chunkId);
        if (!input) return `verdict.chunkId ${verdict.chunkId} 不在本批输入中`;
        if (seen.has(verdict.chunkId)) return `verdict.chunkId ${verdict.chunkId} 重复`;
        seen.add(verdict.chunkId);
        if (verdict.verdict === "rejected" && !verdict.reason.trim()) {
          return `${verdict.chunkId} rejected 必须说明原因`;
        }
        if (
          verdict.verdict !== "edited" &&
          (verdict.edited || verdict.exampleEdits?.length || verdict.pronunciationEdits?.length)
        ) {
          return `${verdict.chunkId} 只有 edited 裁决可以携带修改`;
        }
        if (
          verdict.verdict === "edited" &&
          !verdict.edited &&
          !verdict.exampleEdits?.length &&
          !verdict.pronunciationEdits?.length
        ) {
          return `${verdict.chunkId} edited 必须提供至少一项修改`;
        }
        const exampleIds = new Set(input.examples.map((example) => example.exampleId));
        const editedExamples = new Set<string>();
        for (const edit of verdict.exampleEdits ?? []) {
          if (!exampleIds.has(edit.exampleId)) return `例句 ${edit.exampleId} 不属于 ${verdict.chunkId}`;
          if (editedExamples.has(edit.exampleId)) return `例句 ${edit.exampleId} 修改重复`;
          if (!edit.textEn && !edit.textZh) return `例句 ${edit.exampleId} 没有实际修改字段`;
          editedExamples.add(edit.exampleId);
        }
        const pronunciationIds = new Set(
          input.pronunciations.map((pronunciation) => pronunciation.pronunciationId),
        );
        const editedPronunciations = new Set<string>();
        for (const edit of verdict.pronunciationEdits ?? []) {
          if (!pronunciationIds.has(edit.pronunciationId)) {
            return `发音 ${edit.pronunciationId} 不属于 ${verdict.chunkId}`;
          }
          if (editedPronunciations.has(edit.pronunciationId)) {
            return `发音 ${edit.pronunciationId} 修改重复`;
          }
          editedPronunciations.add(edit.pronunciationId);
        }
      }
      for (const chunkId of inputById.keys()) {
        if (!seen.has(chunkId)) return `缺少 ${chunkId} 的独立 Reviewer 裁决`;
      }
      return null;
    },
    apply: async (_batch, output) => {
      const db = await getDbReady();
      const reviewerEvidence = [
        QUALITY_PROMPT_VERSION,
        output.reviewer.provider,
        output.reviewer.model,
        output.reviewer.runId,
      ].join("|");
      for (const verdict of output.verdicts) {
        if (verdict.verdict === "edited") {
          const edit = verdict.edited;
          await db
            .update(chunks)
            .set({
              ...(edit?.displayChunk ? { displayChunk: edit.displayChunk } : {}),
              ...(edit?.meaningZh ? { meaningZh: edit.meaningZh } : {}),
              ...(edit?.englishGloss ? { englishGloss: edit.englishGloss } : {}),
              ...(edit?.difficulty ? { difficulty: edit.difficulty } : {}),
              qualityStatus: "edited",
              reviewProvenance: "independent_reviewer",
              reviewerVersion: reviewerEvidence,
              reviewedAt: new Date().toISOString(),
              rejectReason: null,
              updatedAt: new Date().toISOString(),
            })
            .where(eq(chunks.id, verdict.chunkId));
          for (const exampleEdit of verdict.exampleEdits ?? []) {
            await db
              .update(chunkExamples)
              .set({
                ...(exampleEdit.textEn ? { textEn: exampleEdit.textEn } : {}),
                ...(exampleEdit.textZh ? { textZh: exampleEdit.textZh } : {}),
              })
              .where(eq(chunkExamples.id, exampleEdit.exampleId));
          }
          for (const pronunciationEdit of verdict.pronunciationEdits ?? []) {
            await db
              .update(chunkPronunciations)
              .set({ ipa: pronunciationEdit.ipa })
              .where(eq(chunkPronunciations.id, pronunciationEdit.pronunciationId));
          }
        } else {
          await db
            .update(chunks)
            .set({
              qualityStatus: verdict.verdict === "approved" ? "approved" : "rejected",
              reviewProvenance: "independent_reviewer",
              reviewerVersion: reviewerEvidence,
              reviewedAt: new Date().toISOString(),
              rejectReason: verdict.verdict === "rejected" ? verdict.reason : null,
              updatedAt: new Date().toISOString(),
            })
            .where(eq(chunks.id, verdict.chunkId));
        }
      }
    },
  });
}

function normalizedReviewInput(input: ReviewInput) {
  return { ...input,
    examples: input.examples.slice().sort((a, b) => a.exampleId.localeCompare(b.exampleId)),
    sources: input.sources.slice().sort((a, b) => stableJson(a).localeCompare(stableJson(b))),
    pronunciations: input.pronunciations.slice().sort((a, b) => a.pronunciationId.localeCompare(b.pronunciationId)),
  };
}
export function sameReviewInput(a: ReviewInput, b: ReviewInput): boolean {
  return stableJson(normalizedReviewInput(a)) === stableJson(normalizedReviewInput(b));
}

/** 对当前发布内容逐条核对裁决、版本、快照及编辑后的内容。只返回 ID/原因，不输出原文。 */
export async function auditPublicationEvidence(): Promise<Array<{ chunkId: string; reason: string }>> {
  const db = await getDbReady();
  const published = await db.select().from(chunks).where(sql`${chunks.qualityStatus} IN ('approved','edited') AND ${chunks.bookId} IN (SELECT id FROM books WHERE source_type != 'personal_answers')`);
  const inputs = new Map((await getReviewInputs()).map((input) => [input.chunkId, input]));
  const failures: Array<{ chunkId: string; reason: string }> = [];
  const verified = new Map<string, ReturnType<typeof verifyArtifact>>();
  for (const chunk of published) {
    try {
      if (chunk.reviewProvenance !== 'independent_reviewer' || !chunk.reviewedAt) throw new Error('缺少可验证的独立 Reviewer');
      const [version, provider, model, runId, extra] = (chunk.reviewerVersion ?? '').split('|');
      if (version !== QUALITY_PROMPT_VERSION || provider !== 'codex_agent' || model !== 'development-agent' || !runId || extra) throw new Error('审核版本/身份缺失或过期');
      const cp = verified.get(runId) ?? verifyArtifact(runId);
      verified.set(runId, cp);
      if (cp.status !== 'applied' || cp.stage !== 'quality_review' || cp.role !== 'reviewer' || cp.promptVersion !== version) throw new Error('裁决未应用或版本不符');
      const batch = JSON.parse(fs.readFileSync(path.join(QUEUE_DIR, 'quality_review', 'done', `${cp.batchId}.json`), 'utf8')) as BatchFile<ReviewInput, unknown>;
      const output = qualityBatchOutputSchema.parse(batch.output);
      if (output.reviewer.runId !== runId || output.reviewer.provider !== provider || output.reviewer.model !== model) throw new Error('队列裁决身份与发布记录不一致');
      const verdicts = output.verdicts.filter((item) => item.chunkId === chunk.id);
      const input = batch.inputs.find((item) => item.chunkId === chunk.id);
      if (!input || verdicts.length !== 1 || verdicts[0].verdict !== chunk.qualityStatus) throw new Error('缺少本条唯一裁决或状态不符');
      const verdict = verdicts[0];
      const expected: ReviewInput = { ...input, ...verdict.edited,
        examples: input.examples.map((item) => ({ ...item, ...verdict.exampleEdits?.find((edit) => edit.exampleId === item.exampleId) })),
        pronunciations: input.pronunciations.map((item) => ({ ...item, ...verdict.pronunciationEdits?.find((edit) => edit.pronunciationId === item.pronunciationId) })),
      };
      const current = inputs.get(chunk.id);
      if (!current || !sameReviewInput(expected, current)) throw new Error('当前内容已偏离审核快照');
    } catch (error) {
      failures.push({ chunkId: chunk.id, reason: error instanceof Error ? error.message : '证据无法核验' });
    }
  }
  return failures;
}
