/**
 * quality_review 的确定性预筛：只能拒绝结构上显然不合格的记录，绝不能批准 Chunk。
 * 通过预筛的记录继续保持 pending_review，必须进入独立 Reviewer 批次。
 */
import { sql } from "drizzle-orm";
import { getDbReady } from "../../../db/client";

export async function ruleReview(): Promise<{ passed: number; rejected: number }> {
  const db = await getDbReady();
  let passed = 0;
  let rejected = 0;

  const rows = await db.all<{ id: string; display: string; meaning: string; examples: number }>(sql`
    SELECT c.id, c.display_chunk AS display, c.meaning_zh AS meaning,
      (SELECT COUNT(*) FROM chunk_examples e WHERE e.chunk_id = c.id) AS examples
    FROM chunks c WHERE c.quality_status = 'pending_review'`);

  for (const r of rows) {
    const d = (r.display ?? "").trim();
    const m = (r.meaning ?? "").trim();
    let reason: string | null = null;
    if (!m) reason = "释义缺失";
    else if (d.toLowerCase() === m.toLowerCase()) reason = "display 与释义相同";
    else if (d.split(/\s+/).length < 2 && d.length <= 2) reason = "过短，疑似碎片";
    else if ((r.examples ?? 0) === 0) reason = "缺少例句";
    if (reason) {
      await db.run(sql`UPDATE chunks SET quality_status = 'rejected', reject_reason = ${reason},
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ${r.id}`);
      rejected++;
    } else passed++;
  }
  return { passed, rejected };
}
