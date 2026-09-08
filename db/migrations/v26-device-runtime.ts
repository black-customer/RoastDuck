/** Additive local application state; never rewrites answers or learning evidence. */
export const V26_DDL=[
  `CREATE TABLE app_device (singleton INTEGER PRIMARY KEY CHECK(singleton=1),device_id TEXT NOT NULL,dataset_id TEXT NOT NULL,created_at TEXT NOT NULL)`,
  `CREATE TABLE runtime_requests (logical_key TEXT PRIMARY KEY,run_id TEXT NOT NULL UNIQUE,owner_boot_id TEXT NOT NULL,state TEXT NOT NULL,request_hash TEXT NOT NULL,response_json TEXT,error_code TEXT,updated_at TEXT NOT NULL)`,
  `CREATE TABLE answer_drafts (id TEXT PRIMARY KEY,question_id TEXT NOT NULL,english_text TEXT NOT NULL DEFAULT '',chinese_text TEXT NOT NULL DEFAULT '',english_unknown INTEGER NOT NULL DEFAULT 0,version INTEGER NOT NULL DEFAULT 0,submitted_attempt_id TEXT,source_attempt_id TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)`,
  `CREATE INDEX answer_drafts_question ON answer_drafts(question_id,updated_at)`,
];
