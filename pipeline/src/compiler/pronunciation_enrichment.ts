/**
 * pronunciation_enrichment 阶段：为缺发音数据的 Chunk 生成指定口音 IPA。
 * 生成结果仍需经过独立 quality_review，不会直接变成已批准内容。
 */
import { and, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { getDbReady } from "../../../db/client";
import { books, chunkPronunciations, chunks, chunkSources } from "../../../db/schema";
import { pronunciationEnrichmentBatchOutputSchema } from "../lib/schemas";
import { applyBatches, createBatches, listPendingBatches, moveBatch } from "../lib/queue";

export const PRONUNCIATION_ENRICHMENT_PROMPT_VERSION = "pronunciation_enrichment-v1";

interface PronunciationInput {
  unitKey: string;
  chunkId: string;
  displayChunk: string;
  canonicalChunk: string;
  targetAccent: string;
  sources: Array<{ sourceType: string; sourceContext: string }>;
}

function invalidIpa(value: string): boolean {
  return /\p{Script=Han}/u.test(value) || !/[A-Za-z\p{Letter}]/u.test(value);
}

export async function pronunciationEnrichmentCreate(maxBatches = 20): Promise<number> {
  for (const batch of listPendingBatches<PronunciationInput, unknown>("pronunciation_enrichment")) {
    if (batch.promptVersion !== PRONUNCIATION_ENRICHMENT_PROMPT_VERSION) {
      moveBatch(
        batch,
        "rejected",
        `Prompt 版本过期：${batch.promptVersion}，已由 ${PRONUNCIATION_ENRICHMENT_PROMPT_VERSION} 重建`,
      );
    }
  }
  const db = await getDbReady();
  const [chunkRows, pronunciationRows, sourceRows, bookRows] = await Promise.all([
    db.select().from(chunks).where(and(ne(chunks.qualityStatus, "rejected"), sql`${chunks.bookId} IN (SELECT id FROM books WHERE source_type != 'personal_answers')`)),
    db.select().from(chunkPronunciations),
    db.select().from(chunkSources),
    db.select().from(books),
  ]);
  const chunksWithPronunciation = new Set(
    pronunciationRows.filter((row) => row.ipa.trim()).map((row) => row.chunkId),
  );
  const sourcesByChunk = new Map<string, typeof sourceRows>();
  for (const source of sourceRows) {
    const values = sourcesByChunk.get(source.chunkId) ?? [];
    values.push(source);
    sourcesByChunk.set(source.chunkId, values);
  }
  const accentByBook = new Map(bookRows.map((book) => [book.id, book.defaultAccent]));
  const units: PronunciationInput[] = chunkRows
    .filter((chunk) => !chunksWithPronunciation.has(chunk.id))
    .map((chunk) => ({
      unitKey: chunk.id,
      chunkId: chunk.id,
      displayChunk: chunk.displayChunk,
      canonicalChunk: chunk.canonicalChunk,
      targetAccent: accentByBook.get(chunk.bookId) ?? "en-GB",
      sources: (sourcesByChunk.get(chunk.id) ?? []).map((source) => ({
        sourceType: source.sourceType,
        sourceContext: source.sourceContext,
      })),
    }));

  return createBatches<PronunciationInput, unknown>({
    stage: "pronunciation_enrichment",
    promptVersion: PRONUNCIATION_ENRICHMENT_PROMPT_VERSION,
    units,
    batchSize: 10,
    maxBatches,
    getUnitKey: (unit) => unit.unitKey,
  });
}

export async function pronunciationEnrichmentApply(batchIds?: ReadonlySet<string>): Promise<{
  applied: number;
  rejected: number;
  pending: number;
}> {
  const db = await getDbReady();
  return applyBatches<PronunciationInput, z.infer<typeof pronunciationEnrichmentBatchOutputSchema>>({
    stage: "pronunciation_enrichment",
    batchIds,
    outputSchema: pronunciationEnrichmentBatchOutputSchema,
    crossCheck: async (batch, output) => {
      if (batch.promptVersion !== PRONUNCIATION_ENRICHMENT_PROMPT_VERSION) {
        return `Prompt 版本过期：${batch.promptVersion}，必须用 ${PRONUNCIATION_ENRICHMENT_PROMPT_VERSION} 重新生成`;
      }
      const inputById = new Map(batch.inputs.map((input) => [input.chunkId, input]));
      const seen = new Set<string>();
      for (const item of output.items) {
        const input = inputById.get(item.chunkId);
        if (!input) return `items.chunkId ${item.chunkId} 不在本批输入中`;
        if (seen.has(item.chunkId)) return `items.chunkId ${item.chunkId} 重复`;
        if (item.accent !== input.targetAccent) {
          return `${item.chunkId} accent 必须是输入指定的 ${input.targetAccent}`;
        }
        if (invalidIpa(item.ipa)) return `${item.chunkId} IPA 格式无效`;
        seen.add(item.chunkId);
      }
      for (const chunkId of inputById.keys()) if (!seen.has(chunkId)) return `缺少 ${chunkId} 的 IPA`;
      return null;
    },
    apply: async (_batch, output) => {
      for (const item of output.items) {
        await db
          .insert(chunkPronunciations)
          .values({
            id: `cp_enrich_${item.chunkId.slice(2)}`,
            chunkId: item.chunkId,
            ipa: item.ipa.trim(),
            accent: item.accent,
            audioUrl: null,
            source: PRONUNCIATION_ENRICHMENT_PROMPT_VERSION,
            isPrimary: 1,
          })
          .onConflictDoNothing();
      }
    },
  });
}
