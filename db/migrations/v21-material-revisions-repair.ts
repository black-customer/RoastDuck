/** 真实库早期 v19 在加入版本表前执行过；保留该历史 checksum，补表使用新编号。 */
export const V21_DDL = [
  `CREATE TABLE IF NOT EXISTS practice_material_revisions (
    material_id TEXT NOT NULL, generator_run_id TEXT NOT NULL,
    analysis_json TEXT NOT NULL, reviewer_run_id TEXT, review_json TEXT,
    error_code TEXT, created_at TEXT NOT NULL, PRIMARY KEY(material_id,generator_run_id)
  )`,
];
