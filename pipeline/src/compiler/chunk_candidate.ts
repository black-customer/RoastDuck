/**
 * chunk_candidate 阶段：question/topic/sentence 三类单元 → Chunk 候选（LLM 批次队列）。
 * questions.status: blueprint_done → chunked
 * topics.status: domains_done → chunked
 * source_sentences.status: pending → chunked | no_new_unit
 * chunks 写入走 insertOrMergeChunk（写入即去重）。
 */
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDbReady } from "../../../db/client";
import { questions, sourceSentences, topics } from "../../../db/schema";
import {
  chunkCandidateBatchOutputSchema,
  type ChunkCandidateItem,
} from "../lib/schemas";
import { applyBatches, createBatches } from "../lib/queue";
import { canonicalize } from "../lib/canonical";
import { insertOrMergeChunk, type CoverageRef } from "./chunkRepo";

export const CHUNK_CANDIDATE_PROMPT_VERSION = "chunk_candidate-v2";

type Unit = { unitKey: string } & (
  | {
      kind: "question";
      questionId: string;
      questionText: string;
      part: number;
      topicNameZh: string;
      topicNameEn: string;
      dimensions: Array<{ dimId: string; dimZh: string; dimEn: string }>;
    }
  | {
      kind: "topic";
      topicId: string;
      topicNameZh: string;
      topicNameEn: string;
      domains: Array<{ domainId: string; nameZh: string; nameEn: string }>;
    }
  | { kind: "sentence"; sentenceId: string; text: string; context: string }
);

export const CONTENT_VERSION = "v0.1.0";

export async function chunkCandidateCreate(opts: {
  questions?: boolean;
  topics?: boolean;
  sentences?: boolean;
  maxBatches?: number;
}): Promise<number> {
  const db = await getDbReady();
  let created = 0;
  const max = opts.maxBatches ?? 50;

  if (opts.questions) {
    const rows = await db.select().from(questions).where(eq(questions.status, "blueprint_done"));
    const units: Unit[] = [];
    for (const q of rows) {
      const dims = JSON.parse(q.blueprintJson) as Array<{ dimId: string; dimZh: string; dimEn: string }>;
      if (!dims.length) continue;
      const [topic] = q.topicId ? await db.select().from(topics).where(eq(topics.id, q.topicId)).limit(1) : [];
      units.push({
        kind: "question",
        unitKey: `q|${q.id}`,
        questionId: q.id,
        questionText: q.text,
        part: q.part,
        topicNameZh: topic?.nameZh ?? "",
        topicNameEn: topic?.nameEn ?? "",
        dimensions: dims,
      });
    }
    created += createBatches<Unit, unknown>({
      stage: "chunk_candidate",
      promptVersion: CHUNK_CANDIDATE_PROMPT_VERSION,
      units,
      batchSize: 6,
      maxBatches: max,
      getUnitKey: (u) => u.unitKey,
    });
  }

  if (opts.topics) {
    const rows = await db.select().from(topics).where(eq(topics.status, "domains_done"));
    const units: Unit[] = [];
    for (const t of rows) {
      const domains = JSON.parse(t.domainsJson) as Array<{ domainId: string; nameZh: string; nameEn: string }>;
      if (!domains.length) continue;
      units.push({
        kind: "topic",
        unitKey: `t|${t.id}`,
        topicId: t.id,
        topicNameZh: t.nameZh,
        topicNameEn: t.nameEn,
        domains,
      });
    }
    created += createBatches<Unit, unknown>({
      stage: "chunk_candidate",
      promptVersion: CHUNK_CANDIDATE_PROMPT_VERSION,
      units,
      batchSize: 2,
      maxBatches: max,
      getUnitKey: (u) => u.unitKey,
    });
  }

  if (opts.sentences) {
    const rows = await db.select().from(sourceSentences).where(eq(sourceSentences.status, "pending"));
    const units: Unit[] = rows.map((s) => ({
      kind: "sentence" as const,
      unitKey: `s|${s.id}`,
      sentenceId: s.id,
      text: s.text,
      context: s.questionId ?? "",
    }));
    created += createBatches<Unit, unknown>({
      stage: "chunk_candidate",
      promptVersion: CHUNK_CANDIDATE_PROMPT_VERSION,
      units,
      batchSize: 40,
      maxBatches: max,
      getUnitKey: (u) => u.unitKey,
    });
  }
  return created;
}

async function applyItem(item: ChunkCandidateItem, unit: Unit): Promise<void> {
  const db = await getDbReady();
  if (unit.kind === "sentence") {
    if (item.alreadyProcessed) {
      // 该句已由其他批次处理，保持 DB 现状
      return;
    }
    if (item.chunks.length === 0 && item.coveredBy && item.coveredBy.length > 0) {
      await db
        .update(sourceSentences)
        .set({ status: "covered", coveredByJson: JSON.stringify(item.coveredBy) })
        .where(eq(sourceSentences.id, unit.sentenceId));
      return;
    }
    if (item.chunks.length === 0) {
      await db
        .update(sourceSentences)
        .set({
          status: "no_new_unit",
          noNewUnitReason: item.noNewUnitReason ?? "未标注原因",
        })
        .where(eq(sourceSentences.id, unit.sentenceId));
      return;
    }
    const [sentence] = await db.select().from(sourceSentences).where(eq(sourceSentences.id, unit.sentenceId)).limit(1);
    for (const c of item.chunks) {
      const canonical = canonicalize(c.displayChunk);
      if (!canonical) continue;
      await insertOrMergeChunk({
        bookId: sentence.bookId,
        displayChunk: c.displayChunk,
        canonicalChunk: canonical,
        unitType: c.unitType,
        meaningZh: c.meaningZh,
        englishGloss: c.englishGloss,
        pattern: c.pattern ?? null,
        variants: c.variants,
        exampleEn: c.exampleEn,
        exampleZh: c.exampleZh,
        difficulty: c.difficulty,
        tags: c.tags,
        contentVersion: CONTENT_VERSION,
        source: {
          sourceType: "demo_answer",
          sentenceId: unit.sentenceId,
          questionId: sentence.questionId,
          context: sentence.questionId ?? "",
        },
        coverageRefs: [],
      });
    }
    await db.update(sourceSentences).set({ status: "chunked" }).where(eq(sourceSentences.id, unit.sentenceId));
    return;
  }

  if (unit.kind === "question") {
    for (const c of item.chunks) {
      const canonical = canonicalize(c.displayChunk);
      if (!canonical) continue;
      const refs: CoverageRef[] = c.dimIds
        .filter((d) => unit.dimensions.some((ud) => ud.dimId === d))
        .map<CoverageRef>((d) => ({ refType: "question_dimension", questionId: unit.questionId, dimId: d }));
      await insertOrMergeChunk({
        bookId: "book1_ielts_complete",
        displayChunk: c.displayChunk,
        canonicalChunk: canonical,
        unitType: c.unitType,
        meaningZh: c.meaningZh,
        englishGloss: c.englishGloss,
        pattern: c.pattern ?? null,
        variants: c.variants,
        exampleEn: c.exampleEn,
        exampleZh: c.exampleZh,
        difficulty: c.difficulty,
        tags: c.tags,
        contentVersion: CONTENT_VERSION,
        source: { sourceType: "question_bank", questionId: unit.questionId, context: unit.topicNameEn },
        coverageRefs: refs,
      });
    }
    await db.update(questions).set({ status: "chunked" }).where(eq(questions.id, unit.questionId));
    return;
  }

  // topic
  for (const c of item.chunks) {
    const canonical = canonicalize(c.displayChunk);
    if (!canonical) continue;
    const refs: CoverageRef[] = c.dimIds
      .filter((d) => unit.domains.some((ud) => ud.domainId === d))
      .map<CoverageRef>((d) => ({ refType: "topic_domain", topicId: unit.topicId, domainId: d }));
    await insertOrMergeChunk({
      bookId: "book1_ielts_complete",
      displayChunk: c.displayChunk,
      canonicalChunk: canonical,
      unitType: c.unitType,
      meaningZh: c.meaningZh,
      englishGloss: c.englishGloss,
      pattern: c.pattern ?? null,
      variants: c.variants,
      exampleEn: c.exampleEn,
      exampleZh: c.exampleZh,
      difficulty: c.difficulty,
      tags: c.tags,
      contentVersion: CONTENT_VERSION,
      source: { sourceType: "question_bank", context: unit.topicNameEn },
      coverageRefs: refs,
    });
  }
  await db.update(topics).set({ status: "chunked" }).where(eq(topics.id, unit.topicId));
}

export async function chunkCandidateApply(): Promise<{ applied: number; rejected: number; pending: number }> {
  return applyBatches<Unit, z.infer<typeof chunkCandidateBatchOutputSchema>>({
    stage: "chunk_candidate",
    outputSchema: chunkCandidateBatchOutputSchema,
    crossCheck: async (batch, output) => {
      const inputKeys = new Set(batch.inputs.map((i) => i.unitKey.split("|").pop()));
      const outputKeys = new Set(output.items.map((i) => i.unitKey.split("|").pop()));
      for (const k of outputKeys) {
        if (!inputKeys.has(k)) return `output unitKey ${k} 不在本批输入中`;
      }
      for (const k of inputKeys) {
        if (!outputKeys.has(k)) return `缺少输入单元 ${k} 的输出`;
      }
      for (const item of output.items) {
        const unit = batch.inputs.find((i) => i.unitKey.split("|").pop() === item.unitKey.split("|").pop());
        if (unit && unit.kind !== "sentence" && item.chunks.length === 0) {
          return `${item.unitKey} 无产出但未给 noNewUnitReason`;
        }
      }
      return null;
    },
    apply: async (batch, output) => {
      for (const item of output.items) {
        const unit = batch.inputs.find((i) => i.unitKey.split("|").pop() === item.unitKey.split("|").pop());
        if (!unit) continue;
        await applyItem(item, unit);
      }
    },
  });
}
