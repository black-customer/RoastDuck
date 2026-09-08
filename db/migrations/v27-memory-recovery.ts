/** Revocation is durable even when a prior network request returns late. */
export const V27_DDL=[
  `CREATE TABLE companion_memory_control (singleton INTEGER PRIMARY KEY CHECK(singleton=1),generation INTEGER NOT NULL DEFAULT 0,cutoffs_json TEXT NOT NULL DEFAULT '{}',updated_at TEXT NOT NULL)`,
  `CREATE TABLE companion_memory_jobs (id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,generation INTEGER NOT NULL,input_json TEXT NOT NULL,status TEXT NOT NULL,error_code TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)`,
  `CREATE INDEX companion_memory_jobs_state ON companion_memory_jobs(status,updated_at)`,
  `ALTER TABLE answer_drafts ADD COLUMN kind TEXT NOT NULL DEFAULT 'practice'`,
  `ALTER TABLE answer_drafts ADD COLUMN english_committed_at TEXT`,
];
