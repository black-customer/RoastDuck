/**
 * 同文判定继承：文本完全相同的 pending 句子，继承已判定句子的状态。
 * （同一示范答案文本在多份 PDF 中重复出现；判定一致，来源各自记录。）
 */
import { sql } from "drizzle-orm";
import { getDbReady } from "../../../db/client";

export async function carryForward(): Promise<number> {
  const db = await getDbReady();
  // pending 句子文本 ↔ 已判定句子文本 精确匹配
  const r = await db.all<{ n: number }>(sql`
    SELECT COUNT(*) AS n FROM source_sentences p
    WHERE p.status = 'pending'
      AND EXISTS (
        SELECT 1 FROM source_sentences d
        WHERE d.status != 'pending' AND d.text = p.text
      )`);
  const n = r[0]?.n ?? 0;
  await db.run(sql`
    UPDATE source_sentences SET
      status = (SELECT d.status FROM source_sentences d WHERE d.text = source_sentences.text AND d.status != 'pending' LIMIT 1),
      no_new_unit_reason = (SELECT d.no_new_unit_reason FROM source_sentences d WHERE d.text = source_sentences.text AND d.status != 'pending' LIMIT 1),
      covered_by_json = (SELECT d.covered_by_json FROM source_sentences d WHERE d.text = source_sentences.text AND d.status != 'pending' LIMIT 1)
    WHERE status = 'pending'
      AND EXISTS (SELECT 1 FROM source_sentences d WHERE d.text = source_sentences.text AND d.status != 'pending')`);
  return n;
}
