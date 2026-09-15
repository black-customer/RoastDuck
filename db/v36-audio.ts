/** Additive web-only full-answer identity and private original-audio checkpoint tables. */
export const V36_AUDIO_DDL: string[] = [
  `CREATE TABLE full_answer_attempts (
    id TEXT PRIMARY KEY, question_id TEXT NOT NULL REFERENCES questions(id), source_key TEXT NOT NULL UNIQUE,
    stage TEXT NOT NULL CHECK(stage IN ('initial','guided','independent','transfer')), prompt_condition TEXT NOT NULL,
    material_id TEXT, text TEXT NOT NULL DEFAULT '', refs_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX full_answer_question ON full_answer_attempts(question_id,created_at)`,
  `CREATE TABLE answer_audio_uploads (
    id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, metadata_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('receiving','publishing','complete')), asset_id TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE answer_audio_assets (
    id TEXT PRIMARY KEY, full_answer_id TEXT NOT NULL REFERENCES full_answer_attempts(id), upload_id TEXT NOT NULL UNIQUE,
    sha256 TEXT NOT NULL, byte_length INTEGER NOT NULL, mime_type TEXT NOT NULL, extension TEXT NOT NULL,
    duration_seconds REAL, source TEXT NOT NULL CHECK(source IN ('recording','upload')), original_name TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, recorded_at TEXT,
    recorded_at_source TEXT NOT NULL DEFAULT 'unknown' CHECK(recorded_at_source IN ('recording','user_provided','unknown')),
    removed_at TEXT, purged_at TEXT,
    UNIQUE(full_answer_id,sha256)
  )`,
  `CREATE INDEX answer_audio_attempt ON answer_audio_assets(full_answer_id,created_at)`,
];
