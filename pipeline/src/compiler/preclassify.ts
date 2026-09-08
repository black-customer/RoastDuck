/**
 * 句子预分类（确定性）：
 *  1. 纯短应答（<=4 词且无实义内容）→ no_new_unit(filler)
 *  2. 句子包含已有 chunk 的 canonical 子串 → covered（内容已被已有 Chunk 覆盖）
 *  3. 其余 → 保持 pending，进入句子批次由 Agent 判定
 * 该脚本只写回 source_sentences 的状态，不产生 chunk。
 */
import { sql } from "drizzle-orm";
import { getDbReady } from "../../../db/client";

export async function preclassifySentences(): Promise<{ filler: number; covered: number; remaining: number }> {
  const db = await getDbReady();
  const chunks = await db.all<{ id: string; canonical: string }>(sql`
    SELECT id, canonical_chunk AS canonical FROM chunks WHERE quality_status != 'rejected'`);
  // 只用 >=2 个词的 canonical 做子串匹配（单词太容易误判）
  const canonicals = chunks
    .map((c) => c.canonical)
    .filter((s) => s.split(" ").length >= 2)
    .sort((a, b) => b.length - a.length);
  // 例句语料（用于窗口匹配覆盖检测）
  const exRows = await db.all<{ en: string }>(sql`
    SELECT DISTINCT text_en AS en FROM chunk_examples WHERE text_en IS NOT NULL`);
  const exampleTexts = exRows.map((r) => r.en.toLowerCase()).filter((t) => t.split(" ").length >= 8);

  const sentences = await db.all<{ id: string; text: string }>(sql`
    SELECT id, text FROM source_sentences WHERE status = 'pending'`);

  let filler = 0;
  let covered = 0;
  for (const s of sentences) {
    const lower = s.text.toLowerCase();
    const wordCount = lower.split(/\s+/).filter(Boolean).length;
    // 规则1: 整条 canonical 子串匹配
    let hit = canonicals.find((c) => lower.includes(c));
    // 规则2: 句子中任意 4 词窗口与某 canonical 子串匹配（同话题表达复用）
    if (!hit) {
      const words = lower.replace(/[^a-z0-9' ]/g, " ").split(/\s+/).filter(Boolean);
      const hasContent = (win: string) => win.split(" ").some((w) => w.length >= 5);
      outer: for (let w = 4; w >= 3 && !hit; w--) {
        for (let i = 0; i + w <= words.length; i++) {
          const window = words.slice(i, i + w).join(" ");
          if (!hasContent(window)) continue;
          const m = canonicals.find((c) => c.includes(window));
          if (m) { hit = m; break outer; }
          // 仅 4 词窗口允许对照例句（3 词窗口仅对 canonical，避免误判）
          if (w >= 4) {
            for (const ex of exampleTexts) {
              if (ex.includes(window)) { hit = window; break outer; }
            }
          }
        }
      }
    }
    if (hit) {
      // 找到引用它的 chunk id
      const chunkRow = await db.all<{ id: string }>(sql`
        SELECT id FROM chunks WHERE canonical_chunk = ${hit} LIMIT 1`);
      await db.run(sql`
        UPDATE source_sentences SET status = 'covered',
          covered_by_json = ${JSON.stringify(chunkRow[0]?.id ? [chunkRow[0].id] : [])}
        WHERE id = ${s.id}`);
      covered++;
    } else if (wordCount <= 4) {
      await db.run(sql`
        UPDATE source_sentences SET status = 'no_new_unit', no_new_unit_reason = '短应答/填充语，无独立学习价值'
        WHERE id = ${s.id}`);
      filler++;
    }
  }
  const remainingRow = await db.all<{ n: number }>(sql`
    SELECT COUNT(*) AS n FROM source_sentences WHERE status = 'pending'`);
  return { filler, covered, remaining: remainingRow[0]?.n ?? 0 };
}
