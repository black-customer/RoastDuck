import { sql } from "drizzle-orm";
import { getDbReady } from "@db/client";

export interface PracticeSource {
  materialId: string; sourceType: string; sourceId: string; questionId: string | null;
  title: string; itemCount: number; mode: "learn" | "review"; active: boolean; href: string;
}
/** 纯读取：按真实回答／对话聚合，旧 Chunk 队列不参与。 */
export async function getPracticeOverview(now = new Date()) {
  const db = await getDbReady();
  const sources = await db.all<{ materialId: string; sourceType: string; sourceId: string; questionId: string | null; title: string; itemCount: number; active: number }>(sql`
    SELECT pm.id AS materialId,pm.source_type AS sourceType,pm.source_id AS sourceId,pm.question_id AS questionId,
      COALESCE(q.text,ft.title,'回答材料') AS title,
      (SELECT COUNT(DISTINCT mi.learning_item_id) FROM practice_material_items mi WHERE mi.material_id=pm.id) AS itemCount,
      EXISTS(SELECT 1 FROM four_step_sessions fs WHERE fs.material_id=pm.id AND fs.mode='learn' AND fs.status='active') AS active
    FROM practice_materials pm LEFT JOIN questions q ON q.id=pm.question_id
    LEFT JOIN free_talk_conversations ft ON pm.source_type='free_talk' AND ft.id=pm.source_id
    WHERE pm.status='ready' AND EXISTS(SELECT 1 FROM practice_material_items mi WHERE mi.material_id=pm.id)
      AND NOT EXISTS(SELECT 1 FROM four_step_sessions fs WHERE fs.material_id=pm.id AND fs.mode='learn' AND fs.status='completed')
    ORDER BY active DESC,pm.updated_at DESC,pm.id DESC LIMIT 12`);
  // 一个共享学习项只选择最近的材料来源，不因多个题目关联重复安排。
  const due = await db.all<{ materialId: string; sourceType: string; sourceId: string; questionId: string | null; title: string; itemCount: number; active: number }>(sql`
    WITH ranked AS (
      SELECT pm.id AS materialId,pm.source_type AS sourceType,pm.source_id AS sourceId,pm.question_id AS questionId,
        COALESCE(q.text,ft.title,'回答材料') AS title, mi.learning_item_id,
        ROW_NUMBER() OVER(PARTITION BY mi.learning_item_id ORDER BY pm.created_at DESC,pm.id DESC) AS rank
      FROM learning_item_schedule p JOIN practice_material_items mi ON mi.learning_item_id=p.learning_item_id
      JOIN practice_materials pm ON pm.id=mi.material_id LEFT JOIN questions q ON q.id=pm.question_id
      LEFT JOIN free_talk_conversations ft ON pm.source_type='free_talk' AND ft.id=pm.source_id
      WHERE pm.status='ready' AND p.due_at<=${now.toISOString()}
    )
    SELECT materialId,sourceType,sourceId,questionId,title,COUNT(DISTINCT learning_item_id) AS itemCount,
      EXISTS(SELECT 1 FROM four_step_sessions fs WHERE fs.material_id=ranked.materialId AND fs.mode='review' AND fs.status='active') AS active
    FROM ranked WHERE rank=1 GROUP BY materialId ORDER BY active DESC,materialId`);
  const map = (rows: typeof sources, mode: "learn" | "review"): PracticeSource[] => rows.map((row) => ({
    ...row, mode, itemCount: Number(row.itemCount), active: Boolean(row.active),
    href: `/training/${encodeURIComponent(row.materialId)}?mode=${mode}`,
  }));
  return { learning: map(sources, "learn"), review: map(due, "review"), dueItems: due.reduce((sum,row) => sum + Number(row.itemCount),0) };
}
