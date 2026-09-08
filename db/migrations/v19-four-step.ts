/** 回答／对话材料和服务端四步，不依赖旧词书。 */
export const V19_DDL = [
  `CREATE TABLE IF NOT EXISTS practice_submissions (
    request_id TEXT PRIMARY KEY, input_hash TEXT NOT NULL, attempt_id TEXT NOT NULL UNIQUE
  )`,
  `CREATE TABLE IF NOT EXISTS practice_materials (
    id TEXT PRIMARY KEY, source_type TEXT NOT NULL, source_id TEXT NOT NULL, question_id TEXT,
    input_json TEXT NOT NULL, input_hash TEXT NOT NULL, analysis_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'queued', generator_run_id TEXT, reviewer_run_id TEXT,
    review_json TEXT NOT NULL DEFAULT '{}', job_id TEXT, lease_until TEXT, lease_token TEXT,
    error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(source_type,source_id,input_hash)
  )`,
  `CREATE TABLE IF NOT EXISTS practice_material_items (
    material_id TEXT NOT NULL, learning_item_id TEXT NOT NULL, row_index INTEGER NOT NULL,
    PRIMARY KEY(material_id,row_index)
  )`,
  `CREATE TABLE IF NOT EXISTS practice_material_revisions (
    material_id TEXT NOT NULL, generator_run_id TEXT NOT NULL,
    analysis_json TEXT NOT NULL, reviewer_run_id TEXT, review_json TEXT,
    error_code TEXT, created_at TEXT NOT NULL, PRIMARY KEY(material_id,generator_run_id)
  )`,
  `CREATE TABLE IF NOT EXISTS four_step_sessions (
    id TEXT PRIMARY KEY, material_id TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'learn',
    status TEXT NOT NULL DEFAULT 'active', step_no INTEGER NOT NULL DEFAULT 1,
    step_version INTEGER NOT NULL DEFAULT 0, state_json TEXT NOT NULL,
    lease_until TEXT, lease_token TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    completed_at TEXT
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS four_step_active_unique ON four_step_sessions(material_id,mode) WHERE status='active'`,
  `CREATE TABLE IF NOT EXISTS four_step_events (
    session_id TEXT NOT NULL, client_event_id TEXT NOT NULL, input_hash TEXT NOT NULL,
    request_json TEXT NOT NULL, status TEXT NOT NULL, result_json TEXT,
    created_at TEXT NOT NULL, PRIMARY KEY(session_id,client_event_id)
  )`,
  `CREATE TABLE IF NOT EXISTS four_step_judgements (
    id TEXT PRIMARY KEY, status TEXT NOT NULL, result_json TEXT, run_id TEXT,
    lease_until TEXT, lease_token TEXT, updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS learning_item_schedule (
    learning_item_id TEXT PRIMARY KEY, fsrs_json TEXT NOT NULL, due_at TEXT NOT NULL,
    last_completed_at TEXT NOT NULL, review_count INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS four_step_settlements (
    session_id TEXT NOT NULL, learning_item_id TEXT NOT NULL, rating TEXT NOT NULL,
    evidence_json TEXT NOT NULL, completed_at TEXT NOT NULL,
    PRIMARY KEY(session_id,learning_item_id)
  )`,
  `CREATE INDEX IF NOT EXISTS practice_materials_source_idx ON practice_materials(source_type,source_id,created_at)`,
  `CREATE INDEX IF NOT EXISTS learning_item_due_idx ON learning_item_schedule(due_at)`,
];
