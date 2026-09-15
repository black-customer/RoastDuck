/** Links supported practice to later output without converting that evidence into an FSRS grade. */
export const V36_COACHING_DDL:string[]=[
  `CREATE TABLE context_practice_tasks(
    id TEXT PRIMARY KEY,client_request_id TEXT NOT NULL UNIQUE,input_hash TEXT NOT NULL,
    material_id TEXT NOT NULL,source_question_id TEXT,question_id TEXT,
    source_sentence_ids_json TEXT NOT NULL DEFAULT '[]',source_memory_ids_json TEXT NOT NULL DEFAULT '[]',
    prompt_en TEXT NOT NULL DEFAULT '',prompt_zh TEXT NOT NULL DEFAULT '',
    origin TEXT NOT NULL CHECK(origin IN ('bank','teacher_generated')),
    status TEXT NOT NULL CHECK(status IN ('ready','generating','failed','completed','dismissed')),
    request_json TEXT NOT NULL DEFAULT '{}',run_id TEXT,error_code TEXT,
    version INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX context_practice_source ON context_practice_tasks(material_id,created_at)`,
  `CREATE TABLE coaching_practice_links(
    practice_id TEXT PRIMARY KEY,root_practice_id TEXT NOT NULL,material_id TEXT NOT NULL,
    sentence_id TEXT,source_session_id TEXT,related_task_id TEXT,created_at TEXT NOT NULL
  )`,
  `CREATE INDEX coaching_practice_material ON coaching_practice_links(material_id,created_at)`,
];
