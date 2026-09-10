export const V34_DDL=[
  `ALTER TABLE ai_runs ADD COLUMN response_model TEXT`,
  `ALTER TABLE ai_runs ADD COLUMN error_details_json TEXT NOT NULL DEFAULT '{}'`,
  `CREATE TABLE sentence_highlights(id TEXT PRIMARY KEY,sentence_id TEXT NOT NULL,language TEXT NOT NULL,text_version TEXT NOT NULL,text_hash TEXT NOT NULL,start_offset INTEGER NOT NULL,end_offset INTEGER NOT NULL,quote TEXT NOT NULL,prefix TEXT NOT NULL,suffix TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'active',client_request_id TEXT NOT NULL UNIQUE,request_hash TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)`,
  `CREATE INDEX sentence_highlights_lookup ON sentence_highlights(sentence_id,language,state)`,
];
