/** 轻学习独立记账；不回填或改写原四步、FSRS和题目掌握。 */
export const V24_DDL = [
  `CREATE TABLE light_study_sessions (
    id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, scope_json TEXT NOT NULL,
    mode TEXT NOT NULL CHECK(mode IN ('learn','review')),
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','completed')),
    version INTEGER NOT NULL DEFAULT 0, cursor INTEGER NOT NULL DEFAULT 0,
    revealed INTEGER NOT NULL DEFAULT 0, queue_json TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`,
  `CREATE UNIQUE INDEX light_study_active_scope ON light_study_sessions(scope_key,mode) WHERE status='active'`,
  `CREATE TABLE light_study_events (
    session_id TEXT NOT NULL, client_event_id TEXT NOT NULL, kind TEXT NOT NULL,
    payload_hash TEXT NOT NULL, learning_item_id TEXT, rating TEXT,
    outcome TEXT NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY(session_id,client_event_id)
  )`,
  `CREATE UNIQUE INDEX light_study_create_request ON light_study_events(client_event_id) WHERE kind='create'`,
  `CREATE TABLE light_study_progress (
    learning_item_id TEXT PRIMARY KEY, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
    due_at TEXT NOT NULL, fsrs_json TEXT, review_count INTEGER NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 1, last_rating TEXT
  )`,
  `CREATE INDEX light_study_due ON light_study_progress(due_at,learning_item_id)`,
];
