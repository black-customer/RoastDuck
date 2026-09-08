import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getDbReady, withDbTransaction } from '@db/client';

/** 编辑只追加修订证据并撤销审核资格，永远不能批准内容。 */
export async function amendChunk(input: { id: string; action: 'edit' | 'reject'; fields?: { displayChunk?: string; meaningZh?: string }; reason?: string; personalOnly?: boolean }) {
  return withDbTransaction(async () => {
    const db = await getDbReady();
    const [before] = await db.all<Record<string, unknown>>(sql`SELECT * FROM chunks WHERE id = ${input.id}`);
    if (!before) return null;
    if (input.personalOnly && before.book_id !== 'book_personal_ielts_answers') return { publicChunk: true } as const;
    const display = (input.action === 'edit' ? input.fields?.displayChunk : undefined) ?? String(before.display_chunk);
    const meaning = (input.action === 'edit' ? input.fields?.meaningZh : undefined) ?? String(before.meaning_zh);
    const status = input.action === 'reject' ? 'rejected' : 'pending_review';
    const reason = input.reason?.trim() || '用户修改，等待独立内容复核';
    if ((input.action === 'edit' && display === before.display_chunk && meaning === before.meaning_zh)
      || (input.action === 'reject' && before.quality_status === status && before.reject_reason === reason)) {
      return { changed: false, qualityStatus: String(before.quality_status) };
    }
    const now = new Date().toISOString();
    await db.run(sql`UPDATE chunks SET display_chunk = ${display}, meaning_zh = ${meaning}, quality_status = ${status},
      reject_reason = ${reason}, review_provenance = 'unreviewed', reviewer_version = NULL, reviewed_at = NULL, updated_at = ${now} WHERE id = ${input.id}`);
    await db.run(sql`UPDATE learning_scenarios SET review_decision = 'pending', reviewer_run_id = NULL, review_reason = ${reason}, updated_at = ${now} WHERE chunk_id = ${input.id}`);
    const [after] = await db.all<Record<string, unknown>>(sql`SELECT * FROM chunks WHERE id = ${input.id}`);
    await db.run(sql`INSERT INTO content_amendments (id, chunk_id, action, before_json, after_json, reason, created_at)
      VALUES (${randomUUID()}, ${input.id}, ${input.action}, ${JSON.stringify(before)}, ${JSON.stringify(after)}, ${reason}, ${now})`);
    return { changed: true, qualityStatus: status };
  });
}
