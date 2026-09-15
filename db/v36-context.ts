/** Append-only evidence and versioned preferences for the complete context workspace. */
export const V36_CONTEXT_DDL:string[]=[
  `CREATE TABLE sentence_exposures(sentence_id TEXT NOT NULL,unit_version TEXT NOT NULL,first_exposed_at TEXT NOT NULL,last_exposed_at TEXT NOT NULL,first_review_due_at TEXT NOT NULL,PRIMARY KEY(sentence_id,unit_version))`,
  `CREATE INDEX sentence_exposure_due ON sentence_exposures(first_review_due_at,sentence_id)`,
  `CREATE TABLE sentence_exposure_events(session_id TEXT NOT NULL,client_event_id TEXT NOT NULL,sentence_id TEXT NOT NULL,unit_version TEXT NOT NULL,source TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(session_id,client_event_id))`,
  `CREATE INDEX sentence_exposure_activity ON sentence_exposure_events(created_at,sentence_id)`,
  `CREATE TABLE sentence_preferences(sentence_id TEXT PRIMARY KEY,hidden INTEGER NOT NULL DEFAULT 0,favorite INTEGER NOT NULL DEFAULT 0,self_known INTEGER NOT NULL DEFAULT 0,note TEXT NOT NULL DEFAULT '',version INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL)`,
  `CREATE TABLE sentence_preference_events(client_request_id TEXT PRIMARY KEY,payload_hash TEXT NOT NULL,sentence_id TEXT NOT NULL,unit_version TEXT NOT NULL,before_json TEXT NOT NULL,after_json TEXT NOT NULL,created_at TEXT NOT NULL)`,
  `CREATE TABLE sentence_feedback(id TEXT PRIMARY KEY,client_request_id TEXT NOT NULL UNIQUE,payload_hash TEXT NOT NULL,sentence_id TEXT NOT NULL,unit_version TEXT NOT NULL,material_id TEXT NOT NULL,kind TEXT NOT NULL,reason TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'open',created_at TEXT NOT NULL)`,
  `CREATE INDEX sentence_feedback_unit ON sentence_feedback(sentence_id,unit_version,status)`,
  `CREATE TABLE sentence_feedback_events(client_request_id TEXT PRIMARY KEY,payload_hash TEXT NOT NULL,feedback_id TEXT NOT NULL,action TEXT NOT NULL,created_at TEXT NOT NULL)`,
  `CREATE TABLE sentence_practice_evidence(session_id TEXT NOT NULL,client_event_id TEXT NOT NULL,sentence_id TEXT NOT NULL,unit_version TEXT NOT NULL,kind TEXT NOT NULL,payload_json TEXT NOT NULL,scheduled INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,PRIMARY KEY(session_id,client_event_id))`,
];
