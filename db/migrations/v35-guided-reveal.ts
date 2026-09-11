export const V35_DDL=[
  `CREATE TABLE sentence_teaching_editions(id TEXT PRIMARY KEY,material_id TEXT NOT NULL,source_hash TEXT NOT NULL,candidate_hash TEXT NOT NULL,author_json TEXT NOT NULL,review_json TEXT NOT NULL,teachings_json TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'ready',created_at TEXT NOT NULL)`,
  `CREATE INDEX sentence_teaching_material ON sentence_teaching_editions(material_id,created_at,id)`,
];
