/** Additive web-only fields. No historical answers, grades or due dates are rewritten. */
export const V32_DDL = [
  "ALTER TABLE answer_drafts ADD COLUMN raw_input TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE answer_drafts ADD COLUMN input_format TEXT NOT NULL DEFAULT 'legacy'",
  "ALTER TABLE expression_preferences ADD COLUMN self_known INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE light_study_progress ADD COLUMN scheduler_version TEXT NOT NULL DEFAULT 'legacy-24h'",
];
