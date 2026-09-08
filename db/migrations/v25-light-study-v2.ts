/** Old rows keep their V1 contract; no progress or source material is rewritten. */
export const V25_DDL = [
  `ALTER TABLE light_study_sessions ADD COLUMN experience_version TEXT NOT NULL DEFAULT 'light_study_v1'`,
  `ALTER TABLE light_study_sessions ADD COLUMN round_json TEXT`,
  `ALTER TABLE light_study_events ADD COLUMN phase TEXT`,
];
