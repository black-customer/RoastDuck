/** Sentence evidence is independent of retired chunk/four-step scheduling. */
export const V33_DDL=[
  `CREATE TABLE material_validation_cache(material_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,rule_version TEXT NOT NULL,valid INTEGER NOT NULL,result_json TEXT NOT NULL,checked_at TEXT NOT NULL)`,
  `CREATE TABLE sentence_learning_units(id TEXT PRIMARY KEY,material_id TEXT NOT NULL,sentence_id TEXT NOT NULL,source_type TEXT NOT NULL,source_id TEXT NOT NULL,question_id TEXT,ordinal INTEGER NOT NULL,version TEXT NOT NULL,body_json TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(material_id,sentence_id,version))`,
  `CREATE INDEX sentence_units_material ON sentence_learning_units(material_id,active,ordinal)`,
  `CREATE INDEX sentence_units_question ON sentence_learning_units(question_id,active,ordinal)`,
  `CREATE TABLE sentence_study_progress(sentence_id TEXT PRIMARY KEY,first_seen_at TEXT NOT NULL,last_seen_at TEXT NOT NULL,due_at TEXT NOT NULL,fsrs_json TEXT NOT NULL,review_count INTEGER NOT NULL DEFAULT 0,version INTEGER NOT NULL DEFAULT 1,last_rating TEXT NOT NULL)`,
  `CREATE INDEX sentence_progress_due ON sentence_study_progress(due_at,sentence_id)`,
  `CREATE TABLE sentence_study_sessions(id TEXT PRIMARY KEY,scope_json TEXT NOT NULL,scope_key TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 0,view_json TEXT NOT NULL,request_id TEXT NOT NULL UNIQUE,request_hash TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)`,
  `CREATE INDEX sentence_session_resume ON sentence_study_sessions(mode,status,updated_at)`,
  `CREATE TABLE sentence_study_events(session_id TEXT NOT NULL,client_event_id TEXT NOT NULL,payload_hash TEXT NOT NULL,kind TEXT NOT NULL,sentence_id TEXT,rating TEXT,target_event_id TEXT,before_progress_json TEXT,after_progress_version INTEGER,created_at TEXT NOT NULL,PRIMARY KEY(session_id,client_event_id))`,
  `CREATE INDEX sentence_event_activity ON sentence_study_events(kind,created_at,sentence_id)`,
  `CREATE TABLE sentence_material_editions(id TEXT PRIMARY KEY,material_id TEXT NOT NULL,source_hash TEXT NOT NULL,analysis_hash TEXT NOT NULL,author_json TEXT NOT NULL,review_json TEXT NOT NULL,cards_json TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'ready',created_at TEXT NOT NULL)`,
  `CREATE INDEX sentence_edition_material ON sentence_material_editions(material_id,created_at)`,
];
