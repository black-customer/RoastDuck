/**
 * dedup 阶段：确定性形态合并（verbNormalize）+ 近似对 LLM 语义裁决。
 * 确定性合并：dedupKey（首词动词归一后的 canonical）相等 → 自动合并。
 * 近似对（Jaccard ≥ 0.7，同话题）→ dedup 批次 → 裁决结果应用。
 * 已裁决 pair 记录在 _meta，避免重复提出。
 */
import { and, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { getDbReady } from "../../../db/client";
import { chunks } from "../../../db/schema";
import { dedupBatchOutputSchema } from "../lib/schemas";
import { applyBatches, createBatches } from "../lib/queue";
import { tokenJaccard, verbNormalizeLoose } from "../lib/canonical";
import { mergeChunks } from "./chunkRepo";
import { sha1Like } from "../lib/text";

export const DEDUP_PROMPT_VERSION = "dedup-v1";

/** 确定性形态合并：dedupKey 相同的 chunk 合并为一条（保留 id 最小者）。 */
export async function dedupDeterministic(): Promise<number> {
  const db = await getDbReady();
  const rows = await db.select().from(chunks).where(and(ne(chunks.qualityStatus, "rejected"), sql`${chunks.bookId} IN (SELECT id FROM books WHERE source_type != 'personal_answers')`));
  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = `${r.bookId}|${verbNormalizeLoose(r.canonicalChunk)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }
  let merged = 0;
  for (const [, group] of groups) {
    if (group.length < 2) continue;
    group.sort((a, b) => (a.displayChunk.length - b.displayChunk.length) || a.id.localeCompare(b.id));
    const keep = group[0];
    for (const drop of group.slice(1)) {
      if (await mergeChunks(keep.id, drop.id)) merged++;
    }
  }
  return merged;
}

interface DedupPair {
  unitKey: string;
  pairKey: string;
  a: { id: string; canonical: string; meaningZh: string };
  b: { id: string; canonical: string; meaningZh: string };
}

/** 已裁决过的 pairKey 集合（_meta 表）。 */
async function adjudicatedKeys(): Promise<Set<string>> {
  const db = await getDbReady();
  const rows = await db.all<{ key: string }>(sql`SELECT key FROM _meta WHERE key LIKE 'dedup_pair_%'`);
  return new Set(rows.map((r) => r.key));
}

export async function dedupPairsCreate(maxBatches = 20): Promise<number> {
  const db = await getDbReady();
  const rows = await db.select().from(chunks).where(and(ne(chunks.qualityStatus, "rejected"), sql`${chunks.bookId} IN (SELECT id FROM books WHERE source_type != 'personal_answers')`));
  const done = await adjudicatedKeys();
  const pairs: DedupPair[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i];
      const b = rows[j];
      if (a.bookId !== b.bookId || a.topicId !== b.topicId) continue;
      const ka = verbNormalizeLoose(a.canonicalChunk);
      const kb = verbNormalizeLoose(b.canonicalChunk);
      const sim = tokenJaccard(ka, kb);
      if (sim < 0.7) continue;
      const lenRatio =
        Math.min(a.canonicalChunk.length, b.canonicalChunk.length) /
        Math.max(a.canonicalChunk.length, b.canonicalChunk.length);
      if (lenRatio < 0.5) continue;
      const pairKey = `p_${sha1Like(`${a.id}|${b.id}`)}`;
      if (done.has(pairKey)) continue;
      if (seen.has(pairKey)) continue;
      seen.add(pairKey);
      pairs.push({
        unitKey: pairKey,
        pairKey,
        a: { id: a.id, canonical: a.canonicalChunk, meaningZh: a.meaningZh },
        b: { id: b.id, canonical: b.canonicalChunk, meaningZh: b.meaningZh },
      });
    }
  }
  return createBatches<DedupPair, unknown>({
    stage: "dedup",
    promptVersion: DEDUP_PROMPT_VERSION,
    units: pairs,
    batchSize: 12,
    maxBatches,
    getUnitKey: (u) => u.unitKey,
  });
}

export async function dedupPairsApply(
  batchIds?: ReadonlySet<string>,
): Promise<{ applied: number; rejected: number; pending: number }> {
  const db = await getDbReady();
  return applyBatches<DedupPair, z.infer<typeof dedupBatchOutputSchema>>({
    stage: "dedup",
    batchIds,
    outputSchema: dedupBatchOutputSchema,
    crossCheck: async (batch, output) => {
      const pairKeys = new Set(batch.inputs.map((i) => i.pairKey));
      const seen = new Set<string>();
      for (const v of output.verdicts) {
        if (!pairKeys.has(v.pairKey)) return `verdict.pairKey ${v.pairKey} 不在本批输入中`;
        if (seen.has(v.pairKey)) return `verdict.pairKey ${v.pairKey} 重复`;
        seen.add(v.pairKey);
        if (v.verdict === "merge") {
          const ids = batch.inputs.find((i) => i.pairKey === v.pairKey);
          if (!ids) return `pairKey ${v.pairKey} 输入缺失`;
          const valid = { [ids.a.id]: true, [ids.b.id]: true } as Record<string, boolean>;
          if (!v.keepId || !v.dropId || !valid[v.keepId] || !valid[v.dropId]) {
            return `pairKey ${v.pairKey} 的 keepId/dropId 与输入不符`;
          }
        }
      }
      for (const pairKey of pairKeys) {
        if (!seen.has(pairKey)) return `缺少 pairKey ${pairKey} 的语义裁决`;
      }
      return null;
    },
    apply: async (_batch, output) => {
      for (const v of output.verdicts) {
        await db.run(sql`INSERT OR REPLACE INTO _meta (key, value) VALUES (${`dedup_pair_${v.pairKey}`}, ${v.verdict})`);
        if (v.verdict === "merge" && v.keepId && v.dropId) {
          await mergeChunks(v.keepId, v.dropId);
        }
      }
    },
  });
}
