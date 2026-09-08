/** 离线证据独立于 Runtime 账单；历史回答只增加可追溯适配，不覆盖原文。 */
export const V22_DDL = [
  `CREATE TABLE IF NOT EXISTS practice_offline_runs (
    run_id TEXT PRIMARY KEY, material_id TEXT NOT NULL, stage TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT 'offline_agent', model TEXT NOT NULL,
    context_id TEXT NOT NULL, prompt_version TEXT NOT NULL,
    input_hash TEXT NOT NULL, output_hash TEXT NOT NULL, artifact_hash TEXT NOT NULL,
    network_calls INTEGER NOT NULL DEFAULT 0 CHECK(network_calls=0), created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS practice_answer_sources (
    answer_id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL UNIQUE,
    source_hash TEXT NOT NULL, created_at TEXT NOT NULL
  )`,
];
