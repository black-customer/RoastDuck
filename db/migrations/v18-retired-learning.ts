import type { Transaction } from "@libsql/client";

export const V18_DDL = [
  `CREATE TABLE IF NOT EXISTS retired_learning_records (
    entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, payload_json TEXT NOT NULL,
    reason TEXT NOT NULL, archived_at TEXT NOT NULL,
    PRIMARY KEY (entity_type, entity_id)
  )`,
];

/** 只归档已无目标内容的遗留状态，绝不恢复用户删除的词书／Chunk。 */
export async function archiveRetiredLearning(tx: Transaction) {
  for (const ddl of V18_DDL) await tx.execute(ddl);
  const now = new Date().toISOString();
  const progress = await tx.execute(`SELECT p.* FROM learning_progress p
    LEFT JOIN chunks c ON c.id=p.chunk_id WHERE c.id IS NULL`);
  const sessions = await tx.execute(`SELECT s.* FROM learning_sessions s
    WHERE s.status='active' AND json_valid(s.queue_json)
      AND EXISTS (SELECT 1 FROM json_each(s.queue_json) item
        LEFT JOIN chunks c ON c.id=item.value WHERE c.id IS NULL)`);
  for (const [type, rows, key] of [
    ["learning_progress", progress.rows, "chunk_id"],
    ["learning_sessions", sessions.rows, "id"],
  ] as const) {
    for (const row of rows) {
      await tx.execute({
        sql: `INSERT OR IGNORE INTO retired_learning_records
          (entity_type,entity_id,payload_json,reason,archived_at) VALUES (?,?,?,?,?)`,
        args: [type, String(row[key]), JSON.stringify(row), "source_material_removed_by_owner", now],
      });
    }
  }
  await tx.execute(`DELETE FROM learning_progress WHERE chunk_id IN
    (SELECT p.chunk_id FROM learning_progress p LEFT JOIN chunks c ON c.id=p.chunk_id WHERE c.id IS NULL)
    AND EXISTS (SELECT 1 FROM retired_learning_records r
      WHERE r.entity_type='learning_progress' AND r.entity_id=learning_progress.chunk_id)`);
  await tx.execute({
    sql: `UPDATE learning_sessions SET status='materials_removed',updated_at=?
      WHERE status='active' AND id IN
        (SELECT entity_id FROM retired_learning_records WHERE entity_type='learning_sessions')`,
    args: [now],
  });
}
