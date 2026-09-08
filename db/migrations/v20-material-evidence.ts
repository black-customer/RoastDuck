export const V20_DDL = [
  `ALTER TABLE practice_materials ADD COLUMN contract_version TEXT NOT NULL DEFAULT 'legacy_v1'`,
  `CREATE TABLE practice_material_stages (
    run_id TEXT PRIMARY KEY, material_id TEXT NOT NULL, stage TEXT NOT NULL,
    prompt_version TEXT NOT NULL, input_hash TEXT NOT NULL, input_json TEXT NOT NULL,
    output_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'completed', created_at TEXT NOT NULL
  )`,
  `CREATE INDEX practice_stage_checkpoint_idx ON practice_material_stages(material_id,stage,input_hash,status,created_at)`,
  `CREATE TABLE practice_legacy_analyses (
    attempt_id TEXT PRIMARY KEY, analysis_json TEXT NOT NULL, natural_version TEXT NOT NULL, archived_at TEXT NOT NULL
  )`,
  `INSERT INTO practice_legacy_analyses SELECT id,analysis_json,natural_version,strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM speaking_question_attempts WHERE analysis_json!='{}'`,
];
