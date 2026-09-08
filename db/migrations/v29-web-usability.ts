/** Additive Web recovery state. No learning progress or old evidence is rewritten. */
export const V29_DDL=[
  `CREATE TABLE light_study_successions (legacy_session_id TEXT PRIMARY KEY,current_session_id TEXT,cutover_version INTEGER NOT NULL,remaining_json TEXT NOT NULL DEFAULT '[]',created_at TEXT NOT NULL,updated_at TEXT NOT NULL)`,
  `CREATE TABLE light_study_succession_batches (legacy_session_id TEXT NOT NULL,batch_no INTEGER NOT NULL,session_id TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL,PRIMARY KEY(legacy_session_id,batch_no))`,
  `CREATE TABLE speech_requests (id TEXT PRIMARY KEY,cache_key TEXT NOT NULL,descriptor_json TEXT NOT NULL,status TEXT NOT NULL,priority INTEGER NOT NULL DEFAULT 0,error_code TEXT,asset_id TEXT,owner_boot_id TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)`,
  `CREATE INDEX speech_requests_cache ON speech_requests(cache_key,created_at)`,
];
