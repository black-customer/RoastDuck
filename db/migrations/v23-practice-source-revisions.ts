/** 对混题、重答与纯指令作追加式修订；不覆盖私人原文。 */
export const V23_DDL = [
  `CREATE TABLE IF NOT EXISTS practice_source_revisions (
    id TEXT PRIMARY KEY, parent_answer_id TEXT NOT NULL UNIQUE,
    source_hash TEXT NOT NULL, snapshot_json TEXT NOT NULL,
    reviewer_context TEXT NOT NULL, created_at TEXT NOT NULL
  )`,
];
