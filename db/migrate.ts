import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Client } from "@libsql/client";
import { archiveRetiredLearning, V18_DDL } from "./migrations/v18-retired-learning";
import { V19_DDL } from "./migrations/v19-four-step";
import { V20_DDL } from "./migrations/v20-material-evidence";
import { V21_DDL } from "./migrations/v21-material-revisions-repair";
import { V22_DDL } from "./migrations/v22-offline-practice";
import { V23_DDL } from "./migrations/v23-practice-source-revisions";
import { V24_DDL } from "./migrations/v24-light-study";
import { V25_DDL } from "./migrations/v25-light-study-v2";
import { V26_DDL } from "./migrations/v26-device-runtime";
import { V27_DDL } from "./migrations/v27-memory-recovery";
import { V28_DDL } from "./migrations/v28-device-sync";
import { V29_DDL } from "./migrations/v29-web-usability";
import { V30_DDL } from "./migrations/v30-web-speech-lock";
import { V31_DDL } from "./migrations/v31-web-material-controls";
import { V32_DDL } from "./migrations/v32-expression-study";
import { V33_DDL } from "./migrations/v33-sentence-study";
import { V34_DDL } from "./migrations/v34-personal-focus";

/**
 * 编号迁移。所有升级必须先登记版本，禁止继续依赖“CREATE IF NOT EXISTS 看起来成功”。
 * 表结构以 db/schema.ts（drizzle sqlite-core 定义）为唯一权威。
 */
const BASE_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS books (
    id TEXT PRIMARY KEY,
    title_zh TEXT NOT NULL,
    title_en TEXT NOT NULL,
    source_type TEXT NOT NULL,
    description_zh TEXT NOT NULL DEFAULT '',
    content_version TEXT NOT NULL DEFAULT 'v0',
    status TEXT NOT NULL DEFAULT 'blocked',
    blocked_reason TEXT,
    default_accent TEXT NOT NULL DEFAULT 'en-GB',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE TABLE IF NOT EXISTS topics (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL,
    name_zh TEXT NOT NULL,
    name_en TEXT NOT NULL,
    ielts_part INTEGER,
    domains_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'pending',
    sort INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS topics_book_idx ON topics (book_id)`,
  `CREATE TABLE IF NOT EXISTS questions (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL,
    topic_id TEXT,
    part INTEGER NOT NULL,
    text TEXT NOT NULL,
    text_zh TEXT NOT NULL DEFAULT '',
    norm_text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    blueprint_json TEXT NOT NULL DEFAULT '[]',
    source_refs_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS questions_norm_unique ON questions (norm_text)`,
  `CREATE INDEX IF NOT EXISTS questions_topic_idx ON questions (topic_id)`,
  `CREATE INDEX IF NOT EXISTS questions_book_idx ON questions (book_id)`,
  `CREATE TABLE IF NOT EXISTS source_sentences (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL,
    episode_or_file TEXT NOT NULL,
    seq INTEGER NOT NULL,
    text TEXT NOT NULL,
    text_zh TEXT NOT NULL DEFAULT '',
    question_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    no_new_unit_reason TEXT,
    covered_by_json TEXT NOT NULL DEFAULT '[]'
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS sentences_unique ON source_sentences (book_id, episode_or_file, seq)`,
  `CREATE INDEX IF NOT EXISTS sentences_status_idx ON source_sentences (status)`,
  `CREATE TABLE IF NOT EXISTS chunks (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL,
    canonical_chunk TEXT NOT NULL,
    display_chunk TEXT NOT NULL,
    unit_type TEXT NOT NULL,
    meaning_zh TEXT NOT NULL DEFAULT '',
    english_gloss TEXT NOT NULL DEFAULT '',
    pattern TEXT,
    variants_json TEXT NOT NULL DEFAULT '[]',
    topic_id TEXT,
    ielts_part INTEGER,
    difficulty TEXT NOT NULL DEFAULT 'intermediate',
    tags_json TEXT NOT NULL DEFAULT '[]',
    content_version TEXT NOT NULL DEFAULT 'v0',
    quality_status TEXT NOT NULL DEFAULT 'pending_review',
    review_provenance TEXT NOT NULL DEFAULT 'unreviewed',
    reviewer_version TEXT,
    reviewed_at TEXT,
    reject_reason TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS chunks_canonical_unique ON chunks (canonical_chunk, book_id)`,
  `CREATE INDEX IF NOT EXISTS chunks_topic_idx ON chunks (topic_id)`,
  `CREATE INDEX IF NOT EXISTS chunks_quality_idx ON chunks (quality_status)`,
  `CREATE TABLE IF NOT EXISTS chunk_examples (
    id TEXT PRIMARY KEY,
    chunk_id TEXT NOT NULL,
    text_en TEXT NOT NULL,
    text_zh TEXT NOT NULL DEFAULT '',
    is_source_sentence INTEGER NOT NULL DEFAULT 0,
    source_ref TEXT NOT NULL DEFAULT '',
    question_ids_json TEXT NOT NULL DEFAULT '[]',
    source_sentence_id TEXT,
    context_type TEXT NOT NULL DEFAULT 'generated_ielts',
    generated INTEGER NOT NULL DEFAULT 1,
    sort INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS examples_chunk_idx ON chunk_examples (chunk_id)`,
  `CREATE TABLE IF NOT EXISTS chunk_sources (
    id TEXT PRIMARY KEY,
    chunk_id TEXT NOT NULL,
    source_type TEXT NOT NULL,
    book_id TEXT NOT NULL,
    question_id TEXT,
    sentence_id TEXT,
    source_context TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE INDEX IF NOT EXISTS chunk_sources_chunk_idx ON chunk_sources (chunk_id)`,
  `CREATE TABLE IF NOT EXISTS chunk_coverage_refs (
    id TEXT PRIMARY KEY,
    chunk_id TEXT NOT NULL,
    ref_type TEXT NOT NULL,
    question_id TEXT,
    dim_id TEXT,
    topic_id TEXT,
    domain_id TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS coverage_refs_chunk_idx ON chunk_coverage_refs (chunk_id)`,
  `CREATE INDEX IF NOT EXISTS coverage_refs_question_idx ON chunk_coverage_refs (question_id)`,
  `CREATE TABLE IF NOT EXISTS learning_progress (
    chunk_id TEXT PRIMARY KEY,
    fsrs_json TEXT NOT NULL DEFAULT '{}',
    mastery TEXT NOT NULL DEFAULT 'new',
    intro_done INTEGER NOT NULL DEFAULT 0,
    rating_stats_json TEXT NOT NULL DEFAULT '{}',
    skill_stats_json TEXT NOT NULL DEFAULT '{}',
    last_outcome_json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE TABLE IF NOT EXISTS review_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chunk_id TEXT NOT NULL,
    trained_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    training_type TEXT NOT NULL,
    rating TEXT NOT NULL,
    detail_json TEXT NOT NULL DEFAULT '{}'
  )`,
  `CREATE INDEX IF NOT EXISTS review_log_chunk_idx ON review_log (chunk_id)`,
  `CREATE TABLE IF NOT EXISTS learning_settings (
    id INTEGER PRIMARY KEY,
    daily_new_target INTEGER NOT NULL DEFAULT 15,
    daily_review_cap INTEGER NOT NULL DEFAULT 200
  )`,
  `INSERT OR IGNORE INTO learning_settings (id) VALUES (1)`,
  `CREATE TABLE IF NOT EXISTS compile_jobs (
    id TEXT PRIMARY KEY,
    stage TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'idle',
    input_ref TEXT NOT NULL DEFAULT '',
    started_at TEXT,
    finished_at TEXT,
    error_log_json TEXT NOT NULL DEFAULT '[]'
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS compile_jobs_stage_unique ON compile_jobs (stage)`,
  `CREATE TABLE IF NOT EXISTS prompt_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stage TEXT NOT NULL,
    version TEXT NOT NULL,
    file_hash TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS prompt_versions_unique ON prompt_versions (stage, version)`,
  `CREATE TABLE IF NOT EXISTS _meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
  )`,
];

const RECOVERY_TABLE_DDL = [
  `CREATE TABLE IF NOT EXISTS chunk_topic_links (
    chunk_id TEXT NOT NULL,
    topic_id TEXT NOT NULL,
    relation TEXT NOT NULL DEFAULT 'coverage',
    is_primary INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (chunk_id, topic_id)
  )`,
  `CREATE INDEX IF NOT EXISTS chunk_topic_links_topic_idx ON chunk_topic_links (topic_id)`,
  `CREATE TABLE IF NOT EXISTS chunk_question_links (
    chunk_id TEXT NOT NULL,
    question_id TEXT NOT NULL,
    relation TEXT NOT NULL DEFAULT 'coverage',
    answer_dimension_id TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (chunk_id, question_id, relation, answer_dimension_id)
  )`,
  `CREATE INDEX IF NOT EXISTS chunk_question_links_question_idx ON chunk_question_links (question_id)`,
  `CREATE TABLE IF NOT EXISTS chunk_pronunciations (
    id TEXT PRIMARY KEY,
    chunk_id TEXT NOT NULL,
    ipa TEXT NOT NULL,
    accent TEXT NOT NULL,
    audio_url TEXT,
    source TEXT NOT NULL,
    is_primary INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS chunk_pronunciations_unique ON chunk_pronunciations (chunk_id, accent, source)`,
  `CREATE INDEX IF NOT EXISTS chunk_pronunciations_chunk_idx ON chunk_pronunciations (chunk_id)`,
  `CREATE TABLE IF NOT EXISTS lexemes (
    id TEXT PRIMARY KEY,
    surface TEXT NOT NULL,
    normalized TEXT NOT NULL,
    lemma TEXT,
    meaning_zh TEXT NOT NULL,
    ipa TEXT,
    accent TEXT NOT NULL DEFAULT 'en-GB',
    source TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'verified'
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS lexemes_normalized_accent_unique ON lexemes (normalized, accent)`,
  `CREATE INDEX IF NOT EXISTS lexemes_normalized_idx ON lexemes (normalized)`,
  `CREATE TABLE IF NOT EXISTS text_annotations (
    id TEXT PRIMARY KEY,
    content_type TEXT NOT NULL,
    content_id TEXT NOT NULL,
    start_offset INTEGER NOT NULL,
    end_offset INTEGER NOT NULL,
    surface TEXT NOT NULL,
    lexeme_id TEXT,
    chunk_id TEXT,
    meaning_zh TEXT NOT NULL,
    ipa TEXT,
    accent TEXT NOT NULL DEFAULT 'en-GB'
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS text_annotations_span_unique ON text_annotations (content_type, content_id, start_offset, end_offset)`,
  `CREATE INDEX IF NOT EXISTS text_annotations_content_idx ON text_annotations (content_type, content_id)`,
  `CREATE TABLE IF NOT EXISTS learning_sessions (
    id TEXT PRIMARY KEY,
    session_date TEXT NOT NULL,
    mode TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    queue_json TEXT NOT NULL,
    current_index INTEGER NOT NULL DEFAULT 0,
    step TEXT NOT NULL DEFAULT 'sentence_input',
    state_json TEXT NOT NULL DEFAULT '{}',
    last_event_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE INDEX IF NOT EXISTS learning_sessions_resume_idx ON learning_sessions (session_date, mode, status)`,
  `CREATE TABLE IF NOT EXISTS learning_events (
    id TEXT PRIMARY KEY,
    client_event_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS learning_events_client_unique ON learning_events (client_event_id)`,
  `CREATE INDEX IF NOT EXISTS learning_events_session_idx ON learning_events (session_id)`,
  `CREATE TABLE IF NOT EXISTS difficult_notes (
    id TEXT PRIMARY KEY,
    chunk_id TEXT,
    annotation_id TEXT,
    surface TEXT NOT NULL,
    meaning_zh TEXT NOT NULL DEFAULT '',
    source_type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    user_remark TEXT NOT NULL DEFAULT '',
    trigger_count INTEGER NOT NULL DEFAULT 1,
    last_trigger TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS difficult_notes_source_unique ON difficult_notes (source_type, source_id, surface)`,
  `CREATE INDEX IF NOT EXISTS difficult_notes_chunk_idx ON difficult_notes (chunk_id)`,
];

const ADD_COLUMNS: Array<[string, string, string]> = [
  ["books", "status", "TEXT NOT NULL DEFAULT 'blocked'"],
  ["books", "blocked_reason", "TEXT"],
  ["books", "default_accent", "TEXT NOT NULL DEFAULT 'en-GB'"],
  ["chunks", "review_provenance", "TEXT NOT NULL DEFAULT 'unreviewed'"],
  ["chunks", "reviewer_version", "TEXT"],
  ["chunks", "reviewed_at", "TEXT"],
  ["chunk_examples", "source_sentence_id", "TEXT"],
  ["chunk_examples", "context_type", "TEXT NOT NULL DEFAULT 'generated_ielts'"],
  ["chunk_examples", "generated", "INTEGER NOT NULL DEFAULT 1"],
  ["learning_progress", "skill_stats_json", "TEXT NOT NULL DEFAULT '{}'"],
  ["learning_progress", "last_outcome_json", "TEXT NOT NULL DEFAULT '{}'"],
];

/** v3：用户设置 + Runtime AI 审计表。 */
const V3_TABLE_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS user_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    auto_collect_difficulties INTEGER NOT NULL DEFAULT 0,
    auto_play INTEGER NOT NULL DEFAULT 1,
    default_accent TEXT NOT NULL DEFAULT 'en-GB',
    daily_new_target INTEGER NOT NULL DEFAULT 20,
    daily_review_cap INTEGER NOT NULL DEFAULT 100,
    personal_new_ratio REAL NOT NULL DEFAULT 0.4,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE TABLE IF NOT EXISTS ai_jobs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    target_type TEXT NOT NULL DEFAULT '',
    target_id TEXT NOT NULL DEFAULT '',
    idempotency_key TEXT NOT NULL UNIQUE,
    prompt_version TEXT NOT NULL DEFAULT '',
    schema_version TEXT NOT NULL DEFAULT '',
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error_code TEXT,
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE TABLE IF NOT EXISTS ai_runs (
    run_id TEXT PRIMARY KEY,
    job_id TEXT,
    role TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    prompt_version TEXT NOT NULL DEFAULT '',
    schema_version TEXT NOT NULL DEFAULT '',
    thinking_mode TEXT NOT NULL DEFAULT 'disabled',
    input_hash TEXT NOT NULL DEFAULT '',
    response_id TEXT,
    latency_ms INTEGER,
    input_tokens INTEGER,
    output_tokens INTEGER,
    reasoning_tokens INTEGER,
    cached_tokens INTEGER,
    status TEXT NOT NULL,
    error_code TEXT,
    error_summary TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE INDEX IF NOT EXISTS ai_runs_job_idx ON ai_runs (job_id)`,
  `CREATE INDEX IF NOT EXISTS ai_jobs_status_idx ON ai_jobs (status)`,
  `INSERT OR IGNORE INTO user_settings (id) VALUES (1)`,
];

async function applyV3Migration(client: Client): Promise<void> {
  for (const stmt of V3_TABLE_DDL) await client.execute(stmt);
}

/** v4：IELTS 题集、多季度来源、练习事件与收藏。 */
const V4_TABLE_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS question_sets (
    id TEXT PRIMARY KEY,
    name_zh TEXT NOT NULL,
    year INTEGER NOT NULL,
    start_month INTEGER NOT NULL,
    end_month INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    sort INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS question_set_links (
    question_id TEXT NOT NULL,
    question_set_id TEXT NOT NULL,
    source_slug TEXT NOT NULL,
    source_file TEXT NOT NULL,
    source_page INTEGER NOT NULL,
    PRIMARY KEY (question_id, question_set_id, source_slug, source_page)
  )`,
  `CREATE INDEX IF NOT EXISTS question_set_links_set_idx ON question_set_links (question_set_id)`,
  `CREATE INDEX IF NOT EXISTS question_set_links_question_idx ON question_set_links (question_id)`,
  `CREATE INDEX IF NOT EXISTS question_set_links_source_idx ON question_set_links (source_slug)`,
  `CREATE TABLE IF NOT EXISTS question_attempts (
    id TEXT PRIMARY KEY,
    question_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('viewed','started','completed')),
    origin TEXT NOT NULL DEFAULT 'browse' CHECK (origin IN ('browse','random','answer')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE INDEX IF NOT EXISTS question_attempts_question_idx ON question_attempts (question_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS question_attempts_recent_idx ON question_attempts (origin, status, created_at)`,
  `CREATE TABLE IF NOT EXISTS question_favorites (
    question_id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `INSERT OR IGNORE INTO question_sets (id, name_zh, year, start_month, end_month, status, sort)
    VALUES ('qs_2026_01_04', '2026 年 1–4 月', 2026, 1, 4, 'active', 10)`,
  `INSERT OR IGNORE INTO question_sets (id, name_zh, year, start_month, end_month, status, sort)
    VALUES ('qs_2026_05_08', '2026 年 5–8 月', 2026, 5, 8, 'active', 20)`,
  `INSERT OR IGNORE INTO question_set_links (question_id, question_set_id, source_slug, source_file, source_page)
    SELECT q.id,
      CASE WHEN CAST(json_extract(ref.value, '$.slug') AS TEXT) LIKE '%2026q2'
              OR CAST(json_extract(ref.value, '$.slug') AS TEXT) LIKE 'mdoors_%'
        THEN 'qs_2026_05_08' ELSE 'qs_2026_01_04' END,
      CAST(json_extract(ref.value, '$.slug') AS TEXT),
      CASE CAST(json_extract(ref.value, '$.slug') AS TEXT)
        WHEN 'mdoors_part1_demo_2026q2' THEN '【麦门雅思】2026年5-8月口语Part1新题高分demo.pdf'
        WHEN 'mdoors_part2_2026q2' THEN '【麦门雅思】26年5-8月Part2新题保留题_全部串题.pdf'
        WHEN 'mdoors_part3_2026q2' THEN '【麦门雅思】26年5-8月Part3_十大话题高分示范.pdf'
        WHEN 'part1_new_2026q1' THEN 'Part1新题.pdf'
        WHEN 'part2_all_new' THEN 'Part2全部新题串题.pdf'
        WHEN 'part2_people' THEN 'Part2人物类串题.pdf'
        WHEN 'part3_vol1' THEN 'Part3（一）.pdf'
        WHEN 'part3_vol2' THEN 'Part3（二）.pdf'
        ELSE '' END,
      CAST(json_extract(ref.value, '$.page') AS INTEGER)
    FROM questions q, json_each(q.source_refs_json) ref
    WHERE json_type(ref.value, '$.slug') = 'text'
      AND json_type(ref.value, '$.page') = 'integer'
      AND CAST(json_extract(ref.value, '$.slug') AS TEXT) IN (
        'mdoors_part1_demo_2026q2','mdoors_part2_2026q2','mdoors_part3_2026q2',
        'part1_new_2026q1','part2_all_new','part2_people','part3_vol1','part3_vol2'
      )`,
];

async function applyV4Migration(client: Client): Promise<void> {
  for (const stmt of V4_TABLE_DDL) await client.execute(stmt);
}

/** v5：个人回答原文与追加式答案版本。 */
const V5_TABLE_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS personal_answers (
    id TEXT PRIMARY KEY,
    question_id TEXT NOT NULL,
    input_language TEXT NOT NULL CHECK (input_language IN ('zh','en','mixed')),
    raw_text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','queued','processing','ready','needs_attention','failed')),
    current_version_id TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE INDEX IF NOT EXISTS personal_answers_question_idx ON personal_answers (question_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS personal_answers_status_idx ON personal_answers (status, updated_at)`,
  `CREATE TABLE IF NOT EXISTS answer_versions (
    id TEXT PRIMARY KEY,
    answer_id TEXT NOT NULL,
    version_no INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('raw','ai_revised','user_edited')),
    text_en TEXT NOT NULL DEFAULT '',
    text_zh TEXT NOT NULL DEFAULT '',
    change_summary_json TEXT NOT NULL DEFAULT '[]',
    source_job_id TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE (answer_id, version_no)
  )`,
  `CREATE INDEX IF NOT EXISTS answer_versions_answer_idx ON answer_versions (answer_id, created_at)`,
];

async function applyV5Migration(client: Client): Promise<void> {
  for (const stmt of V5_TABLE_DDL) await client.execute(stmt);
}

/** v6：个人词书、个人句子、Chunk 关联与自动审核证据。 */
const V6_TABLE_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS personal_answer_sentences (
    id TEXT PRIMARY KEY,
    answer_id TEXT NOT NULL,
    answer_version_id TEXT NOT NULL,
    question_id TEXT NOT NULL,
    sentence_index INTEGER NOT NULL,
    text_en TEXT NOT NULL,
    text_zh TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE (answer_version_id, sentence_index)
  )`,
  `CREATE INDEX IF NOT EXISTS personal_answer_sentences_answer_idx ON personal_answer_sentences (answer_id, sentence_index)`,
  `CREATE TABLE IF NOT EXISTS personal_chunk_links (
    answer_id TEXT NOT NULL,
    sentence_id TEXT NOT NULL,
    chunk_id TEXT NOT NULL,
    origin TEXT NOT NULL CHECK (origin IN ('public','personal')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','hidden')),
    generator_run_id TEXT NOT NULL,
    reviewer_run_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (answer_id, sentence_id, chunk_id)
  )`,
  `CREATE INDEX IF NOT EXISTS personal_chunk_links_chunk_idx ON personal_chunk_links (chunk_id, status)`,
  `CREATE INDEX IF NOT EXISTS personal_chunk_links_answer_idx ON personal_chunk_links (answer_id, status)`,
  `CREATE TABLE IF NOT EXISTS personal_content_reviews (
    id TEXT PRIMARY KEY,
    answer_id TEXT NOT NULL,
    sentence_id TEXT NOT NULL,
    canonical_chunk TEXT NOT NULL,
    candidate_json TEXT NOT NULL,
    verdict TEXT NOT NULL CHECK (verdict IN ('approved','edited','rejected')),
    reason TEXT NOT NULL DEFAULT '',
    generator_run_id TEXT NOT NULL,
    reviewer_run_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE (reviewer_run_id, sentence_id, canonical_chunk)
  )`,
  `CREATE INDEX IF NOT EXISTS personal_content_reviews_answer_idx ON personal_content_reviews (answer_id, verdict)`,
  `INSERT OR IGNORE INTO books (id, title_zh, title_en, source_type, description_zh, content_version, status, default_accent)
    VALUES ('book_personal_ielts_answers', '我的雅思答案', 'My IELTS Answers', 'personal_answers', '从个人雅思回答中自动生成并经独立 Reviewer 审核的学习材料。', 'personal-v1', 'beta', 'en-GB')`,
];

async function applyV6Migration(client: Client): Promise<void> {
  for (const stmt of V6_TABLE_DDL) await client.execute(stmt);
}

/** v7：输出提示、结构化纠错与逐句重说。 */
const V7_TABLE_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS speaking_sessions (
    id TEXT PRIMARY KEY,
    question_id TEXT NOT NULL,
    answer_id TEXT,
    status TEXT NOT NULL DEFAULT 'preparing' CHECK (status IN ('preparing','ready','evaluating','retrying','completed','failed')),
    chinese_idea TEXT NOT NULL DEFAULT '',
    idea_source TEXT NOT NULL DEFAULT 'ai_generated' CHECK (idea_source IN ('user_history','ai_generated')),
    hints_json TEXT NOT NULL DEFAULT '{}',
    hint_level INTEGER NOT NULL DEFAULT 0,
    response_text TEXT NOT NULL DEFAULT '',
    feedback_json TEXT NOT NULL DEFAULT '{}',
    active_retry_item_id TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE INDEX IF NOT EXISTS speaking_sessions_question_idx ON speaking_sessions (question_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS speaking_sessions_status_idx ON speaking_sessions (status, updated_at)`,
  `CREATE TABLE IF NOT EXISTS speaking_events (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE INDEX IF NOT EXISTS speaking_events_session_idx ON speaking_events (session_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS speaking_attempts (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    attempt_type TEXT NOT NULL CHECK (attempt_type IN ('response','retry')),
    feedback_item_id TEXT,
    text TEXT NOT NULL,
    passed INTEGER,
    ai_job_id TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE INDEX IF NOT EXISTS speaking_attempts_session_idx ON speaking_attempts (session_id, created_at)`,
];

async function applyV7Migration(client: Client): Promise<void> {
  for (const stmt of V7_TABLE_DDL) await client.execute(stmt);
}

/** v8：历史回答、Gap 账本、按题学习包、双语境与消息式口语会话。 */
const V8_ADD_COLUMNS: Array<[string, string, string]> = [
  ["personal_answers", "import_id", "TEXT"],
  ["personal_answers", "source_segment_id", "TEXT"],
  ["personal_answers", "attempt_order", "INTEGER NOT NULL DEFAULT 1"],
  ["personal_answers", "source_order", "INTEGER"],
  ["personal_answers", "source_kind", "TEXT NOT NULL DEFAULT 'runtime'"],
  ["learning_sessions", "step_version", "INTEGER NOT NULL DEFAULT 1"],
  ["learning_sessions", "experience_version", "TEXT NOT NULL DEFAULT 'sentence_v1'"],
  ["learning_sessions", "scope_type", "TEXT NOT NULL DEFAULT 'daily'"],
  ["learning_sessions", "scope_id", "TEXT"],
  ["learning_sessions", "completed_at", "TEXT"],
  ["speaking_sessions", "experience_version", "TEXT NOT NULL DEFAULT 'correction_v1'"],
  ["speaking_sessions", "turn_count", "INTEGER NOT NULL DEFAULT 0"],
  ["speaking_sessions", "source_attempt_id", "TEXT"],
  ["speaking_sessions", "last_error", "TEXT"],
];

const V8_TABLE_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS answer_imports (
    id TEXT PRIMARY KEY,
    source_kind TEXT NOT NULL DEFAULT 'historical',
    source_file_name TEXT NOT NULL,
    source_sha256 TEXT NOT NULL,
    source_bytes INTEGER NOT NULL,
    private_original_path TEXT NOT NULL,
    parser_version TEXT NOT NULL,
    prompt_version TEXT NOT NULL,
    schema_version TEXT NOT NULL,
    run_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'prepared',
    checkpoint_json TEXT NOT NULL DEFAULT '{}',
    summary_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE INDEX IF NOT EXISTS answer_imports_status_idx ON answer_imports (status, updated_at)`,
  `CREATE TABLE IF NOT EXISTS answer_import_segments (
    id TEXT PRIMARY KEY,
    import_id TEXT NOT NULL,
    source_order INTEGER NOT NULL,
    start_offset INTEGER NOT NULL,
    end_offset INTEGER NOT NULL,
    segment_type TEXT NOT NULL,
    raw_text TEXT NOT NULL,
    normalized_text TEXT NOT NULL DEFAULT '',
    question_id TEXT,
    match_method TEXT,
    match_confidence REAL,
    status TEXT NOT NULL DEFAULT 'pending',
    reviewer_run_id TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE (import_id, source_order)
  )`,
  `CREATE INDEX IF NOT EXISTS answer_import_segments_import_idx ON answer_import_segments (import_id, source_order)`,
  `CREATE INDEX IF NOT EXISTS answer_import_segments_question_idx ON answer_import_segments (question_id, segment_type)`,
  `CREATE TABLE IF NOT EXISTS question_aliases (
    id TEXT PRIMARY KEY,
    question_id TEXT NOT NULL,
    alias_text TEXT NOT NULL,
    normalized_alias TEXT NOT NULL,
    source TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE (question_id, normalized_alias)
  )`,
  `CREATE INDEX IF NOT EXISTS question_aliases_norm_idx ON question_aliases (normalized_alias)`,
  `CREATE TABLE IF NOT EXISTS gap_clusters (
    id TEXT PRIMARY KEY,
    canonical_key TEXT NOT NULL UNIQUE,
    title_zh TEXT NOT NULL,
    gap_type TEXT NOT NULL,
    occurrence_count INTEGER NOT NULL DEFAULT 0,
    mastery_status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE TABLE IF NOT EXISTS answer_gaps (
    id TEXT PRIMARY KEY,
    answer_id TEXT NOT NULL,
    answer_version_id TEXT,
    source_segment_id TEXT,
    cluster_id TEXT,
    gap_type TEXT NOT NULL,
    evidence_text TEXT NOT NULL,
    intent_zh TEXT NOT NULL DEFAULT '',
    recommended_expression TEXT NOT NULL DEFAULT '',
    explanation_zh TEXT NOT NULL,
    confidence REAL NOT NULL,
    impact_level TEXT NOT NULL DEFAULT 'medium',
    reviewer_decision TEXT NOT NULL,
    reviewer_reason TEXT NOT NULL,
    reviewer_run_id TEXT NOT NULL,
    learning_fit INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE (answer_id, gap_type, evidence_text, recommended_expression)
  )`,
  `CREATE INDEX IF NOT EXISTS answer_gaps_answer_idx ON answer_gaps (answer_id, status)`,
  `CREATE INDEX IF NOT EXISTS answer_gaps_cluster_idx ON answer_gaps (cluster_id, status)`,
  `CREATE TABLE IF NOT EXISTS question_learning_units (
    id TEXT PRIMARY KEY,
    question_id TEXT NOT NULL,
    gap_id TEXT,
    chunk_id TEXT NOT NULL,
    requirement TEXT NOT NULL DEFAULT 'required',
    priority INTEGER NOT NULL DEFAULT 50,
    source TEXT NOT NULL,
    first_round_completed_at TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE (question_id, chunk_id, source)
  )`,
  `CREATE INDEX IF NOT EXISTS question_learning_units_question_idx ON question_learning_units (question_id, status, priority)`,
  `CREATE INDEX IF NOT EXISTS question_learning_units_chunk_idx ON question_learning_units (chunk_id, status)`,
  `CREATE TABLE IF NOT EXISTS learning_scenarios (
    id TEXT PRIMARY KEY,
    chunk_id TEXT NOT NULL,
    question_id TEXT,
    gap_id TEXT,
    scenario_kind TEXT NOT NULL,
    setting_zh TEXT NOT NULL,
    relationship_zh TEXT NOT NULL DEFAULT '',
    purpose_zh TEXT NOT NULL,
    register TEXT NOT NULL DEFAULT 'neutral',
    accent TEXT NOT NULL DEFAULT 'en-US',
    is_generated INTEGER NOT NULL DEFAULT 1,
    review_decision TEXT NOT NULL DEFAULT 'pending',
    review_reason TEXT NOT NULL DEFAULT '',
    reviewer_run_id TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE (chunk_id, question_id, gap_id, scenario_kind)
  )`,
  `CREATE INDEX IF NOT EXISTS learning_scenarios_chunk_idx ON learning_scenarios (chunk_id, scenario_kind)`,
  `CREATE TABLE IF NOT EXISTS learning_scenario_lines (
    id TEXT PRIMARY KEY,
    scenario_id TEXT NOT NULL,
    line_order INTEGER NOT NULL,
    speaker TEXT NOT NULL,
    text_en TEXT NOT NULL,
    text_zh TEXT NOT NULL,
    is_target INTEGER NOT NULL DEFAULT 0,
    annotation_status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE (scenario_id, line_order)
  )`,
  `CREATE INDEX IF NOT EXISTS learning_scenario_lines_scenario_idx ON learning_scenario_lines (scenario_id, line_order)`,
  `CREATE TABLE IF NOT EXISTS audio_assets (
    id TEXT PRIMARY KEY,
    content_hash TEXT NOT NULL,
    purpose TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    voice TEXT NOT NULL,
    accent TEXT NOT NULL DEFAULT 'en-US',
    speed REAL NOT NULL DEFAULT 1,
    format TEXT NOT NULL DEFAULT 'opus',
    relative_path TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    version TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE (content_hash, provider, model, voice, speed, version)
  )`,
  `CREATE TABLE IF NOT EXISTS speaking_messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    sequence_no INTEGER NOT NULL,
    role TEXT NOT NULL,
    message_kind TEXT NOT NULL DEFAULT 'text',
    text TEXT NOT NULL,
    input_language TEXT,
    local_audio_ref TEXT,
    status TEXT NOT NULL DEFAULT 'sent',
    client_message_id TEXT NOT NULL,
    ai_run_id TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE (session_id, client_message_id),
    UNIQUE (session_id, sequence_no)
  )`,
  `CREATE INDEX IF NOT EXISTS speaking_messages_session_idx ON speaking_messages (session_id, sequence_no)`,
  `CREATE TABLE IF NOT EXISTS speaking_gap_links (
    message_id TEXT NOT NULL,
    gap_id TEXT NOT NULL,
    comparison TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (message_id, gap_id)
  )`,
  `CREATE INDEX IF NOT EXISTS speaking_gap_links_gap_idx ON speaking_gap_links (gap_id, comparison)`,
  `CREATE TABLE IF NOT EXISTS learning_inbox_items (
    id TEXT PRIMARY KEY,
    source_type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    chunk_id TEXT,
    lexeme_id TEXT,
    example_id TEXT,
    surface TEXT NOT NULL,
    meaning_zh TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL,
    occurrence_count INTEGER NOT NULL DEFAULT 1,
    user_note TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE (source_type, source_id, surface)
  )`,
  `CREATE INDEX IF NOT EXISTS learning_inbox_items_status_idx ON learning_inbox_items (status, updated_at)`,
  `CREATE INDEX IF NOT EXISTS learning_inbox_items_chunk_idx ON learning_inbox_items (chunk_id, status)`,
];

async function applyV8Migration(client: Client): Promise<void> {
  for (const [table, column, definition] of V8_ADD_COLUMNS) {
    if (!(await hasColumn(client, table, column))) {
      await client.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  // v5 的 CHECK 只允许 raw；兼容重建后保留 raw，并允许新的四层版本类型。
  const answerVersionsSql = await client.execute(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'answer_versions'",
  );
  const createSql = String(answerVersionsSql.rows[0]?.sql ?? "");
  if (!createSql.includes("normalized_transcript")) {
    await client.execute("ALTER TABLE answer_versions RENAME TO answer_versions_v7");
    await client.execute(`CREATE TABLE answer_versions (
      id TEXT PRIMARY KEY,
      answer_id TEXT NOT NULL,
      version_no INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('raw','raw_transcript','normalized_transcript','ai_revised','user_edited')),
      text_en TEXT NOT NULL DEFAULT '',
      text_zh TEXT NOT NULL DEFAULT '',
      change_summary_json TEXT NOT NULL DEFAULT '[]',
      source_job_id TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      UNIQUE (answer_id, version_no)
    )`);
    await client.execute(`INSERT INTO answer_versions
      (id, answer_id, version_no, kind, text_en, text_zh, change_summary_json, source_job_id, created_at)
      SELECT id, answer_id, version_no, kind, text_en, text_zh, change_summary_json, source_job_id, created_at
      FROM answer_versions_v7`);
    await client.execute("DROP TABLE answer_versions_v7");
    await client.execute("CREATE INDEX IF NOT EXISTS answer_versions_answer_idx ON answer_versions (answer_id, created_at)");
  }

  for (const stmt of V8_TABLE_DDL) await client.execute(stmt);

  await client.execute(`INSERT OR IGNORE INTO learning_inbox_items
    (id, source_type, source_id, chunk_id, surface, meaning_zh, reason, occurrence_count, user_note, status, created_at, updated_at)
    SELECT 'legacy_' || id, 'legacy_difficult_note', id, chunk_id, surface, meaning_zh,
      last_trigger, trigger_count, user_remark, status, created_at, updated_at
    FROM difficult_notes`);
}

/** v9：放宽旧版一次性纠错会话的状态约束，支持可恢复的消息式 AI 老师。 */
const V9_TABLE_DDL: string[] = [
  `CREATE TABLE speaking_sessions_v9 (
    id TEXT PRIMARY KEY,
    question_id TEXT NOT NULL,
    answer_id TEXT,
    status TEXT NOT NULL DEFAULT 'preparing' CHECK (status IN ('preparing','ready','evaluating','retrying','conversing','teacher_responding','ai_failed','completed','failed')),
    chinese_idea TEXT NOT NULL DEFAULT '',
    idea_source TEXT NOT NULL DEFAULT 'ai_generated' CHECK (idea_source IN ('user_history','ai_generated')),
    hints_json TEXT NOT NULL DEFAULT '{}',
    hint_level INTEGER NOT NULL DEFAULT 0,
    response_text TEXT NOT NULL DEFAULT '',
    feedback_json TEXT NOT NULL DEFAULT '{}',
    active_retry_item_id TEXT,
    experience_version TEXT NOT NULL DEFAULT 'correction_v1',
    turn_count INTEGER NOT NULL DEFAULT 0,
    source_attempt_id TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `INSERT INTO speaking_sessions_v9
    (id, question_id, answer_id, status, chinese_idea, idea_source, hints_json, hint_level, response_text,
      feedback_json, active_retry_item_id, experience_version, turn_count, source_attempt_id, last_error, created_at, updated_at)
    SELECT id, question_id, answer_id, status, chinese_idea, idea_source, hints_json, hint_level, response_text,
      feedback_json, active_retry_item_id, experience_version, turn_count, source_attempt_id, last_error, created_at, updated_at
    FROM speaking_sessions`,
  `DROP TABLE speaking_sessions`,
  `ALTER TABLE speaking_sessions_v9 RENAME TO speaking_sessions`,
  `CREATE INDEX speaking_sessions_question_idx ON speaking_sessions (question_id, created_at)`,
  `CREATE INDEX speaking_sessions_status_idx ON speaking_sessions (status, updated_at)`,
];

async function applyV9Migration(client: Client): Promise<void> {
  for (const stmt of V9_TABLE_DDL) await client.execute(stmt);
}

/** v10：为重答比较保留可审计的关联、理由和独立 Comparator runId。 */
const V10_ADD_COLUMNS: Array<[string, string, string]> = [
  ["speaking_gap_links", "related_gap_id", "TEXT"],
  ["speaking_gap_links", "reason", "TEXT NOT NULL DEFAULT ''"],
  ["speaking_gap_links", "comparator_run_id", "TEXT NOT NULL DEFAULT ''"],
];

async function applyV10Migration(client: Client): Promise<void> {
  for (const [table, column, definition] of V10_ADD_COLUMNS) {
    if (!(await hasColumn(client, table, column))) {
      await client.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }
}

const V11_TABLE_DDL = [
  `CREATE TABLE IF NOT EXISTS content_amendments (
    id TEXT PRIMARY KEY, chunk_id TEXT NOT NULL, action TEXT NOT NULL CHECK(action IN ('edit','reject')),
    before_json TEXT NOT NULL, after_json TEXT NOT NULL, reason TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE INDEX IF NOT EXISTS content_amendments_chunk_idx ON content_amendments (chunk_id, created_at)`,
];

const V12_ADD_COLUMNS: Array<[string, string, string]> = [
  ["personal_answers", "source_revision_id", "TEXT"],
  ["personal_answers", "superseded_by_revision_id", "TEXT"],
];
const V12_TABLE_DDL = [
  `CREATE TABLE IF NOT EXISTS answer_import_revisions (
    id TEXT PRIMARY KEY, import_id TEXT NOT NULL, source_sha256 TEXT NOT NULL,
    base_segments_sha256 TEXT NOT NULL, review_sha256 TEXT NOT NULL, input_sha256 TEXT NOT NULL,
    reviewer_run_id TEXT NOT NULL, reviewer_session_id TEXT NOT NULL, prompt_version TEXT NOT NULL,
    snapshot_json TEXT NOT NULL, before_links_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE(import_id, review_sha256)
  )`,
  `CREATE TABLE IF NOT EXISTS answer_import_revision_segments (
    revision_id TEXT NOT NULL, segment_id TEXT NOT NULL, source_order INTEGER NOT NULL,
    start_offset INTEGER NOT NULL, end_offset INTEGER NOT NULL, segment_type TEXT NOT NULL,
    raw_text TEXT NOT NULL, question_id TEXT, answer_group_key TEXT, original_segment_ids_json TEXT NOT NULL,
    reviewed INTEGER NOT NULL, PRIMARY KEY(revision_id, segment_id), UNIQUE(revision_id, source_order)
  )`,
  `CREATE INDEX IF NOT EXISTS answer_import_revisions_import_idx ON answer_import_revisions(import_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS personal_answers_active_idx ON personal_answers(question_id, superseded_by_revision_id)`,
];

const V13_TABLE_DDL = [
  `CREATE TABLE IF NOT EXISTS personal_diagnosis_batches (
    id TEXT PRIMARY KEY, input_sha256 TEXT NOT NULL UNIQUE, generation_sha256 TEXT NOT NULL, review_sha256 TEXT NOT NULL,
    generator_run_id TEXT NOT NULL UNIQUE, reviewer_run_id TEXT NOT NULL UNIQUE,
    schema_version TEXT NOT NULL, snapshot_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE TABLE IF NOT EXISTS personal_gap_evidence (
    gap_id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, answer_id TEXT NOT NULL, candidate_key TEXT NOT NULL,
    start_offset INTEGER NOT NULL, end_offset INTEGER NOT NULL, source_start_offset INTEGER NOT NULL,
    source_end_offset INTEGER NOT NULL, source_revision_id TEXT, raw_sha256 TEXT NOT NULL,
    UNIQUE(batch_id,answer_id,candidate_key)
  )`,
  `CREATE INDEX IF NOT EXISTS personal_gap_evidence_answer_idx ON personal_gap_evidence(answer_id,batch_id)`,
];

/**
 * 迁移编号必须连续且 checksum 未被篡改。
 * 旧实现只按版本号逐条判断，出现空洞或被改动过的 DDL 也不会报错，是内容漂移的温床。
 */
const V14_TABLE_DDL = [`CREATE TABLE IF NOT EXISTS learning_round_settlements (
      session_id TEXT NOT NULL, chunk_id TEXT NOT NULL, completed_at TEXT NOT NULL,
      PRIMARY KEY (session_id, chunk_id))`];

/** v15：Gap 提取证据、个人变体，以及 Chloe 的统一线程与长期记忆。 */
const V15_ADD_COLUMNS: Array<[string, string, string]> = [
  ["learning_sessions", "companion_thread_id", "TEXT"],
  ["speaking_sessions", "companion_thread_id", "TEXT"],
];

const V15_TABLE_DDL = [
  `CREATE TABLE IF NOT EXISTS retrieval_attempts (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, learning_unit_id TEXT, gap_id TEXT,
    chunk_id TEXT NOT NULL, question_id TEXT, phase TEXT NOT NULL, cue_id TEXT,
    cue_hash TEXT NOT NULL, raw_input TEXT NOT NULL DEFAULT '', normalized_input TEXT NOT NULL DEFAULT '',
    judgement_route TEXT NOT NULL, verdict TEXT NOT NULL, assistance_level INTEGER NOT NULL DEFAULT 0,
    feedback_json TEXT NOT NULL DEFAULT '{}', judge_prompt_version TEXT NOT NULL DEFAULT 'gap-retrieval-judge-v1',
    ai_job_id TEXT, ai_run_id TEXT, client_event_id TEXT NOT NULL, local_date TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS retrieval_attempts_client_unique ON retrieval_attempts(client_event_id)`,
  `CREATE INDEX IF NOT EXISTS retrieval_attempts_session_idx ON retrieval_attempts(session_id,created_at)`,
  `CREATE INDEX IF NOT EXISTS retrieval_attempts_cache_idx ON retrieval_attempts(chunk_id,gap_id,cue_hash,normalized_input,judge_prompt_version)`,
  `CREATE TABLE IF NOT EXISTS expression_variants (
    id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, chunk_id TEXT NOT NULL, gap_cluster_id TEXT,
    expression TEXT NOT NULL, normalized_expression TEXT NOT NULL, relation TEXT NOT NULL DEFAULT 'pending',
    register TEXT NOT NULL DEFAULT 'neutral', context_constraints_json TEXT NOT NULL DEFAULT '{}',
    frequency_relation TEXT NOT NULL DEFAULT 'unknown', source_attempt_id TEXT NOT NULL,
    review_decision TEXT NOT NULL DEFAULT 'pending', review_reason TEXT NOT NULL DEFAULT '', reviewer_run_id TEXT,
    preferred INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE(scope_key,normalized_expression)
  )`,
  `CREATE INDEX IF NOT EXISTS expression_variants_chunk_idx ON expression_variants(chunk_id,review_decision,active)`,
  `CREATE TABLE IF NOT EXISTS learning_experiment_assignments (
    experiment_id TEXT NOT NULL, chunk_id TEXT NOT NULL, gap_id TEXT, question_id TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY(experiment_id,chunk_id)
  )`,
  `CREATE INDEX IF NOT EXISTS learning_experiment_assignments_question_idx ON learning_experiment_assignments(experiment_id,question_id,status)`,
  `CREATE TABLE IF NOT EXISTS companion_threads (
    id TEXT PRIMARY KEY, scope_key TEXT NOT NULL UNIQUE, scope_type TEXT NOT NULL, scope_id TEXT,
    title TEXT NOT NULL DEFAULT '和 Chloe 的对话', status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE INDEX IF NOT EXISTS companion_threads_scope_idx ON companion_threads(scope_type,scope_id)`,
  `CREATE TABLE IF NOT EXISTS companion_messages (
    id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, sequence_no INTEGER NOT NULL, role TEXT NOT NULL,
    message_kind TEXT NOT NULL DEFAULT 'text', text TEXT NOT NULL, input_language TEXT,
    status TEXT NOT NULL DEFAULT 'sent', client_message_id TEXT NOT NULL,
    source_type TEXT NOT NULL DEFAULT 'companion', source_id TEXT, ai_run_id TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE(thread_id,client_message_id), UNIQUE(thread_id,sequence_no)
  )`,
  `CREATE INDEX IF NOT EXISTS companion_messages_thread_idx ON companion_messages(thread_id,sequence_no)`,
  `CREATE TABLE IF NOT EXISTS companion_memories (
    id TEXT PRIMARY KEY, category TEXT NOT NULL, summary TEXT NOT NULL, detail_json TEXT NOT NULL DEFAULT '{}',
    scope_type TEXT NOT NULL DEFAULT 'global', scope_id TEXT, confidence REAL NOT NULL DEFAULT 1,
    source_type TEXT NOT NULL, source_id TEXT NOT NULL, evidence_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'active', superseded_by_id TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), deleted_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS companion_memories_status_idx ON companion_memories(status,category,updated_at)`,
  `CREATE INDEX IF NOT EXISTS companion_memories_scope_idx ON companion_memories(scope_type,scope_id,status)`,
];

const V15_BACKFILL_SQL = [
  `INSERT OR IGNORE INTO companion_threads (id,scope_key,scope_type,scope_id,title,created_at,updated_at)
    SELECT 'companion_question_' || question_id, 'question:' || question_id, 'question', question_id,
      '雅思题目 · Chloe', MIN(created_at), MAX(updated_at)
    FROM speaking_sessions GROUP BY question_id`,
  `UPDATE speaking_sessions SET companion_thread_id='companion_question_' || question_id
    WHERE companion_thread_id IS NULL`,
  `UPDATE learning_sessions SET companion_thread_id='companion_question_' || scope_id
    WHERE companion_thread_id IS NULL AND scope_type='question' AND scope_id IS NOT NULL`,
  `INSERT OR IGNORE INTO companion_messages
    (id,thread_id,sequence_no,role,message_kind,text,input_language,status,client_message_id,source_type,source_id,ai_run_id,metadata_json,created_at)
    SELECT sm.id, 'companion_question_' || ss.question_id,
      ROW_NUMBER() OVER (PARTITION BY ss.question_id ORDER BY ss.created_at,sm.created_at,sm.sequence_no,sm.id),
      sm.role,sm.message_kind,sm.text,sm.input_language,sm.status,
      'legacy:' || sm.session_id || ':' || sm.client_message_id,'legacy_speaking',sm.id,sm.ai_run_id,sm.metadata_json,sm.created_at
    FROM speaking_messages sm JOIN speaking_sessions ss ON ss.id=sm.session_id`,
];

/** v16：雅思口语答题练习与 AI Free Talk */
const V16_TABLE_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS speaking_question_attempts (
    id TEXT PRIMARY KEY,
    question_id TEXT NOT NULL,
    mode TEXT NOT NULL,
    answer_text TEXT NOT NULL,
    intended_meaning_zh TEXT NOT NULL,
    natural_version TEXT NOT NULL DEFAULT '',
    gap_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'completed',
    analysis_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE INDEX IF NOT EXISTS speaking_question_attempts_question_idx ON speaking_question_attempts (question_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS speaking_question_attempts_mode_idx ON speaking_question_attempts (mode, created_at)`,
  `CREATE TABLE IF NOT EXISTS learning_items (
    id TEXT PRIMARY KEY,
    canonical_key TEXT NOT NULL UNIQUE,
    target_english TEXT NOT NULL,
    intention_zh TEXT NOT NULL,
    item_type TEXT NOT NULL DEFAULT 'lexical_chunk',
    example_sentence TEXT NOT NULL DEFAULT '',
    encounter_count INTEGER NOT NULL DEFAULT 1,
    first_source_type TEXT NOT NULL,
    first_source_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE INDEX IF NOT EXISTS learning_items_canonical_idx ON learning_items (canonical_key)`,
  `CREATE INDEX IF NOT EXISTS learning_items_status_idx ON learning_items (status, updated_at)`,
  `CREATE TABLE IF NOT EXISTS gap_events (
    id TEXT PRIMARY KEY,
    learning_item_id TEXT NOT NULL,
    source_type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    question_id TEXT,
    evidence_text TEXT NOT NULL,
    intent_zh TEXT NOT NULL,
    target_english TEXT NOT NULL,
    explanation_zh TEXT NOT NULL DEFAULT '',
    gap_type TEXT NOT NULL DEFAULT 'lexical_gap',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE INDEX IF NOT EXISTS gap_events_source_idx ON gap_events (source_type, source_id)`,
  `CREATE INDEX IF NOT EXISTS gap_events_item_idx ON gap_events (learning_item_id)`,
  `CREATE INDEX IF NOT EXISTS gap_events_question_idx ON gap_events (question_id)`,
  `CREATE TABLE IF NOT EXISTS free_talk_conversations (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT 'AI Free Talk',
    mode TEXT NOT NULL DEFAULT 'relaxed',
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE INDEX IF NOT EXISTS free_talk_conversations_status_idx ON free_talk_conversations (status, updated_at)`,
  `CREATE TABLE IF NOT EXISTS free_talk_messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    sequence_no INTEGER NOT NULL,
    role TEXT NOT NULL,
    text TEXT NOT NULL,
    teaching_state TEXT,
    target_repetition TEXT,
    gap_count INTEGER NOT NULL DEFAULT 0,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE(conversation_id, sequence_no)
  )`,
  `CREATE INDEX IF NOT EXISTS free_talk_messages_conv_idx ON free_talk_messages (conversation_id, sequence_no)`,
];

/** v17：题目掌握度生命周期与复习时间追踪 */
const V17_TABLE_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS question_mastery (
    question_id TEXT PRIMARY KEY,
    mastered INTEGER NOT NULL DEFAULT 0,
    mastery_source TEXT NOT NULL DEFAULT 'manual',
    last_practiced_at TEXT,
    last_learned_at TEXT,
    four_step_completed_at TEXT,
    review_count INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE INDEX IF NOT EXISTS question_mastery_mastered_idx ON question_mastery (mastered, updated_at)`,
];

async function assertMigrationContinuity(client: Client): Promise<void> {
  const rows = await client.execute(
    `SELECT version, name, checksum FROM _schema_migrations ORDER BY version`,
  );
  const versions = rows.rows.map((row) => Number(row.version));
  const expected = versions.map((_, index) => index + 1);
  if (versions.length && versions.join(",") !== expected.join(",")) {
    throw new Error(`数据库迁移编号不连续：现有 [${versions.join(", ")}]，应为 [${expected.join(", ")}]`);
  }
  const knownChecksums = new Map<number, string>([
    [1, checksum(BASE_DDL)],
    [2, checksum([...ADD_COLUMNS.map((x) => x.join(" ")), ...RECOVERY_TABLE_DDL])],
    [3, checksum(V3_TABLE_DDL)],
    [4, checksum(V4_TABLE_DDL)],
    [5, checksum(V5_TABLE_DDL)],
    [6, checksum(V6_TABLE_DDL)],
    [7, checksum(V7_TABLE_DDL)],
    [8, checksum([...V8_ADD_COLUMNS.map((x) => x.join(" ")), ...V8_TABLE_DDL])],
    [9, checksum(V9_TABLE_DDL)],
    [10, checksum(V10_ADD_COLUMNS.map((x) => x.join(" ")))],
    [11, checksum(V11_TABLE_DDL)],
    [12, checksum([...V12_ADD_COLUMNS.map((x) => x.join(" ")), ...V12_TABLE_DDL])],
    [13, checksum(V13_TABLE_DDL)],
    [14, checksum(V14_TABLE_DDL)],
    [15, checksum([...V15_ADD_COLUMNS.map((x) => x.join(" ")), ...V15_TABLE_DDL, ...V15_BACKFILL_SQL])],
    [16, checksum(V16_TABLE_DDL)],
    [17, checksum(V17_TABLE_DDL)],
    [18, checksum(V18_DDL)],
    [19, checksum(V19_DDL)],
    [20, checksum(V20_DDL)],
    [21, checksum(V21_DDL)],
    [22, checksum(V22_DDL)],
    [23, checksum(V23_DDL)],
    [24, checksum(V24_DDL)],
    [25, checksum(V25_DDL)],
    [26, checksum(V26_DDL)],
    [27, checksum(V27_DDL)],
    [28, checksum(V28_DDL)],
    [29, checksum(V29_DDL)],
    [30, checksum(V30_DDL)],
    [31, checksum(V31_DDL)],
    [32, checksum(V32_DDL)],
    [33, checksum(V33_DDL)],
    [34, checksum(V34_DDL)],
  ]);
  for (const row of rows.rows) {
    const version = Number(row.version);
    const expectedChecksum = knownChecksums.get(version);
    // 已核对的真实早期 v19：唯一差异是尚未加入 practice_material_revisions。
    // 不覆盖旧校验记录；v21 对这份旧结构追加补表，其他未知 checksum 仍拒绝。
    if (version===19 && String(row.checksum)===checksum(V19_DDL.filter((ddl)=>!ddl.includes("practice_material_revisions")))) continue;
    if (expectedChecksum && String(row.checksum) !== expectedChecksum) {
      throw new Error(`迁移 v${version}（${String(row.name)}）的 checksum 与已知代码不一致，须核查历史版本后再继续`);
    }
  }
}

async function hasColumn(client: Client, table: string, column: string): Promise<boolean> {
  const result = await client.execute(`PRAGMA table_info(${table})`);
  return result.rows.some((row) => String(row.name) === column);
}

function checksum(statements: string[]): string {
  return createHash("sha256").update(statements.join("\n")).digest("hex");
}

async function backupLocalDatabase(client: Client, dbUrl: string, version: number): Promise<string | null> {
  if (!dbUrl.startsWith("file:") || process.env.ROASTDUCK_SKIP_DB_BACKUP === "1") return null;
  const rawPath = dbUrl.slice("file:".length).split("?")[0];
  const databasePath = path.resolve(rawPath);
  if (!fs.existsSync(databasePath) || fs.statSync(databasePath).size === 0) return null;
  await client.execute("PRAGMA wal_checkpoint(FULL)");
  const backupDir = path.join(path.dirname(databasePath), "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(backupDir, `${path.basename(databasePath)}.pre-v${version}.${stamp}.bak`);
  fs.copyFileSync(databasePath, backupPath);
  return backupPath;
}

async function applyRecoveryMigration(client: Client): Promise<void> {
  for (const [table, column, definition] of ADD_COLUMNS) {
    if (!(await hasColumn(client, table, column))) {
      await client.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }
  for (const stmt of RECOVERY_TABLE_DDL) await client.execute(stmt);

  // 旧版本的 rule_review 不能作为独立 Reviewer 证据，重新打开正式质检。
  await client.execute(`UPDATE chunks
    SET quality_status = 'pending_review', review_provenance = 'unreviewed', reviewer_version = NULL, reviewed_at = NULL
    WHERE quality_status IN ('approved', 'edited') AND review_provenance = 'unreviewed'`);

  // 从既有 Coverage/Source 信息确定性回填多对多关联，不猜测新关系。
  await client.execute(`INSERT OR IGNORE INTO chunk_question_links (chunk_id, question_id, relation, answer_dimension_id)
    SELECT chunk_id, question_id, 'coverage', dim_id FROM chunk_coverage_refs WHERE question_id IS NOT NULL`);
  await client.execute(`INSERT OR IGNORE INTO chunk_question_links (chunk_id, question_id, relation)
    SELECT chunk_id, question_id, 'source' FROM chunk_sources WHERE question_id IS NOT NULL`);
  await client.execute(`INSERT OR IGNORE INTO chunk_topic_links (chunk_id, topic_id, relation, is_primary)
    SELECT DISTINCT r.chunk_id, r.topic_id, 'coverage', 0 FROM chunk_coverage_refs r WHERE r.topic_id IS NOT NULL`);
  await client.execute(`INSERT OR IGNORE INTO chunk_topic_links (chunk_id, topic_id, relation, is_primary)
    SELECT DISTINCT l.chunk_id, q.topic_id, l.relation, 0
    FROM chunk_question_links l JOIN questions q ON q.id = l.question_id WHERE q.topic_id IS NOT NULL`);
  await client.execute(`UPDATE chunk_topic_links SET is_primary = 1
    WHERE rowid IN (SELECT MIN(rowid) FROM chunk_topic_links GROUP BY chunk_id)`);
  await client.execute(`UPDATE chunks SET topic_id = (
    SELECT topic_id FROM chunk_topic_links l WHERE l.chunk_id = chunks.id ORDER BY is_primary DESC, topic_id LIMIT 1
  ) WHERE topic_id IS NULL AND EXISTS (SELECT 1 FROM chunk_topic_links l WHERE l.chunk_id = chunks.id)`);
  await client.execute(`UPDATE chunks SET ielts_part = (
    SELECT q.part FROM chunk_question_links l JOIN questions q ON q.id = l.question_id
    WHERE l.chunk_id = chunks.id ORDER BY q.part LIMIT 1
  ) WHERE ielts_part IS NULL`);
  await client.execute(`UPDATE chunk_examples SET
    context_type = CASE WHEN is_source_sentence = 1 THEN 'source_neighbors' ELSE 'generated_ielts' END,
    generated = CASE WHEN is_source_sentence = 1 THEN 0 ELSE 1 END`);
}

export async function ensureSchema(client: Client, dbUrl = "file:./data/app.db"): Promise<void> {
  const migrationTable=await client.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='_schema_migrations'");
  if(migrationTable.rows.length) await assertMigrationContinuity(client);
  for (const stmt of BASE_DDL) {
    await client.execute(stmt);
  }

  await client.execute(`CREATE TABLE IF NOT EXISTS _schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    backup_path TEXT,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`);
  await client.execute({
    sql: `INSERT OR IGNORE INTO _schema_migrations (version, name, checksum) VALUES (?, ?, ?)`,
    args: [1, "initial_schema", checksum(BASE_DDL)],
  });

  const applied = await client.execute({ sql: "SELECT version FROM _schema_migrations WHERE version = ?", args: [2] });
  if (applied.rows.length === 0) {
    const backupPath = await backupLocalDatabase(client, dbUrl, 2);
    await applyRecoveryMigration(client);
    await client.execute({
      sql: `INSERT INTO _schema_migrations (version, name, checksum, backup_path) VALUES (?, ?, ?, ?)`,
      args: [2, "sentence_first_recovery", checksum([...ADD_COLUMNS.map((x) => x.join(" ")), ...RECOVERY_TABLE_DDL]), backupPath],
    });
    if (backupPath) console.log(`数据库迁移前备份: ${backupPath}`);
  }

  const v3 = await client.execute({ sql: "SELECT version FROM _schema_migrations WHERE version = ?", args: [3] });
  if (v3.rows.length === 0) {
    const backupPath = await backupLocalDatabase(client, dbUrl, 3);
    await applyV3Migration(client);
    await client.execute({
      sql: `INSERT INTO _schema_migrations (version, name, checksum, backup_path) VALUES (?, ?, ?, ?)`,
      args: [3, "user_settings_and_ai_audit", checksum(V3_TABLE_DDL), backupPath],
    });
    if (backupPath) console.log(`数据库迁移前备份: ${backupPath}`);
  }

  const v4 = await client.execute({ sql: "SELECT version FROM _schema_migrations WHERE version = ?", args: [4] });
  if (v4.rows.length === 0) {
    const backupPath = await backupLocalDatabase(client, dbUrl, 4);
    await applyV4Migration(client);
    await client.execute({
      sql: `INSERT INTO _schema_migrations (version, name, checksum, backup_path) VALUES (?, ?, ?, ?)`,
      args: [4, "question_library", checksum(V4_TABLE_DDL), backupPath],
    });
    if (backupPath) console.log(`数据库迁移前备份: ${backupPath}`);
  }

  const v5 = await client.execute({ sql: "SELECT version FROM _schema_migrations WHERE version = ?", args: [5] });
  if (v5.rows.length === 0) {
    const backupPath = await backupLocalDatabase(client, dbUrl, 5);
    await applyV5Migration(client);
    await client.execute({
      sql: `INSERT INTO _schema_migrations (version, name, checksum, backup_path) VALUES (?, ?, ?, ?)`,
      args: [5, "personal_answer_core", checksum(V5_TABLE_DDL), backupPath],
    });
    if (backupPath) console.log(`数据库迁移前备份: ${backupPath}`);
  }

  const v6 = await client.execute({ sql: "SELECT version FROM _schema_migrations WHERE version = ?", args: [6] });
  if (v6.rows.length === 0) {
    const backupPath = await backupLocalDatabase(client, dbUrl, 6);
    await applyV6Migration(client);
    await client.execute({
      sql: `INSERT INTO _schema_migrations (version, name, checksum, backup_path) VALUES (?, ?, ?, ?)`,
      args: [6, "personal_content_pipeline", checksum(V6_TABLE_DDL), backupPath],
    });
    if (backupPath) console.log(`数据库迁移前备份: ${backupPath}`);
  }

  const v7 = await client.execute({ sql: "SELECT version FROM _schema_migrations WHERE version = ?", args: [7] });
  if (v7.rows.length === 0) {
    const backupPath = await backupLocalDatabase(client, dbUrl, 7);
    await applyV7Migration(client);
    await client.execute({
      sql: `INSERT INTO _schema_migrations (version, name, checksum, backup_path) VALUES (?, ?, ?, ?)`,
      args: [7, "speaking_correction_loop", checksum(V7_TABLE_DDL), backupPath],
    });
    if (backupPath) console.log(`数据库迁移前备份: ${backupPath}`);
  }

  const v8 = await client.execute({ sql: "SELECT version FROM _schema_migrations WHERE version = ?", args: [8] });
  if (v8.rows.length === 0) {
    const backupPath = await backupLocalDatabase(client, dbUrl, 8);
    await applyV8Migration(client);
    await client.execute({
      sql: `INSERT INTO _schema_migrations (version, name, checksum, backup_path) VALUES (?, ?, ?, ?)`,
      args: [8, "historical_answers_and_context_learning", checksum([...V8_ADD_COLUMNS.map((x) => x.join(" ")), ...V8_TABLE_DDL]), backupPath],
    });
    if (backupPath) console.log(`数据库迁移前备份: ${backupPath}`);
  }

  const v9 = await client.execute({ sql: "SELECT version FROM _schema_migrations WHERE version = ?", args: [9] });
  if (v9.rows.length === 0) {
    const backupPath = await backupLocalDatabase(client, dbUrl, 9);
    await applyV9Migration(client);
    await client.execute({
      sql: `INSERT INTO _schema_migrations (version, name, checksum, backup_path) VALUES (?, ?, ?, ?)`,
      args: [9, "speaking_teacher_chat_states", checksum(V9_TABLE_DDL), backupPath],
    });
    if (backupPath) console.log(`数据库迁移前备份: ${backupPath}`);
  }

  const v10 = await client.execute({ sql: "SELECT version FROM _schema_migrations WHERE version = ?", args: [10] });
  if (v10.rows.length === 0) {
    const backupPath = await backupLocalDatabase(client, dbUrl, 10);
    await applyV10Migration(client);
    await client.execute({
      sql: `INSERT INTO _schema_migrations (version, name, checksum, backup_path) VALUES (?, ?, ?, ?)`,
      args: [10, "speaking_gap_comparison_evidence", checksum(V10_ADD_COLUMNS.map((x) => x.join(" "))), backupPath],
    });
    if (backupPath) console.log(`数据库迁移前备份: ${backupPath}`);
  }

  const v11 = await client.execute({ sql: "SELECT version FROM _schema_migrations WHERE version = ?", args: [11] });
  if (v11.rows.length === 0) {
    const backupPath = await backupLocalDatabase(client, dbUrl, 11);
    for (const statement of V11_TABLE_DDL) await client.execute(statement);
    await client.execute({
      sql: "INSERT INTO _schema_migrations (version, name, checksum, backup_path) VALUES (?, ?, ?, ?)",
      args: [11, "content_amendment_history", checksum(V11_TABLE_DDL), backupPath],
    });
    if (backupPath) console.log(`数据库迁移前备份: ${backupPath}`);
  }
  const v12 = await client.execute({ sql: "SELECT version FROM _schema_migrations WHERE version = ?", args: [12] });
  if (v12.rows.length === 0) {
    const backupPath = await backupLocalDatabase(client, dbUrl, 12);
    for (const [table, column, definition] of V12_ADD_COLUMNS) {
      if (!(await hasColumn(client, table, column))) await client.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
    for (const statement of V12_TABLE_DDL) await client.execute(statement);
    await client.execute({
      sql: "INSERT INTO _schema_migrations (version, name, checksum, backup_path) VALUES (?, ?, ?, ?)",
      args: [12, "append_only_import_segmentation_revisions", checksum([...V12_ADD_COLUMNS.map((x) => x.join(" ")), ...V12_TABLE_DDL]), backupPath],
    });
    if (backupPath) console.log(`数据库迁移前备份: ${backupPath}`);
  }
  const v13 = await client.execute({ sql: "SELECT version FROM _schema_migrations WHERE version = ?", args: [13] });
  if (v13.rows.length === 0) {
    const backupPath = await backupLocalDatabase(client, dbUrl, 13);
    for (const statement of V13_TABLE_DDL) await client.execute(statement);
    await client.execute({
      sql: "INSERT INTO _schema_migrations (version, name, checksum, backup_path) VALUES (?, ?, ?, ?)",
      args: [13, "offline_personal_gap_evidence", checksum(V13_TABLE_DDL), backupPath],
    });
    if (backupPath) console.log(`数据库迁移前备份: ${backupPath}`);
  }
  const v14 = await client.execute({ sql: 'SELECT version FROM _schema_migrations WHERE version = ?', args: [14] });
  if (!v14.rows.length) {
    const ddl = V14_TABLE_DDL[0];
    const backupPath = await backupLocalDatabase(client, dbUrl, 14);
    const tx = await client.transaction('write');
    try {
      await tx.execute(ddl);
      await tx.execute({ sql: 'INSERT INTO _schema_migrations (version,name,checksum,backup_path) VALUES (?,?,?,?)', args: [14, 'atomic_learning_round_settlements', checksum([ddl]), backupPath] });
      await tx.commit();
    } catch (error) { await tx.rollback(); throw error; }
  }
  const v15 = await client.execute({ sql: "SELECT version FROM _schema_migrations WHERE version = ?", args: [15] });
  if (!v15.rows.length) {
    const backupPath = await backupLocalDatabase(client, dbUrl, 15);
    const columns = [] as Array<[string, string, string]>;
    for (const column of V15_ADD_COLUMNS) {
      if (!(await hasColumn(client, column[0], column[1]))) columns.push(column);
    }
    const tx = await client.transaction("write");
    try {
      for (const [table, column, definition] of columns) await tx.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      for (const statement of V15_TABLE_DDL) await tx.execute(statement);
      for (const statement of V15_BACKFILL_SQL) await tx.execute(statement);
      await tx.execute({
        sql: "INSERT INTO _schema_migrations (version,name,checksum,backup_path) VALUES (?,?,?,?)",
        args: [15, "gap_retrieval_v3_and_companion_memory", checksum([...V15_ADD_COLUMNS.map((x) => x.join(" ")), ...V15_TABLE_DDL, ...V15_BACKFILL_SQL]), backupPath],
      });
      await tx.commit();
    } catch (error) {
      await tx.rollback();
      throw error;
    }
    if (backupPath) console.log(`数据库迁移前备份: ${backupPath}`);
  }
  const v16 = await client.execute({ sql: "SELECT version FROM _schema_migrations WHERE version = ?", args: [16] });
  if (!v16.rows.length) {
    const backupPath = await backupLocalDatabase(client, dbUrl, 16);
    const tx = await client.transaction("write");
    try {
      for (const statement of V16_TABLE_DDL) await tx.execute(statement);
      await tx.execute({
        sql: "INSERT INTO _schema_migrations (version,name,checksum,backup_path) VALUES (?,?,?,?)",
        args: [16, "speaking_practice_and_free_talk", checksum(V16_TABLE_DDL), backupPath],
      });
      await tx.commit();
    } catch (error) {
      await tx.rollback();
      throw error;
    }
    if (backupPath) console.log(`数据库迁移前备份: ${backupPath}`);
  }
  const v17 = await client.execute({ sql: "SELECT version FROM _schema_migrations WHERE version = ?", args: [17] });
  if (!v17.rows.length) {
    const backupPath = await backupLocalDatabase(client, dbUrl, 17);
    const tx = await client.transaction("write");
    try {
      for (const statement of V17_TABLE_DDL) await tx.execute(statement);
      await tx.execute({
        sql: "INSERT INTO _schema_migrations (version,name,checksum,backup_path) VALUES (?,?,?,?)",
        args: [17, "question_mastery_lifecycle", checksum(V17_TABLE_DDL), backupPath],
      });
      await tx.commit();
    } catch (error) {
      await tx.rollback();
      throw error;
    }
    if (backupPath) console.log(`数据库迁移前备份: ${backupPath}`);
  }
  const v18 = await client.execute({ sql: "SELECT version FROM _schema_migrations WHERE version = ?", args: [18] });
  if (!v18.rows.length) {
    const backupPath = await backupLocalDatabase(client, dbUrl, 18);
    const tx = await client.transaction("write");
    try {
      await archiveRetiredLearning(tx);
      await tx.execute({
        sql: "INSERT INTO _schema_migrations (version,name,checksum,backup_path) VALUES (?,?,?,?)",
        args: [18, "archive_owner_retired_learning", checksum(V18_DDL), backupPath],
      });
      await tx.commit();
    } catch (error) { await tx.rollback(); throw error; }
  }
  const v19 = await client.execute({ sql: "SELECT version FROM _schema_migrations WHERE version = ?", args: [19] });
  if (!v19.rows.length) {
    const backupPath = await backupLocalDatabase(client, dbUrl, 19);
    const tx = await client.transaction("write");
    try {
      for (const statement of V19_DDL) await tx.execute(statement);
      await tx.execute({ sql: "INSERT INTO _schema_migrations (version,name,checksum,backup_path) VALUES (?,?,?,?)", args: [19, "answer_centric_four_step_training", checksum(V19_DDL), backupPath] });
      await tx.commit();
    } catch (error) { await tx.rollback(); throw error; }
  }
  const v20 = await client.execute({ sql: "SELECT version FROM _schema_migrations WHERE version = ?", args: [20] });
  if (!v20.rows.length) {
    const backupPath = await backupLocalDatabase(client, dbUrl, 20);
    const tx = await client.transaction("write");
    try {
      for (const statement of V20_DDL) await tx.execute(statement);
      await tx.execute({ sql: "INSERT INTO _schema_migrations (version,name,checksum,backup_path) VALUES (?,?,?,?)", args: [20, "evidence_first_material_selection", checksum(V20_DDL), backupPath] });
      await tx.commit();
    } catch (error) { await tx.rollback(); throw error; }
  }
  const v21 = await client.execute({sql:"SELECT version FROM _schema_migrations WHERE version=?",args:[21]});
  if (!v21.rows.length) {
    const backupPath=await backupLocalDatabase(client,dbUrl,21);
    const tx=await client.transaction("write");
    try {
      for(const ddl of V21_DDL) await tx.execute(ddl);
      await tx.execute({sql:"INSERT INTO _schema_migrations(version,name,checksum,backup_path) VALUES(?,?,?,?)",args:[21,"repair_early_v19_material_revisions",checksum(V21_DDL),backupPath]});
      await tx.commit();
    }catch(error){await tx.rollback();throw error;}
  }
  const v22 = await client.execute({sql:"SELECT version FROM _schema_migrations WHERE version=?",args:[22]});
  if (!v22.rows.length) {
    const backupPath=await backupLocalDatabase(client,dbUrl,22);
    const tx=await client.transaction("write");
    try {
      for(const ddl of V22_DDL) await tx.execute(ddl);
      await tx.execute({sql:"INSERT INTO _schema_migrations(version,name,checksum,backup_path) VALUES(?,?,?,?)",args:[22,"offline_practice_and_historical_source_bridge",checksum(V22_DDL),backupPath]});
      await tx.commit();
    }catch(error){await tx.rollback();throw error;}
  }
  const v23 = await client.execute({sql:"SELECT version FROM _schema_migrations WHERE version=?",args:[23]});
  if (!v23.rows.length) {
    const backupPath=await backupLocalDatabase(client,dbUrl,23);
    const tx=await client.transaction("write");
    try {
      for(const ddl of V23_DDL) await tx.execute(ddl);
      await tx.execute({sql:"INSERT INTO _schema_migrations(version,name,checksum,backup_path) VALUES(?,?,?,?)",args:[23,"append_only_practice_source_revisions",checksum(V23_DDL),backupPath]});
      await tx.commit();
    }catch(error){await tx.rollback();throw error;}
  }
  const v24 = await client.execute({ sql: "SELECT version FROM _schema_migrations WHERE version=?", args: [24] });
  if (!v24.rows.length) {
    const backupPath = await backupLocalDatabase(client, dbUrl, 24);
    const tx = await client.transaction("write");
    try {
      for (const ddl of V24_DDL) await tx.execute(ddl);
      await tx.execute({ sql: "INSERT INTO _schema_migrations(version,name,checksum,backup_path) VALUES(?,?,?,?)", args: [24, "isolated_light_study", checksum(V24_DDL), backupPath] });
      await tx.commit();
    } catch (error) { await tx.rollback(); throw error; }
  }
  const v25 = await client.execute({ sql: "SELECT version FROM _schema_migrations WHERE version=?", args: [25] });
  if (!v25.rows.length) {
    const backupPath = await backupLocalDatabase(client, dbUrl, 25);
    const tx = await client.transaction("write");
    try {
      for (const ddl of V25_DDL) await tx.execute(ddl);
      await tx.execute({ sql: "INSERT INTO _schema_migrations(version,name,checksum,backup_path) VALUES(?,?,?,?)", args: [25, "light_study_recall_and_bounded_consolidation", checksum(V25_DDL), backupPath] });
      await tx.commit();
    } catch (error) { await tx.rollback(); throw error; }
  }
  const v26 = await client.execute({sql:"SELECT version FROM _schema_migrations WHERE version=?",args:[26]});
  if(!v26.rows.length){
    const backupPath=await backupLocalDatabase(client,dbUrl,26);
    const tx=await client.transaction("write");
    try{
      for(const ddl of V26_DDL)await tx.execute(ddl);
      await tx.execute({sql:"INSERT INTO _schema_migrations(version,name,checksum,backup_path) VALUES(?,?,?,?)",args:[26,"local_device_requests_and_answer_drafts",checksum(V26_DDL),backupPath]});
      await tx.commit();
    }catch(error){await tx.rollback();throw error;}
  }
  const v27 = await client.execute({sql:"SELECT version FROM _schema_migrations WHERE version=?",args:[27]});
  if(!v27.rows.length){
    const backupPath=await backupLocalDatabase(client,dbUrl,27),tx=await client.transaction("write");
    try{
      for(const ddl of V27_DDL)await tx.execute(ddl);
      await tx.execute({sql:"INSERT INTO _schema_migrations(version,name,checksum,backup_path) VALUES(?,?,?,?)",args:[27,"memory_revocation_and_recoverable_jobs",checksum(V27_DDL),backupPath]});
      await tx.commit();
    }catch(error){await tx.rollback();throw error;}
  }
  const v28=await client.execute({sql:"SELECT version FROM _schema_migrations WHERE version=?",args:[28]});
  if(!v28.rows.length){
    const backupPath=await backupLocalDatabase(client,dbUrl,28),tx=await client.transaction('write');
    try{for(const ddl of V28_DDL)await tx.execute(ddl);await tx.execute({sql:'INSERT INTO _schema_migrations(version,name,checksum,backup_path) VALUES(?,?,?,?)',args:[28,'record_sync_history_and_ownership',checksum(V28_DDL),backupPath]});await tx.commit();}
    catch(error){await tx.rollback();throw error;}
  }
  const v29=await client.execute({sql:'SELECT version FROM _schema_migrations WHERE version=?',args:[29]});
  if(!v29.rows.length){
    const backupPath=await backupLocalDatabase(client,dbUrl,29),tx=await client.transaction('write');
    try{for(const ddl of V29_DDL)await tx.execute(ddl);await tx.execute({sql:'INSERT INTO _schema_migrations(version,name,checksum,backup_path) VALUES(?,?,?,?)',args:[29,'web_light_successions_and_speech_requests',checksum(V29_DDL),backupPath]});await tx.commit();}
    catch(error){await tx.rollback();throw error;}
  }
  const v30=await client.execute({sql:'SELECT version FROM _schema_migrations WHERE version=?',args:[30]});
  if(!v30.rows.length){
    const backupPath=await backupLocalDatabase(client,dbUrl,30),tx=await client.transaction('write');
    try{for(const ddl of V30_DDL)await tx.execute(ddl);await tx.execute({sql:'INSERT INTO _schema_migrations(version,name,checksum,backup_path) VALUES(?,?,?,?)',args:[30,'web_cross_process_speech_lane',checksum(V30_DDL),backupPath]});await tx.commit();}
    catch(error){await tx.rollback();throw error;}
  }
  const v31=await client.execute({sql:'SELECT version FROM _schema_migrations WHERE version=?',args:[31]});
  if(!v31.rows.length){
    const backupPath=await backupLocalDatabase(client,dbUrl,31),tx=await client.transaction('write');
    try{for(const ddl of V31_DDL)await tx.execute(ddl);await tx.execute({sql:'INSERT INTO _schema_migrations(version,name,checksum,backup_path) VALUES(?,?,?,?)',args:[31,'web_expression_preferences_and_versioned_feedback',checksum(V31_DDL),backupPath]});await tx.commit();}
    catch(error){await tx.rollback();throw error;}
  }
  const v32=await client.execute({sql:'SELECT version FROM _schema_migrations WHERE version=?',args:[32]});
  if(!v32.rows.length){
    const backupPath=await backupLocalDatabase(client,dbUrl,32),tx=await client.transaction('write');
    try{for(const ddl of V32_DDL)await tx.execute(ddl);await tx.execute({sql:'INSERT INTO _schema_migrations(version,name,checksum,backup_path) VALUES(?,?,?,?)',args:[32,'mixed_answers_and_self_report_study',checksum(V32_DDL),backupPath]});await tx.commit();}
    catch(error){await tx.rollback();throw error;}
  }
  const v33=await client.execute({sql:'SELECT version FROM _schema_migrations WHERE version=?',args:[33]});
  if(!v33.rows.length){
    const backupPath=await backupLocalDatabase(client,dbUrl,33),tx=await client.transaction('write');
    try{for(const ddl of V33_DDL)await tx.execute(ddl);await tx.execute({sql:'INSERT INTO _schema_migrations(version,name,checksum,backup_path) VALUES(?,?,?,?)',args:[33,'sentence_study_and_validation_receipts',checksum(V33_DDL),backupPath]});await tx.commit();}
    catch(error){await tx.rollback();throw error;}
  }
  const v34=await client.execute({sql:'SELECT version FROM _schema_migrations WHERE version=?',args:[34]});
  if(!v34.rows.length){
    const backupPath=await backupLocalDatabase(client,dbUrl,34),tx=await client.transaction('write');
    try{for(const ddl of V34_DDL)await tx.execute(ddl);await tx.execute({sql:'INSERT INTO _schema_migrations(version,name,checksum,backup_path) VALUES(?,?,?,?)',args:[34,'personal_highlights_and_safe_runtime_diagnostics',checksum(V34_DDL),backupPath]});await tx.commit();}
    catch(error){await tx.rollback();throw error;}
  }
  await assertMigrationContinuity(client);
}

