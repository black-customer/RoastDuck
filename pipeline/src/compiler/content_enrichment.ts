/**
 * content_enrichment 阶段：补齐 Chunk 英文简释与例句中文。
 *
 * 本阶段只做内容生成，不拥有发布裁决权；完成后仍必须进入独立
 * quality_review。输入会携带真实来源与 IELTS 关联，输出不能修改英文例句、
 * 来源或上下文类型。
 */
import { and, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { getDbReady } from "../../../db/client";
import {
  chunkExamples,
  chunkQuestionLinks,
  chunks,
  chunkSources,
  questions,
  topics,
} from "../../../db/schema";
import { contentEnrichmentBatchOutputSchema } from "../lib/schemas";
import { applyBatches, createBatches, listPendingBatches, moveBatch } from "../lib/queue";

export const CONTENT_ENRICHMENT_PROMPT_VERSION = "content_enrichment-v1";

interface EnrichmentExampleInput {
  exampleId: string;
  textEn: string;
  textZh: string;
  contextType: string;
  generated: boolean;
  sourceRef: string;
}

interface EnrichmentContextInput {
  questionId: string;
  questionText: string;
  part: number;
  topicNameZh: string;
  topicNameEn: string;
  relation: string;
  answerDimensionId: string;
}

interface EnrichmentSourceInput {
  sourceType: string;
  questionId: string | null;
  sentenceId: string | null;
  sourceContext: string;
}

export interface ContentEnrichmentInput {
  unitKey: string;
  chunkId: string;
  displayChunk: string;
  unitType: string;
  meaningZh: string;
  englishGloss: string;
  examples: EnrichmentExampleInput[];
  contexts: EnrichmentContextInput[];
  sources: EnrichmentSourceInput[];
}

function hasHan(value: string): boolean {
  return /\p{Script=Han}/u.test(value);
}

function blank(value: string): boolean {
  return value.trim().length === 0;
}

export async function contentEnrichmentCreate(maxBatches = 30): Promise<number> {
  for (const batch of listPendingBatches<ContentEnrichmentInput, unknown>("content_enrichment")) {
    if (batch.promptVersion !== CONTENT_ENRICHMENT_PROMPT_VERSION) {
      moveBatch(
        batch,
        "rejected",
        `Prompt 版本过期：${batch.promptVersion}，已由 ${CONTENT_ENRICHMENT_PROMPT_VERSION} 重建`,
      );
    }
  }

  const db = await getDbReady();
  const [chunkRows, exampleRows, sourceRows, linkRows, questionRows, topicRows] = await Promise.all([
    db.select().from(chunks).where(and(ne(chunks.qualityStatus, "rejected"), sql`${chunks.bookId} IN (SELECT id FROM books WHERE source_type != 'personal_answers')`)),
    db.select().from(chunkExamples),
    db.select().from(chunkSources),
    db.select().from(chunkQuestionLinks),
    db.select().from(questions),
    db.select().from(topics),
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
  const linksByChunk = new Map<string, typeof linkRows>();
  for (const link of linkRows) {
    const values = linksByChunk.get(link.chunkId) ?? [];
    values.push(link);
    linksByChunk.set(link.chunkId, values);
  }
  const questionById = new Map(questionRows.map((question) => [question.id, question]));
  const topicById = new Map(topicRows.map((topic) => [topic.id, topic]));

  const units: ContentEnrichmentInput[] = [];
  for (const chunk of chunkRows) {
    const examples = (examplesByChunk.get(chunk.id) ?? []).sort((a, b) => a.sort - b.sort);
    if (!blank(chunk.englishGloss) && examples.every((example) => !blank(example.textZh))) continue;

    const contexts = (linksByChunk.get(chunk.id) ?? []).flatMap((link) => {
      const question = questionById.get(link.questionId);
      if (!question) return [];
      const topic = question.topicId ? topicById.get(question.topicId) : undefined;
      return [
        {
          questionId: question.id,
          questionText: question.text,
          part: question.part,
          topicNameZh: topic?.nameZh ?? "",
          topicNameEn: topic?.nameEn ?? "",
          relation: link.relation,
          answerDimensionId: link.answerDimensionId,
        },
      ];
    });

    units.push({
      unitKey: chunk.id,
      chunkId: chunk.id,
      displayChunk: chunk.displayChunk,
      unitType: chunk.unitType,
      meaningZh: chunk.meaningZh,
      englishGloss: chunk.englishGloss,
      examples: examples.map((example) => ({
        exampleId: example.id,
        textEn: example.textEn,
        textZh: example.textZh,
        contextType: example.contextType,
        generated: example.generated === 1,
        sourceRef: example.sourceRef,
      })),
      contexts,
      sources: (sourcesByChunk.get(chunk.id) ?? []).map((source) => ({
        sourceType: source.sourceType,
        questionId: source.questionId,
        sentenceId: source.sentenceId,
        sourceContext: source.sourceContext,
      })),
    });
  }

  return createBatches<ContentEnrichmentInput, unknown>({
    stage: "content_enrichment",
    promptVersion: CONTENT_ENRICHMENT_PROMPT_VERSION,
    units,
    batchSize: 10,
    maxBatches,
    getUnitKey: (unit) => unit.unitKey,
  });
}

export async function contentEnrichmentApply(batchIds?: ReadonlySet<string>): Promise<{
  applied: number;
  rejected: number;
  pending: number;
}> {
  const db = await getDbReady();
  return applyBatches<ContentEnrichmentInput, z.infer<typeof contentEnrichmentBatchOutputSchema>>({
    stage: "content_enrichment",
    batchIds,
    outputSchema: contentEnrichmentBatchOutputSchema,
    crossCheck: async (batch, output) => {
      if (batch.promptVersion !== CONTENT_ENRICHMENT_PROMPT_VERSION) {
        return `Prompt 版本过期：${batch.promptVersion}，必须用 ${CONTENT_ENRICHMENT_PROMPT_VERSION} 重新生成`;
      }
      const inputById = new Map(batch.inputs.map((input) => [input.chunkId, input]));
      const seenChunks = new Set<string>();
      for (const item of output.items) {
        const input = inputById.get(item.chunkId);
        if (!input) return `items.chunkId ${item.chunkId} 不在本批输入中`;
        if (seenChunks.has(item.chunkId)) return `items.chunkId ${item.chunkId} 重复`;
        seenChunks.add(item.chunkId);

        if (blank(input.englishGloss)) {
          if (!item.englishGloss?.trim()) return `${item.chunkId} 缺少 englishGloss`;
          if (hasHan(item.englishGloss) || !/[A-Za-z]/.test(item.englishGloss)) {
            return `${item.chunkId} englishGloss 必须是英文简释`;
          }
        } else if (item.englishGloss !== undefined) {
          return `${item.chunkId} 已有 englishGloss，本阶段不得覆盖`;
        }

        const missingExampleIds = new Set(
          input.examples.filter((example) => blank(example.textZh)).map((example) => example.exampleId),
        );
        const seenExamples = new Set<string>();
        for (const translation of item.exampleTranslations) {
          if (!missingExampleIds.has(translation.exampleId)) {
            return `${item.chunkId} 的例句 ${translation.exampleId} 不缺翻译或不在本批输入中`;
          }
          if (seenExamples.has(translation.exampleId)) return `例句 ${translation.exampleId} 翻译重复`;
          if (!hasHan(translation.textZh)) return `例句 ${translation.exampleId} 的 textZh 必须包含中文`;
          seenExamples.add(translation.exampleId);
        }
        for (const exampleId of missingExampleIds) {
          if (!seenExamples.has(exampleId)) return `${item.chunkId} 缺少例句 ${exampleId} 的中文翻译`;
        }
      }
      for (const chunkId of inputById.keys()) {
        if (!seenChunks.has(chunkId)) return `缺少 ${chunkId} 的补全结果`;
      }
      return null;
    },
    apply: async (batch, output) => {
      const inputById = new Map(batch.inputs.map((input) => [input.chunkId, input]));
      for (const item of output.items) {
        const input = inputById.get(item.chunkId);
        if (!input) continue;
        if (blank(input.englishGloss) && item.englishGloss) {
          await db
            .update(chunks)
            .set({ englishGloss: item.englishGloss.trim(), updatedAt: new Date().toISOString() })
            .where(sql`${chunks.id} = ${item.chunkId} AND trim(${chunks.englishGloss}) = ''`);
        }
        for (const translation of item.exampleTranslations) {
          await db
            .update(chunkExamples)
            .set({ textZh: translation.textZh.trim() })
            .where(sql`${chunkExamples.id} = ${translation.exampleId} AND trim(${chunkExamples.textZh}) = ''`);
        }
      }
    },
  });
}
