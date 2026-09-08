import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * 鱼块学英语 数据模型（docs/DATA_MODEL.md 为逻辑权威）。
 * 所有 JSON 字段为 TEXT，读写经 zod 校验（pipeline/src/lib/schemas.ts、src/lib/learning/schemas.ts）。
 * 时间戳统一 ISO 8601 文本（UTC）。
 */

/* ---------------- 内容侧 ---------------- */

export const books = sqliteTable("books", {
  id: text("id").primaryKey(), // book1_ielts_complete / book2_speaking_success ...
  titleZh: text("title_zh").notNull(),
  titleEn: text("title_en").notNull(),
  sourceType: text("source_type").notNull(), // question_bank | podcast
  descriptionZh: text("description_zh").notNull().default(""),
  contentVersion: text("content_version").notNull().default("v0"),
  status: text("status").notNull().default("blocked"), // beta | blocked | ready
  blockedReason: text("blocked_reason"),
  defaultAccent: text("default_accent").notNull().default("en-GB"),
  createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
});

export const topics = sqliteTable(
  "topics",
  {
    id: text("id").primaryKey(), // t_work_study ...
    bookId: text("book_id").notNull(),
    nameZh: text("name_zh").notNull(),
    nameEn: text("name_en").notNull(),
    ieltsPart: integer("ielts_part"), // 1 | 2 | 3（Part2/3 为 cue-card 话题组时取主 Part）
    domainsJson: text("domains_json").notNull().default("[]"),
    status: text("status").notNull().default("pending"), // pending | domains_done | audited
    sort: integer("sort").notNull().default(0),
  },
  (t) => [index("topics_book_idx").on(t.bookId)],
);

export const questions = sqliteTable(
  "questions",
  {
    id: text("id").primaryKey(), // q_<hash>
    bookId: text("book_id").notNull(),
    topicId: text("topic_id"),
    part: integer("part").notNull(), // 1 | 2 | 3
    text: text("text").notNull(), // 题干（Part2 为 cue card 全文，含 You should say 要点）
    textZh: text("text_zh").notNull().default(""),
    normText: text("norm_text").notNull(),
    status: text("status").notNull().default("pending"), // pending | blueprint_done | chunked | audited
    blueprintJson: text("blueprint_json").notNull().default("[]"),
    sourceRefsJson: text("source_refs_json").notNull().default("[]"),
    createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [
    uniqueIndex("questions_norm_unique").on(t.normText),
    index("questions_topic_idx").on(t.topicId),
    index("questions_book_idx").on(t.bookId),
  ],
);

/** V0.2 题集。季度不是 questions 的单值字段，同一道题可跨题集复用。 */
export const questionSets = sqliteTable("question_sets", {
  id: text("id").primaryKey(),
  nameZh: text("name_zh").notNull(),
  year: integer("year").notNull(),
  startMonth: integer("start_month").notNull(),
  endMonth: integer("end_month").notNull(),
  status: text("status").notNull().default("active"),
  sort: integer("sort").notNull().default(0),
});

export const questionSetLinks = sqliteTable(
  "question_set_links",
  {
    questionId: text("question_id").notNull(),
    questionSetId: text("question_set_id").notNull(),
    sourceSlug: text("source_slug").notNull(),
    sourceFile: text("source_file").notNull(),
    sourcePage: integer("source_page").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.questionId, t.questionSetId, t.sourceSlug, t.sourcePage] }),
    index("question_set_links_set_idx").on(t.questionSetId),
    index("question_set_links_question_idx").on(t.questionId),
    index("question_set_links_source_idx").on(t.sourceSlug),
  ],
);

export const questionAttempts = sqliteTable(
  "question_attempts",
  {
    id: text("id").primaryKey(),
    questionId: text("question_id").notNull(),
    status: text("status").notNull(), // viewed | started | completed
    origin: text("origin").notNull().default("browse"), // browse | random | answer
    createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [
    index("question_attempts_question_idx").on(t.questionId, t.createdAt),
    index("question_attempts_recent_idx").on(t.origin, t.status, t.createdAt),
  ],
);

export const questionFavorites = sqliteTable("question_favorites", {
  questionId: text("question_id").primaryKey(),
  createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
});

/** v5：个人回答原文。raw_text 永不被 AI 或用户修订覆盖。 */
export const personalAnswers = sqliteTable(
  "personal_answers",
  {
    id: text("id").primaryKey(),
    questionId: text("question_id").notNull(),
    inputLanguage: text("input_language").notNull(), // zh | en | mixed
    rawText: text("raw_text").notNull(),
    status: text("status").notNull().default("draft"), // draft | queued | processing | ready | needs_attention | failed
    currentVersionId: text("current_version_id"),
    importId: text("import_id"),
    sourceSegmentId: text("source_segment_id"),
    attemptOrder: integer("attempt_order").notNull().default(1),
    sourceOrder: integer("source_order"),
    sourceKind: text("source_kind").notNull().default("runtime"), // runtime | historical_import
    sourceRevisionId: text("source_revision_id"),
    supersededByRevisionId: text("superseded_by_revision_id"),
    createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    updatedAt: text("updated_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [
    index("personal_answers_question_idx").on(t.questionId, t.createdAt),
    index("personal_answers_status_idx").on(t.status, t.updatedAt),
    index("personal_answers_active_idx").on(t.questionId, t.supersededByRevisionId),
  ],
);

/** 答案版本只追加不覆盖；raw/AI/用户编辑均可回看。 */
export const answerVersions = sqliteTable(
  "answer_versions",
  {
    id: text("id").primaryKey(),
    answerId: text("answer_id").notNull(),
    versionNo: integer("version_no").notNull(),
    kind: text("kind").notNull(), // raw(legacy) | raw_transcript | normalized_transcript | ai_revised | user_edited
    textEn: text("text_en").notNull().default(""),
    textZh: text("text_zh").notNull().default(""),
    changeSummaryJson: text("change_summary_json").notNull().default("[]"),
    sourceJobId: text("source_job_id"),
    createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [
    uniqueIndex("answer_versions_answer_no_unique").on(t.answerId, t.versionNo),
    index("answer_versions_answer_idx").on(t.answerId, t.createdAt),
  ],
);

/** v6：个人英文版本按完整句子切分，保留真实语境。 */
export const personalAnswerSentences = sqliteTable(
  "personal_answer_sentences",
  {
    id: text("id").primaryKey(),
    answerId: text("answer_id").notNull(),
    answerVersionId: text("answer_version_id").notNull(),
    questionId: text("question_id").notNull(),
    sentenceIndex: integer("sentence_index").notNull(),
    textEn: text("text_en").notNull(),
    textZh: text("text_zh").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [
    uniqueIndex("personal_answer_sentences_version_index_unique").on(t.answerVersionId, t.sentenceIndex),
    index("personal_answer_sentences_answer_idx").on(t.answerId, t.sentenceIndex),
  ],
);

export const personalChunkLinks = sqliteTable(
  "personal_chunk_links",
  {
    answerId: text("answer_id").notNull(),
    sentenceId: text("sentence_id").notNull(),
    chunkId: text("chunk_id").notNull(),
    origin: text("origin").notNull(), // public | personal
    status: text("status").notNull().default("active"), // active | hidden
    generatorRunId: text("generator_run_id").notNull(),
    reviewerRunId: text("reviewer_run_id").notNull(),
    createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [
    primaryKey({ columns: [t.answerId, t.sentenceId, t.chunkId] }),
    index("personal_chunk_links_chunk_idx").on(t.chunkId, t.status),
    index("personal_chunk_links_answer_idx").on(t.answerId, t.status),
  ],
);

export const personalContentReviews = sqliteTable(
  "personal_content_reviews",
  {
    id: text("id").primaryKey(),
    answerId: text("answer_id").notNull(),
    sentenceId: text("sentence_id").notNull(),
    canonicalChunk: text("canonical_chunk").notNull(),
    candidateJson: text("candidate_json").notNull(),
    verdict: text("verdict").notNull(), // approved | edited | rejected
    reason: text("reason").notNull().default(""),
    generatorRunId: text("generator_run_id").notNull(),
    reviewerRunId: text("reviewer_run_id").notNull(),
    createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [
    uniqueIndex("personal_content_reviews_run_candidate_unique").on(t.reviewerRunId, t.sentenceId, t.canonicalChunk),
    index("personal_content_reviews_answer_idx").on(t.answerId, t.verdict),
  ],
);

/** v8：私人历史材料导入元数据。正文仅存在本地数据库与私有目录。 */
export const answerImports = sqliteTable(
  "answer_imports",
  {
    id: text("id").primaryKey(),
    sourceKind: text("source_kind").notNull().default("historical"),
    sourceFileName: text("source_file_name").notNull(),
    sourceSha256: text("source_sha256").notNull(),
    sourceBytes: integer("source_bytes").notNull(),
    privateOriginalPath: text("private_original_path").notNull(),
    parserVersion: text("parser_version").notNull(),
    promptVersion: text("prompt_version").notNull(),
    schemaVersion: text("schema_version").notNull(),
    runId: text("run_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    status: text("status").notNull().default("prepared"),
    checkpointJson: text("checkpoint_json").notNull().default("{}"),
    summaryJson: text("summary_json").notNull().default("{}"),
    createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    updatedAt: text("updated_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [index("answer_imports_status_idx").on(t.status, t.updatedAt)],
);

export const answerImportSegments = sqliteTable(
  "answer_import_segments",
  {
    id: text("id").primaryKey(),
    importId: text("import_id").notNull(),
    sourceOrder: integer("source_order").notNull(),
    startOffset: integer("start_offset").notNull(),
    endOffset: integer("end_offset").notNull(),
    segmentType: text("segment_type").notNull(),
    rawText: text("raw_text").notNull(),
    normalizedText: text("normalized_text").notNull().default(""),
    questionId: text("question_id"),
    matchMethod: text("match_method"),
    matchConfidence: real("match_confidence"),
    status: text("status").notNull().default("pending"),
    reviewerRunId: text("reviewer_run_id"),
    createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [
    uniqueIndex("answer_import_segments_order_unique").on(t.importId, t.sourceOrder),
    index("answer_import_segments_import_idx").on(t.importId, t.sourceOrder),
    index("answer_import_segments_question_idx").on(t.questionId, t.segmentType),
  ],
);

/** v12：修订快照只追加，旧片段与旧回答继续保留。 */
export const answerImportRevisions = sqliteTable("answer_import_revisions", {
  id: text("id").primaryKey(), importId: text("import_id").notNull(),
  sourceSha256: text("source_sha256").notNull(), baseSegmentsSha256: text("base_segments_sha256").notNull(),
  reviewSha256: text("review_sha256").notNull(), inputSha256: text("input_sha256").notNull(),
  reviewerRunId: text("reviewer_run_id").notNull(), reviewerSessionId: text("reviewer_session_id").notNull(),
  promptVersion: text("prompt_version").notNull(), snapshotJson: text("snapshot_json").notNull(),
  beforeLinksJson: text("before_links_json").notNull(),
  createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
}, (t) => [uniqueIndex("answer_import_revisions_review_unique").on(t.importId, t.reviewSha256), index("answer_import_revisions_import_idx").on(t.importId, t.createdAt)]);

export const answerImportRevisionSegments = sqliteTable("answer_import_revision_segments", {
  revisionId: text("revision_id").notNull(), segmentId: text("segment_id").notNull(),
  sourceOrder: integer("source_order").notNull(), startOffset: integer("start_offset").notNull(), endOffset: integer("end_offset").notNull(),
  segmentType: text("segment_type").notNull(), rawText: text("raw_text").notNull(), questionId: text("question_id"),
  answerGroupKey: text("answer_group_key"), originalSegmentIdsJson: text("original_segment_ids_json").notNull(), reviewed: integer("reviewed").notNull(),
}, (t) => [primaryKey({ columns: [t.revisionId, t.segmentId] }), uniqueIndex("answer_import_revision_segments_order_unique").on(t.revisionId, t.sourceOrder)]);

export const questionAliases = sqliteTable(
  "question_aliases",
  {
    id: text("id").primaryKey(),
    questionId: text("question_id").notNull(),
    aliasText: text("alias_text").notNull(),
    normalizedAlias: text("normalized_alias").notNull(),
    source: text("source").notNull(),
    confidence: real("confidence").notNull().default(1),
    createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [
    uniqueIndex("question_aliases_question_norm_unique").on(t.questionId, t.normalizedAlias),
    index("question_aliases_norm_idx").on(t.normalizedAlias),
  ],
);

export const gapClusters = sqliteTable("gap_clusters", {
  id: text("id").primaryKey(),
  canonicalKey: text("canonical_key").notNull().unique(),
  titleZh: text("title_zh").notNull(),
  gapType: text("gap_type").notNull(),
  occurrenceCount: integer("occurrence_count").notNull().default(0),
  masteryStatus: text("mastery_status").notNull().default("open"),
  createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  updatedAt: text("updated_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
});

// 完整快照含私人正文，只保存在本机数据库；公开报告只输出哈希与计数。
export const personalDiagnosisBatches = sqliteTable("personal_diagnosis_batches", {
  id: text("id").primaryKey(), inputSha256: text("input_sha256").notNull().unique(),
  generationSha256: text("generation_sha256").notNull(), reviewSha256: text("review_sha256").notNull(),
  generatorRunId: text("generator_run_id").notNull().unique(), reviewerRunId: text("reviewer_run_id").notNull().unique(),
  schemaVersion: text("schema_version").notNull(), snapshotJson: text("snapshot_json").notNull(),
  createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
});

export const personalGapEvidence = sqliteTable("personal_gap_evidence", {
  gapId: text("gap_id").primaryKey(), batchId: text("batch_id").notNull(), answerId: text("answer_id").notNull(),
  candidateKey: text("candidate_key").notNull(), startOffset: integer("start_offset").notNull(), endOffset: integer("end_offset").notNull(),
  sourceStartOffset: integer("source_start_offset").notNull(), sourceEndOffset: integer("source_end_offset").notNull(),
  sourceRevisionId: text("source_revision_id"), rawSha256: text("raw_sha256").notNull(),
}, (t) => [uniqueIndex("personal_gap_evidence_candidate_unique").on(t.batchId, t.answerId, t.candidateKey), index("personal_gap_evidence_answer_idx").on(t.answerId, t.batchId)]);

export const answerGaps = sqliteTable(
  "answer_gaps",
  {
    id: text("id").primaryKey(),
    answerId: text("answer_id").notNull(),
    answerVersionId: text("answer_version_id"),
    sourceSegmentId: text("source_segment_id"),
    clusterId: text("cluster_id"),
    gapType: text("gap_type").notNull(),
    evidenceText: text("evidence_text").notNull(),
    intentZh: text("intent_zh").notNull().default(""),
    recommendedExpression: text("recommended_expression").notNull().default(""),
    explanationZh: text("explanation_zh").notNull(),
    confidence: real("confidence").notNull(),
    impactLevel: text("impact_level").notNull().default("medium"),
    reviewerDecision: text("reviewer_decision").notNull(),
    reviewerReason: text("reviewer_reason").notNull(),
    reviewerRunId: text("reviewer_run_id").notNull(),
    learningFit: integer("learning_fit", { mode: "boolean" }).notNull().default(false),
    status: text("status").notNull().default("open"),
    createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    updatedAt: text("updated_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [
    uniqueIndex("answer_gaps_evidence_unique").on(t.answerId, t.gapType, t.evidenceText, t.recommendedExpression),
    index("answer_gaps_answer_idx").on(t.answerId, t.status),
    index("answer_gaps_cluster_idx").on(t.clusterId, t.status),
  ],
);

export const questionLearningUnits = sqliteTable(
  "question_learning_units",
  {
    id: text("id").primaryKey(),
    questionId: text("question_id").notNull(),
    gapId: text("gap_id"),
    chunkId: text("chunk_id").notNull(),
    requirement: text("requirement").notNull().default("required"),
    priority: integer("priority").notNull().default(50),
    source: text("source").notNull(),
    firstRoundCompletedAt: text("first_round_completed_at"),
    status: text("status").notNull().default("active"),
    createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    updatedAt: text("updated_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [
    uniqueIndex("question_learning_units_question_chunk_unique").on(t.questionId, t.chunkId, t.source),
    index("question_learning_units_question_idx").on(t.questionId, t.status, t.priority),
    index("question_learning_units_chunk_idx").on(t.chunkId, t.status),
  ],
);

export const learningScenarios = sqliteTable(
  "learning_scenarios",
  {
    id: text("id").primaryKey(),
    chunkId: text("chunk_id").notNull(),
    questionId: text("question_id"),
    gapId: text("gap_id"),
    scenarioKind: text("scenario_kind").notNull(),
    settingZh: text("setting_zh").notNull(),
    relationshipZh: text("relationship_zh").notNull().default(""),
    purposeZh: text("purpose_zh").notNull(),
    register: text("register").notNull().default("neutral"),
    accent: text("accent").notNull().default("en-US"),
    isGenerated: integer("is_generated", { mode: "boolean" }).notNull().default(true),
    reviewDecision: text("review_decision").notNull().default("pending"),
    reviewReason: text("review_reason").notNull().default(""),
    reviewerRunId: text("reviewer_run_id"),
    createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    updatedAt: text("updated_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [
    uniqueIndex("learning_scenarios_scope_unique").on(t.chunkId, t.questionId, t.gapId, t.scenarioKind),
    index("learning_scenarios_chunk_idx").on(t.chunkId, t.scenarioKind),
  ],
);

export const learningScenarioLines = sqliteTable(
  "learning_scenario_lines",
  {
    id: text("id").primaryKey(),
    scenarioId: text("scenario_id").notNull(),
    lineOrder: integer("line_order").notNull(),
    speaker: text("speaker").notNull(),
    textEn: text("text_en").notNull(),
    textZh: text("text_zh").notNull(),
    isTarget: integer("is_target", { mode: "boolean" }).notNull().default(false),
    annotationStatus: text("annotation_status").notNull().default("pending"),
    createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [
    uniqueIndex("learning_scenario_lines_order_unique").on(t.scenarioId, t.lineOrder),
    index("learning_scenario_lines_scenario_idx").on(t.scenarioId, t.lineOrder),
  ],
);

export const audioAssets = sqliteTable(
  "audio_assets",
  {
    id: text("id").primaryKey(),
    contentHash: text("content_hash").notNull(),
    purpose: text("purpose").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    voice: text("voice").notNull(),
    accent: text("accent").notNull().default("en-US"),
    speed: real("speed").notNull().default(1),
    format: text("format").notNull().default("opus"),
    relativePath: text("relative_path").notNull(),
    status: text("status").notNull().default("pending"),
    version: text("version").notNull(),
    createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [uniqueIndex("audio_assets_content_unique").on(t.contentHash, t.provider, t.model, t.voice, t.speed, t.version)],
);

/** v7：可恢复的 IELTS 输出/纠错会话。 */
export const speakingSessions = sqliteTable(
  "speaking_sessions",
  {
    id: text("id").primaryKey(),
    questionId: text("question_id").notNull(),
    answerId: text("answer_id"),
    status: text("status").notNull().default("preparing"),
    chineseIdea: text("chinese_idea").notNull().default(""),
    ideaSource: text("idea_source").notNull().default("ai_generated"), // user_history | ai_generated
    hintsJson: text("hints_json").notNull().default("{}"),
    hintLevel: integer("hint_level").notNull().default(0),
    responseText: text("response_text").notNull().default(""),
    feedbackJson: text("feedback_json").notNull().default("{}"),
    activeRetryItemId: text("active_retry_item_id"),
    experienceVersion: text("experience_version").notNull().default("correction_v1"),
    turnCount: integer("turn_count").notNull().default(0),
    sourceAttemptId: text("source_attempt_id"),
    companionThreadId: text("companion_thread_id"),
    lastError: text("last_error"),
    createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    updatedAt: text("updated_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [index("speaking_sessions_question_idx").on(t.questionId, t.createdAt), index("speaking_sessions_status_idx").on(t.status, t.updatedAt)],
);

export const speakingEvents = sqliteTable(
  "speaking_events",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    eventType: text("event_type").notNull(),
    payloadJson: text("payload_json").notNull().default("{}"),
    createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [index("speaking_events_session_idx").on(t.sessionId, t.createdAt)],
);

export const speakingAttempts = sqliteTable(
  "speaking_attempts",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    attemptType: text("attempt_type").notNull(), // response | retry
    feedbackItemId: text("feedback_item_id"),
    text: text("text").notNull(),
    passed: integer("passed", { mode: "boolean" }),
    aiJobId: text("ai_job_id"),
    createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [index("speaking_attempts_session_idx").on(t.sessionId, t.createdAt)],
);

export const speakingMessages = sqliteTable(
  "speaking_messages",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    sequenceNo: integer("sequence_no").notNull(),
    role: text("role").notNull(), // user | teacher | system
    messageKind: text("message_kind").notNull().default("text"), // text | voice
    text: text("text").notNull(),
    inputLanguage: text("input_language"),
    localAudioRef: text("local_audio_ref"),
    status: text("status").notNull().default("sent"), // pending | sent | failed
    clientMessageId: text("client_message_id").notNull(),
    aiRunId: text("ai_run_id"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [
    uniqueIndex("speaking_messages_client_unique").on(t.sessionId, t.clientMessageId),
    uniqueIndex("speaking_messages_sequence_unique").on(t.sessionId, t.sequenceNo),
    index("speaking_messages_session_idx").on(t.sessionId, t.sequenceNo),
  ],
);

export const speakingGapLinks = sqliteTable(
  "speaking_gap_links",
  {
    messageId: text("message_id").notNull(),
    gapId: text("gap_id").notNull(),
    comparison: text("comparison").notNull(), // improved | repeated | new | uncertain
    relatedGapId: text("related_gap_id"),
    reason: text("reason").notNull().default(""),
    comparatorRunId: text("comparator_run_id").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [
    primaryKey({ columns: [t.messageId, t.gapId] }),
    index("speaking_gap_links_gap_idx").on(t.gapId, t.comparison),
  ],
);

export const sourceSentences = sqliteTable(
  "source_sentences",
  {
    id: text("id").primaryKey(), // s_<hash>
    bookId: text("book_id").notNull(),
    episodeOrFile: text("episode_or_file").notNull(), // 播客集数或 文件+页码
    seq: integer("seq").notNull(),
    text: text("text").notNull(),
    textZh: text("text_zh").notNull().default(""),
    questionId: text("question_id"), // 示范答案所属题目（可空）
    status: text("status").notNull().default("pending"), // pending | chunked | covered | no_new_unit
    noNewUnitReason: text("no_new_unit_reason"),
    coveredByJson: text("covered_by_json").notNull().default("[]"),
  },
  (t) => [
    uniqueIndex("sentences_unique").on(t.bookId, t.episodeOrFile, t.seq),
    index("sentences_status_idx").on(t.status),
  ],
);

export const chunks = sqliteTable(
  "chunks",
  {
    id: text("id").primaryKey(), // c_<hash>
    bookId: text("book_id").notNull(),
    canonicalChunk: text("canonical_chunk").notNull(),
    displayChunk: text("display_chunk").notNull(),
    unitType: text("unit_type").notNull(),
    meaningZh: text("meaning_zh").notNull().default(""),
    englishGloss: text("english_gloss").notNull().default(""),
    pattern: text("pattern"),
    variantsJson: text("variants_json").notNull().default("[]"),
    topicId: text("topic_id"),
    ieltsPart: integer("ielts_part"),
    difficulty: text("difficulty").notNull().default("intermediate"), // 仅元数据
    tagsJson: text("tags_json").notNull().default("[]"),
    contentVersion: text("content_version").notNull().default("v0"),
    qualityStatus: text("quality_status").notNull().default("pending_review"), // pending_review | approved | edited | rejected
    reviewProvenance: text("review_provenance").notNull().default("unreviewed"), // unreviewed | independent_reviewer | human_reviewer
    reviewerVersion: text("reviewer_version"),
    reviewedAt: text("reviewed_at"),
    rejectReason: text("reject_reason"),
    createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    updatedAt: text("updated_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [
    uniqueIndex("chunks_canonical_unique").on(t.canonicalChunk, t.bookId),
    index("chunks_topic_idx").on(t.topicId),
    index("chunks_quality_idx").on(t.qualityStatus),
  ],
);

export const chunkExamples = sqliteTable(
  "chunk_examples",
  {
    id: text("id").primaryKey(),
    chunkId: text("chunk_id").notNull(),
    textEn: text("text_en").notNull(),
    textZh: text("text_zh").notNull().default(""),
    isSourceSentence: integer("is_source_sentence").notNull().default(0),
    sourceRef: text("source_ref").notNull().default(""),
    questionIdsJson: text("question_ids_json").notNull().default("[]"),
    sourceSentenceId: text("source_sentence_id"),
    contextType: text("context_type").notNull().default("generated_ielts"), // source_neighbors | generated_ielts
    generated: integer("generated").notNull().default(1),
    sort: integer("sort").notNull().default(0),
  },
  (t) => [index("examples_chunk_idx").on(t.chunkId)],
);

export const chunkTopicLinks = sqliteTable(
  "chunk_topic_links",
  {
    chunkId: text("chunk_id").notNull(),
    topicId: text("topic_id").notNull(),
    relation: text("relation").notNull().default("coverage"),
    isPrimary: integer("is_primary").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.chunkId, t.topicId] }),
    index("chunk_topic_links_topic_idx").on(t.topicId),
  ],
);

export const chunkQuestionLinks = sqliteTable(
  "chunk_question_links",
  {
    chunkId: text("chunk_id").notNull(),
    questionId: text("question_id").notNull(),
    relation: text("relation").notNull().default("coverage"),
    answerDimensionId: text("answer_dimension_id").notNull().default(""),
  },
  (t) => [
    primaryKey({ columns: [t.chunkId, t.questionId, t.relation, t.answerDimensionId] }),
    index("chunk_question_links_question_idx").on(t.questionId),
  ],
);

export const chunkPronunciations = sqliteTable(
  "chunk_pronunciations",
  {
    id: text("id").primaryKey(),
    chunkId: text("chunk_id").notNull(),
    ipa: text("ipa").notNull(),
    accent: text("accent").notNull(),
    audioUrl: text("audio_url"),
    source: text("source").notNull(),
    isPrimary: integer("is_primary").notNull().default(0),
  },
  (t) => [
    uniqueIndex("chunk_pronunciations_unique").on(t.chunkId, t.accent, t.source),
    index("chunk_pronunciations_chunk_idx").on(t.chunkId),
  ],
);

export const lexemes = sqliteTable(
  "lexemes",
  {
    id: text("id").primaryKey(),
    surface: text("surface").notNull(),
    normalized: text("normalized").notNull(),
    lemma: text("lemma"),
    meaningZh: text("meaning_zh").notNull(),
    ipa: text("ipa"),
    accent: text("accent").notNull().default("en-GB"),
    source: text("source").notNull(),
    status: text("status").notNull().default("verified"), // verified | pending | rejected
  },
  (t) => [
    uniqueIndex("lexemes_normalized_accent_unique").on(t.normalized, t.accent),
    index("lexemes_normalized_idx").on(t.normalized),
  ],
);

export const textAnnotations = sqliteTable(
  "text_annotations",
  {
    id: text("id").primaryKey(),
    contentType: text("content_type").notNull(), // sentence | example | question
    contentId: text("content_id").notNull(),
    startOffset: integer("start_offset").notNull(),
    endOffset: integer("end_offset").notNull(),
    surface: text("surface").notNull(),
    lexemeId: text("lexeme_id"),
    chunkId: text("chunk_id"),
    meaningZh: text("meaning_zh").notNull(),
    ipa: text("ipa"),
    accent: text("accent").notNull().default("en-GB"),
  },
  (t) => [
    uniqueIndex("text_annotations_span_unique").on(t.contentType, t.contentId, t.startOffset, t.endOffset),
    index("text_annotations_content_idx").on(t.contentType, t.contentId),
  ],
);

export const chunkSources = sqliteTable(
  "chunk_sources",
  {
    id: text("id").primaryKey(),
    chunkId: text("chunk_id").notNull(),
    sourceType: text("source_type").notNull(), // question_bank | demo_answer | podcast
    bookId: text("book_id").notNull(),
    questionId: text("question_id"),
    sentenceId: text("sentence_id"),
    sourceContext: text("source_context").notNull().default(""),
  },
  (t) => [index("chunk_sources_chunk_idx").on(t.chunkId)],
);

export const chunkCoverageRefs = sqliteTable(
  "chunk_coverage_refs",
  {
    id: text("id").primaryKey(),
    chunkId: text("chunk_id").notNull(),
    refType: text("ref_type").notNull(), // question_dimension | topic_domain
    questionId: text("question_id"),
    dimId: text("dim_id"),
    topicId: text("topic_id"),
    domainId: text("domain_id"),
  },
  (t) => [
    index("coverage_refs_chunk_idx").on(t.chunkId),
    index("coverage_refs_question_idx").on(t.questionId),
  ],
);

/* ---------------- 学习侧 ---------------- */

export const learningProgress = sqliteTable("learning_progress", {
  chunkId: text("chunk_id").primaryKey(),
  fsrsJson: text("fsrs_json").notNull().default("{}"),
  mastery: text("mastery").notNull().default("new"), // new | learning | familiar | reviewing | mastered
  introDone: integer("intro_done").notNull().default(0),
  ratingStatsJson: text("rating_stats_json").notNull().default("{}"),
  skillStatsJson: text("skill_stats_json").notNull().default("{}"),
  lastOutcomeJson: text("last_outcome_json").notNull().default("{}"),
  updatedAt: text("updated_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
});

export const learningRoundSettlements = sqliteTable('learning_round_settlements', {
  sessionId: text('session_id').notNull(),
  chunkId: text('chunk_id').notNull(),
  completedAt: text('completed_at').notNull(),
}, (table) => [primaryKey({ columns: [table.sessionId, table.chunkId] })]);

export const learningSessions = sqliteTable(
  "learning_sessions",
  {
    id: text("id").primaryKey(),
    sessionDate: text("session_date").notNull(),
    mode: text("mode").notNull(), // learn | review
    status: text("status").notNull().default("active"), // active | completed | abandoned
    queueJson: text("queue_json").notNull(),
    currentIndex: integer("current_index").notNull().default(0),
    step: text("step").notNull().default("sentence_input"),
    stepVersion: integer("step_version").notNull().default(1),
    experienceVersion: text("experience_version").notNull().default("sentence_v1"),
    scopeType: text("scope_type").notNull().default("daily"),
    scopeId: text("scope_id"),
    companionThreadId: text("companion_thread_id"),
    stateJson: text("state_json").notNull().default("{}"),
    lastEventAt: text("last_event_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    updatedAt: text("updated_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    completedAt: text("completed_at"),
  },
  (t) => [
    index("learning_sessions_resume_idx").on(t.sessionDate, t.mode, t.status),
  ],
);

export const learningEvents = sqliteTable(
  "learning_events",
  {
    id: text("id").primaryKey(),
    clientEventId: text("client_event_id").notNull(),
    sessionId: text("session_id").notNull(),
    eventType: text("event_type").notNull(),
    payloadJson: text("payload_json").notNull().default("{}"),
    createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [
    uniqueIndex("learning_events_client_unique").on(t.clientEventId),
    index("learning_events_session_idx").on(t.sessionId),
  ],
);

/** v15：V3 提取证据。原始文本仅保存在本机数据库。 */
export const retrievalAttempts = sqliteTable(
  "retrieval_attempts",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    learningUnitId: text("learning_unit_id"),
    gapId: text("gap_id"),
    chunkId: text("chunk_id").notNull(),
    questionId: text("question_id"),
    phase: text("phase").notNull(),
    cueId: text("cue_id"),
    cueHash: text("cue_hash").notNull(),
    rawInput: text("raw_input").notNull().default(""),
    normalizedInput: text("normalized_input").notNull().default(""),
    judgementRoute: text("judgement_route").notNull(),
    verdict: text("verdict").notNull(),
    assistanceLevel: integer("assistance_level").notNull().default(0),
    feedbackJson: text("feedback_json").notNull().default("{}"),
    judgePromptVersion: text("judge_prompt_version").notNull().default("gap-retrieval-judge-v1"),
    aiJobId: text("ai_job_id"),
    aiRunId: text("ai_run_id"),
    clientEventId: text("client_event_id").notNull(),
    localDate: text("local_date").notNull(),
    createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [
    uniqueIndex("retrieval_attempts_client_unique").on(t.clientEventId),
    index("retrieval_attempts_session_idx").on(t.sessionId, t.createdAt),
    index("retrieval_attempts_cache_idx").on(t.chunkId, t.gapId, t.cueHash, t.normalizedInput, t.judgePromptVersion),
  ],
);

export const expressionVariants = sqliteTable(
  "expression_variants",
  {
    id: text("id").primaryKey(),
    scopeKey: text("scope_key").notNull(),
    chunkId: text("chunk_id").notNull(),
    gapClusterId: text("gap_cluster_id"),
    expression: text("expression").notNull(),
    normalizedExpression: text("normalized_expression").notNull(),
    relation: text("relation").notNull().default("pending"),
    register: text("register").notNull().default("neutral"),
    contextConstraintsJson: text("context_constraints_json").notNull().default("{}"),
    frequencyRelation: text("frequency_relation").notNull().default("unknown"),
    sourceAttemptId: text("source_attempt_id").notNull(),
    reviewDecision: text("review_decision").notNull().default("pending"),
    reviewReason: text("review_reason").notNull().default(""),
    reviewerRunId: text("reviewer_run_id"),
    preferred: integer("preferred", { mode: "boolean" }).notNull().default(false),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    updatedAt: text("updated_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [
    uniqueIndex("expression_variants_scope_unique").on(t.scopeKey, t.normalizedExpression),
    index("expression_variants_chunk_idx").on(t.chunkId, t.reviewDecision, t.active),
  ],
);

export const learningExperimentAssignments = sqliteTable(
  "learning_experiment_assignments",
  {
    experimentId: text("experiment_id").notNull(),
    chunkId: text("chunk_id").notNull(),
    gapId: text("gap_id"),
    questionId: text("question_id"),
    status: text("status").notNull().default("active"),
    createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [
    primaryKey({ columns: [t.experimentId, t.chunkId] }),
    index("learning_experiment_assignments_question_idx").on(t.experimentId, t.questionId, t.status),
  ],
);

/** v15：Chloe 的任务分组对话与可撤销长期记忆。 */
export const companionThreads = sqliteTable(
  "companion_threads",
  {
    id: text("id").primaryKey(),
    scopeKey: text("scope_key").notNull().unique(),
    scopeType: text("scope_type").notNull(),
    scopeId: text("scope_id"),
    title: text("title").notNull().default("和 Chloe 的对话"),
    status: text("status").notNull().default("active"),
    createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    updatedAt: text("updated_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [index("companion_threads_scope_idx").on(t.scopeType, t.scopeId)],
);

export const companionMessages = sqliteTable(
  "companion_messages",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id").notNull(),
    sequenceNo: integer("sequence_no").notNull(),
    role: text("role").notNull(),
    messageKind: text("message_kind").notNull().default("text"),
    text: text("text").notNull(),
    inputLanguage: text("input_language"),
    status: text("status").notNull().default("sent"),
    clientMessageId: text("client_message_id").notNull(),
    sourceType: text("source_type").notNull().default("companion"),
    sourceId: text("source_id"),
    aiRunId: text("ai_run_id"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [
    uniqueIndex("companion_messages_client_unique").on(t.threadId, t.clientMessageId),
    uniqueIndex("companion_messages_sequence_unique").on(t.threadId, t.sequenceNo),
    index("companion_messages_thread_idx").on(t.threadId, t.sequenceNo),
  ],
);

export const companionMemories = sqliteTable(
  "companion_memories",
  {
    id: text("id").primaryKey(),
    category: text("category").notNull(),
    summary: text("summary").notNull(),
    detailJson: text("detail_json").notNull().default("{}"),
    scopeType: text("scope_type").notNull().default("global"),
    scopeId: text("scope_id"),
    confidence: real("confidence").notNull().default(1),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    evidenceJson: text("evidence_json").notNull().default("[]"),
    status: text("status").notNull().default("active"),
    supersededById: text("superseded_by_id"),
    createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    updatedAt: text("updated_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    deletedAt: text("deleted_at"),
  },
  (t) => [
    index("companion_memories_status_idx").on(t.status, t.category, t.updatedAt),
    index("companion_memories_scope_idx").on(t.scopeType, t.scopeId, t.status),
  ],
);

export const difficultNotes = sqliteTable(
  "difficult_notes",
  {
    id: text("id").primaryKey(),
    chunkId: text("chunk_id"),
    annotationId: text("annotation_id"),
    surface: text("surface").notNull(),
    meaningZh: text("meaning_zh").notNull().default(""),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    status: text("status").notNull().default("open"), // open | resolved
    userRemark: text("user_remark").notNull().default(""),
    triggerCount: integer("trigger_count").notNull().default(1),
    lastTrigger: text("last_trigger").notNull(),
    createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    updatedAt: text("updated_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [
    uniqueIndex("difficult_notes_source_unique").on(t.sourceType, t.sourceId, t.surface),
    index("difficult_notes_chunk_idx").on(t.chunkId),
  ],
);

/** v8：产品层“待学表达”；旧 difficult_notes 只作兼容来源。 */
export const learningInboxItems = sqliteTable(
  "learning_inbox_items",
  {
    id: text("id").primaryKey(),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    chunkId: text("chunk_id"),
    lexemeId: text("lexeme_id"),
    exampleId: text("example_id"),
    surface: text("surface").notNull(),
    meaningZh: text("meaning_zh").notNull().default(""),
    reason: text("reason").notNull(),
    occurrenceCount: integer("occurrence_count").notNull().default(1),
    userNote: text("user_note").notNull().default(""),
    status: text("status").notNull().default("open"),
    createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    updatedAt: text("updated_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [
    uniqueIndex("learning_inbox_items_source_unique").on(t.sourceType, t.sourceId, t.surface),
    index("learning_inbox_items_status_idx").on(t.status, t.updatedAt),
    index("learning_inbox_items_chunk_idx").on(t.chunkId, t.status),
  ],
);

export const reviewLog = sqliteTable(
  "review_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    chunkId: text("chunk_id").notNull(),
    trainedAt: text("trained_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    trainingType: text("training_type").notNull(),
    rating: text("rating").notNull(), // again | hard | good | easy
    detailJson: text("detail_json").notNull().default("{}"),
  },
  (t) => [index("review_log_chunk_idx").on(t.chunkId)],
);

export const learningSettings = sqliteTable("learning_settings", {
  id: integer("id").primaryKey(),
  dailyNewTarget: integer("daily_new_target").notNull().default(15),
  dailyReviewCap: integer("daily_review_cap").notNull().default(200),
});

/** v3：用户偏好。单行表，id 恒为 1；默认值见 docs/PRODUCT.md「设置」。 */
export const userSettings = sqliteTable("user_settings", {
  id: integer("id").primaryKey(),
  /** 关闭时，查询、理解选择和练习错误只写学习事件，不创建难点笔记。 */
  autoCollectDifficulties: integer("auto_collect_difficulties", { mode: "boolean" }).notNull().default(false),
  autoPlay: integer("auto_play", { mode: "boolean" }).notNull().default(true),
  defaultAccent: text("default_accent").notNull().default("en-GB"),
  dailyNewTarget: integer("daily_new_target").notNull().default(20),
  dailyReviewCap: integer("daily_review_cap").notNull().default(100),
  personalNewRatio: real("personal_new_ratio").notNull().default(0.4),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
});

/* ---------------- Runtime AI（v3） ---------------- */

/** AI 任务。状态机：queued → generating → reviewing → applying → completed / needs_attention / retryable_failure / terminal_failure */
export const aiJobs = sqliteTable(
  "ai_jobs",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(), // answer_translate | answer_correct | chunk_extract | chunk_review | hint
    status: text("status").notNull(),
    targetType: text("target_type").notNull().default(""),
    targetId: text("target_id").notNull().default(""),
    /** 幂等键：sha256(规范化 input + promptVersion + schemaVersion + jobId)，重试不得重复创建 Chunk。 */
    idempotencyKey: text("idempotency_key").notNull().unique(),
    promptVersion: text("prompt_version").notNull().default(""),
    schemaVersion: text("schema_version").notNull().default(""),
    attempts: integer("attempts").notNull().default(0),
    lastErrorCode: text("last_error_code"),
    payloadJson: text("payload_json").notNull().default("{}"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [index("ai_jobs_status_idx").on(t.status)],
);

/** 每次 AI 调用的审计记录。Generator 与 Reviewer 必须落两条不同 run_id。 */
export const aiRuns = sqliteTable(
  "ai_runs",
  {
    runId: text("run_id").primaryKey(),
    jobId: text("job_id"),
    role: text("role").notNull(), // generator | reviewer | translator | corrector | hint
    provider: text("provider").notNull(), // deepseek | mock；模型字段始终 deepseek-v4-flash
    model: text("model").notNull(), // 运行时恒为 deepseek-v4-flash
    promptVersion: text("prompt_version").notNull().default(""),
    schemaVersion: text("schema_version").notNull().default(""),
    thinkingMode: text("thinking_mode").notNull().default("disabled"),
    inputHash: text("input_hash").notNull().default(""),
    responseId: text("response_id"),
    latencyMs: integer("latency_ms"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    reasoningTokens: integer("reasoning_tokens"),
    cachedTokens: integer("cached_tokens"),
    status: text("status").notNull(),
    errorCode: text("error_code"),
    errorSummary: text("error_summary"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [index("ai_runs_job_idx").on(t.jobId)],
);

/* ---------------- 流水线侧 ---------------- */

export const compileJobs = sqliteTable(
  "compile_jobs",
  {
    id: text("id").primaryKey(), // <stage>
    stage: text("stage").notNull(),
    status: text("status").notNull().default("idle"), // idle | queued | in_progress | done | failed
    inputRef: text("input_ref").notNull().default(""),
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
    errorLogJson: text("error_log_json").notNull().default("[]"),
  },
  (t) => [uniqueIndex("compile_jobs_stage_unique").on(t.stage)],
);

export const promptVersions = sqliteTable(
  "prompt_versions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    stage: text("stage").notNull(),
    version: text("version").notNull(),
    fileHash: text("file_hash").notNull(),
    notes: text("notes").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [uniqueIndex("prompt_versions_unique").on(t.stage, t.version)],
);

// drizzle-kit 未使用；迁移由 db/migrate.ts 的幂等 DDL 完成，本表仅作占位保持 schema 完整性
export const _meta = sqliteTable("_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull().default(""),
});

// 内容管理修订只追加快照，不授予审核通过权限。
export const contentAmendments = sqliteTable("content_amendments", {
  id: text("id").primaryKey(),
  chunkId: text("chunk_id").notNull(),
  action: text("action", { enum: ["edit", "reject"] }).notNull(),
  beforeJson: text("before_json").notNull(),
  afterJson: text("after_json").notNull(),
  reason: text("reason").notNull(),
  createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
}, (t) => [index("content_amendments_chunk_idx").on(t.chunkId, t.createdAt)]);

/* ---------------- 雅思口语答题练习与 AI Free Talk（v16） ---------------- */

export const speakingQuestionAttempts = sqliteTable(
  "speaking_question_attempts",
  {
    id: text("id").primaryKey(),
    questionId: text("question_id").notNull(),
    mode: text("mode").notNull(), // practice | exam_style
    answerText: text("answer_text").notNull(),
    intendedMeaningZh: text("intended_meaning_zh").notNull().default(""),
    naturalVersion: text("natural_version").notNull().default(""),
    gapCount: integer("gap_count").notNull().default(0),
    status: text("status").notNull().default("completed"), // processing | completed | failed
    analysisJson: text("analysis_json").notNull().default("{}"),
    createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    updatedAt: text("updated_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [
    index("speaking_question_attempts_question_idx").on(t.questionId, t.createdAt),
    index("speaking_question_attempts_mode_idx").on(t.mode, t.createdAt),
  ],
);

export const learningItems = sqliteTable(
  "learning_items",
  {
    id: text("id").primaryKey(),
    canonicalKey: text("canonical_key").notNull().unique(),
    targetEnglish: text("target_english").notNull(),
    intentionZh: text("intention_zh").notNull(),
    itemType: text("item_type").notNull().default("lexical_chunk"), // lexical_chunk | collocation | sentence_frame | grammar_pattern | personal_expression
    exampleSentence: text("example_sentence").notNull().default(""),
    encounterCount: integer("encounter_count").notNull().default(1),
    firstSourceType: text("first_source_type").notNull(), // ielts_practice | free_talk
    firstSourceId: text("first_source_id").notNull(),
    status: text("status").notNull().default("active"),
    createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    updatedAt: text("updated_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [
    index("learning_items_canonical_idx").on(t.canonicalKey),
    index("learning_items_status_idx").on(t.status, t.updatedAt),
  ],
);

export const gapEvents = sqliteTable(
  "gap_events",
  {
    id: text("id").primaryKey(),
    learningItemId: text("learning_item_id").notNull(),
    sourceType: text("source_type").notNull(), // ielts_practice | free_talk
    sourceId: text("source_id").notNull(),
    questionId: text("question_id"),
    evidenceText: text("evidence_text").notNull(),
    intentZh: text("intent_zh").notNull(),
    targetEnglish: text("target_english").notNull(),
    explanationZh: text("explanation_zh").notNull().default(""),
    gapType: text("gap_type").notNull().default("lexical_gap"),
    createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [
    index("gap_events_source_idx").on(t.sourceType, t.sourceId),
    index("gap_events_item_idx").on(t.learningItemId),
    index("gap_events_question_idx").on(t.questionId),
  ],
);

export const freeTalkConversations = sqliteTable(
  "free_talk_conversations",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull().default("AI Free Talk"),
    mode: text("mode").notNull().default("relaxed"), // relaxed | strict
    status: text("status").notNull().default("active"), // active | archived
    createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    updatedAt: text("updated_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [
    index("free_talk_conversations_status_idx").on(t.status, t.updatedAt),
  ],
);

export const freeTalkMessages = sqliteTable(
  "free_talk_messages",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id").notNull(),
    sequenceNo: integer("sequence_no").notNull(),
    role: text("role").notNull(), // user | assistant
    text: text("text").notNull(),
    teachingState: text("teaching_state"), // repetition_requested | repetition_confirmed
    targetRepetition: text("target_repetition"),
    gapCount: integer("gap_count").notNull().default(0),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [
    uniqueIndex("free_talk_messages_seq_unique").on(t.conversationId, t.sequenceNo),
    index("free_talk_messages_conv_idx").on(t.conversationId, t.sequenceNo),
  ],
);

export const questionMastery = sqliteTable(
  "question_mastery",
  {
    questionId: text("question_id").primaryKey(),
    mastered: integer("mastered").notNull().default(0),
    masterySource: text("mastery_source").notNull().default("manual"),
    lastPracticedAt: text("last_practiced_at"),
    lastLearnedAt: text("last_learned_at"),
    fourStepCompletedAt: text("four_step_completed_at"),
    reviewCount: integer("review_count").notNull().default(0),
    updatedAt: text("updated_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [
    index("question_mastery_mastered_idx").on(t.mastered),
  ],
);

export const retiredLearningRecords = sqliteTable("retired_learning_records", {
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  payloadJson: text("payload_json").notNull(),
  reason: text("reason").notNull(),
  archivedAt: text("archived_at").notNull(),
}, (t) => [primaryKey({ columns: [t.entityType, t.entityId] })]);

// v19：回答／对话材料及固定四步。旧 Chunk/Book 不是这些表的父实体。
export const practiceSubmissions = sqliteTable("practice_submissions", {
  requestId: text("request_id").primaryKey(),
  inputHash: text("input_hash").notNull(), attemptId: text("attempt_id").notNull().unique(),
});
export const practiceMaterials = sqliteTable("practice_materials", {
  contractVersion: text("contract_version").notNull().default("legacy_v1"),
  id: text("id").primaryKey(), sourceType: text("source_type").notNull(), sourceId: text("source_id").notNull(),
  questionId: text("question_id"), inputJson: text("input_json").notNull(), inputHash: text("input_hash").notNull(),
  analysisJson: text("analysis_json").notNull().default("{}"), status: text("status").notNull().default("queued"),
  generatorRunId: text("generator_run_id"), reviewerRunId: text("reviewer_run_id"),
  reviewJson: text("review_json").notNull().default("{}"), jobId: text("job_id"),
  leaseUntil: text("lease_until"), leaseToken: text("lease_token"), errorCode: text("error_code"),
  createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, (t) => [
  uniqueIndex("practice_material_source_hash_unique").on(t.sourceType, t.sourceId, t.inputHash),
  index("practice_materials_source_idx").on(t.sourceType, t.sourceId, t.createdAt),
]);
export const practiceMaterialItems = sqliteTable("practice_material_items", {
  materialId: text("material_id").notNull(), learningItemId: text("learning_item_id").notNull(), rowIndex: integer("row_index").notNull(),
}, (t) => [primaryKey({ columns: [t.materialId, t.rowIndex] })]);
export const practiceMaterialRevisions = sqliteTable("practice_material_revisions", {
  materialId: text("material_id").notNull(), generatorRunId: text("generator_run_id").notNull(),
  analysisJson: text("analysis_json").notNull(), reviewerRunId: text("reviewer_run_id"), reviewJson: text("review_json"),
  errorCode: text("error_code"), createdAt: text("created_at").notNull(),
}, (t) => [primaryKey({ columns: [t.materialId, t.generatorRunId] })]);
export const fourStepSessions = sqliteTable("four_step_sessions", {
  id: text("id").primaryKey(), materialId: text("material_id").notNull(), mode: text("mode").notNull().default("learn"),
  status: text("status").notNull().default("active"), stepNo: integer("step_no").notNull().default(1),
  stepVersion: integer("step_version").notNull().default(0), stateJson: text("state_json").notNull(),
  leaseUntil: text("lease_until"), leaseToken: text("lease_token"), createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(), completedAt: text("completed_at"),
}, (t) => [uniqueIndex("four_step_active_unique").on(t.materialId, t.mode).where(sql`status='active'`)]);
export const fourStepEvents = sqliteTable("four_step_events", {
  sessionId: text("session_id").notNull(), clientEventId: text("client_event_id").notNull(),
  inputHash: text("input_hash").notNull(), requestJson: text("request_json").notNull(), status: text("status").notNull(),
  resultJson: text("result_json"), createdAt: text("created_at").notNull(),
}, (t) => [primaryKey({ columns: [t.sessionId, t.clientEventId] })]);
export const fourStepJudgements = sqliteTable("four_step_judgements", {
  id: text("id").primaryKey(), status: text("status").notNull(), resultJson: text("result_json"), runId: text("run_id"),
  leaseUntil: text("lease_until"), leaseToken: text("lease_token"), updatedAt: text("updated_at").notNull(),
});
export const learningItemSchedule = sqliteTable("learning_item_schedule", {
  learningItemId: text("learning_item_id").primaryKey(), fsrsJson: text("fsrs_json").notNull(),
  dueAt: text("due_at").notNull(), lastCompletedAt: text("last_completed_at").notNull(),
  reviewCount: integer("review_count").notNull().default(0),
}, (t) => [index("learning_item_due_idx").on(t.dueAt)]);
export const fourStepSettlements = sqliteTable("four_step_settlements", {
  sessionId: text("session_id").notNull(), learningItemId: text("learning_item_id").notNull(),
  rating: text("rating").notNull(), evidenceJson: text("evidence_json").notNull(), completedAt: text("completed_at").notNull(),
}, (t) => [primaryKey({ columns: [t.sessionId, t.learningItemId] })]);

export const practiceMaterialStages = sqliteTable("practice_material_stages", {
  runId: text("run_id").primaryKey(), materialId: text("material_id").notNull(), stage: text("stage").notNull(),
  promptVersion: text("prompt_version").notNull(), inputHash: text("input_hash").notNull(), inputJson: text("input_json").notNull(),
  outputJson: text("output_json").notNull(), status: text("status").notNull().default("completed"), createdAt: text("created_at").notNull(),
}, (t) => [index("practice_stage_checkpoint_idx").on(t.materialId,t.stage,t.inputHash,t.status,t.createdAt)]);
export const practiceLegacyAnalyses = sqliteTable("practice_legacy_analyses", {
  attemptId: text("attempt_id").primaryKey(), analysisJson: text("analysis_json").notNull(), naturalVersion: text("natural_version").notNull(), archivedAt: text("archived_at").notNull(),
});

export const practiceOfflineRuns = sqliteTable("practice_offline_runs", {
  runId: text("run_id").primaryKey(), materialId: text("material_id").notNull(), stage: text("stage").notNull(),
  provider: text("provider").notNull().default("offline_agent"), model: text("model").notNull(),
  contextId: text("context_id").notNull(), promptVersion: text("prompt_version").notNull(),
  inputHash: text("input_hash").notNull(), outputHash: text("output_hash").notNull(), artifactHash: text("artifact_hash").notNull(),
  networkCalls: integer("network_calls").notNull().default(0), createdAt: text("created_at").notNull(),
});
export const practiceAnswerSources = sqliteTable("practice_answer_sources", {
  answerId: text("answer_id").primaryKey(), attemptId: text("attempt_id").notNull().unique(),
  sourceHash: text("source_hash").notNull(), createdAt: text("created_at").notNull(),
});
export const practiceSourceRevisions = sqliteTable("practice_source_revisions", {
  id: text("id").primaryKey(), parentAnswerId: text("parent_answer_id").notNull().unique(),
  sourceHash: text("source_hash").notNull(), snapshotJson: text("snapshot_json").notNull(),
  reviewerContext: text("reviewer_context").notNull(), createdAt: text("created_at").notNull(),
});

export const lightStudySessions = sqliteTable("light_study_sessions", {
  id: text("id").primaryKey(), scopeKey: text("scope_key").notNull(), scopeJson: text("scope_json").notNull(),
  mode: text("mode").notNull(), status: text("status").notNull().default("active"),
  version: integer("version").notNull().default(0), cursor: integer("cursor").notNull().default(0),
  revealed: integer("revealed").notNull().default(0), queueJson: text("queue_json").notNull(),
  experienceVersion: text("experience_version").notNull().default("light_study_v1"), roundJson: text("round_json"),
  createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, (t) => [uniqueIndex("light_study_active_scope").on(t.scopeKey,t.mode).where(sql`status='active'`)]);
export const lightStudyEvents = sqliteTable("light_study_events", {
  sessionId: text("session_id").notNull(), clientEventId: text("client_event_id").notNull(), kind: text("kind").notNull(),
  payloadHash: text("payload_hash").notNull(), learningItemId: text("learning_item_id"), rating: text("rating"),
  outcome: text("outcome").notNull(), phase: text("phase"), createdAt: text("created_at").notNull(),
}, (t) => [primaryKey({columns:[t.sessionId,t.clientEventId]}),uniqueIndex("light_study_create_request").on(t.clientEventId).where(sql`kind='create'`)]);
export const lightStudyProgress = sqliteTable("light_study_progress", {
  learningItemId: text("learning_item_id").primaryKey(), firstSeenAt: text("first_seen_at").notNull(), lastSeenAt: text("last_seen_at").notNull(),
  dueAt: text("due_at").notNull(), fsrsJson: text("fsrs_json"), reviewCount: integer("review_count").notNull().default(0),
  version: integer("version").notNull().default(1), lastRating: text("last_rating"),
  schedulerVersion: text("scheduler_version").notNull().default("legacy-24h"),
}, (t) => [index("light_study_due").on(t.dueAt,t.learningItemId)]);

export const appDevice=sqliteTable("app_device",{
  singleton:integer("singleton").primaryKey(),deviceId:text("device_id").notNull(),datasetId:text("dataset_id").notNull(),createdAt:text("created_at").notNull(),
});
export const runtimeRequests=sqliteTable("runtime_requests",{
  logicalKey:text("logical_key").primaryKey(),runId:text("run_id").notNull().unique(),ownerBootId:text("owner_boot_id").notNull(),state:text("state").notNull(),
  requestHash:text("request_hash").notNull(),responseJson:text("response_json"),errorCode:text("error_code"),updatedAt:text("updated_at").notNull(),
});
export const answerDrafts=sqliteTable("answer_drafts",{
  id:text("id").primaryKey(),questionId:text("question_id").notNull(),englishText:text("english_text").notNull().default(""),chineseText:text("chinese_text").notNull().default(""),
  englishUnknown:integer("english_unknown").notNull().default(0),version:integer("version").notNull().default(0),submittedAttemptId:text("submitted_attempt_id"),sourceAttemptId:text("source_attempt_id"),
  kind:text("kind").notNull().default("practice"),englishCommittedAt:text("english_committed_at"),
  rawInput:text("raw_input").notNull().default(""),inputFormat:text("input_format").notNull().default("legacy"),
  createdAt:text("created_at").notNull(),updatedAt:text("updated_at").notNull(),
},t=>[index("answer_drafts_question").on(t.questionId,t.updatedAt)]);

export const companionMemoryControl=sqliteTable("companion_memory_control",{
  singleton:integer("singleton").primaryKey(),generation:integer("generation").notNull().default(0),cutoffsJson:text("cutoffs_json").notNull().default("{}"),updatedAt:text("updated_at").notNull(),
});
export const companionMemoryJobs=sqliteTable("companion_memory_jobs",{
  id:text("id").primaryKey(),threadId:text("thread_id").notNull(),generation:integer("generation").notNull(),inputJson:text("input_json").notNull(),status:text("status").notNull(),errorCode:text("error_code"),createdAt:text("created_at").notNull(),updatedAt:text("updated_at").notNull(),
},t=>[index("companion_memory_jobs_state").on(t.status,t.updatedAt)]);

export const deviceSyncChanges=sqliteTable('device_sync_changes',{
  sequence:integer('sequence').primaryKey({autoIncrement:true}),changeId:text('change_id').notNull().unique(),deviceId:text('device_id').notNull(),entity:text('entity').notNull(),recordKey:text('record_key').notNull(),parentsJson:text('parents_json').notNull(),payloadJson:text('payload_json').notNull(),changedAt:text('changed_at').notNull(),
},t=>[index('device_sync_record').on(t.entity,t.recordKey,t.sequence)]);
export const deviceSyncHeads=sqliteTable('device_sync_heads',{
  entity:text('entity').notNull(),recordKey:text('record_key').notNull(),headsJson:text('heads_json').notNull(),projectionHash:text('projection_hash').notNull(),
},t=>[primaryKey({columns:[t.entity,t.recordKey]})]);
export const deviceSyncConflicts=sqliteTable('device_sync_conflicts',{
  id:text('id').primaryKey(),entity:text('entity').notNull(),recordKey:text('record_key').notNull(),headsJson:text('heads_json').notNull(),status:text('status').notNull().default('unresolved'),reason:text('reason').notNull(),createdAt:text('created_at').notNull(),
});
export const deviceSyncReceipts=sqliteTable('device_sync_receipts',{
  peerId:text('peer_id').primaryKey(),receivedSequence:integer('received_sequence').notNull().default(0),updatedAt:text('updated_at').notNull(),
});
export const deviceSyncOwners=sqliteTable('device_sync_owners',{
  entity:text('entity').notNull(),recordKey:text('record_key').notNull(),ownerDeviceId:text('owner_device_id').notNull(),paused:integer('paused').notNull().default(0),
},t=>[primaryKey({columns:[t.entity,t.recordKey]})]);
export const deviceSyncChatBranches=sqliteTable('device_sync_chat_branches',{
  conversationId:text('conversation_id').primaryKey(),parentId:text('parent_id').notNull(),originDeviceId:text('origin_device_id').notNull(),forkSequence:integer('fork_sequence').notNull(),forkMessageId:text('fork_message_id').notNull(),
},t=>[uniqueIndex('device_sync_chat_branch_origin').on(t.parentId,t.originDeviceId,t.forkMessageId)]);

/** v29–31 Web recovery and personal controls; isolated from four-step completion. */
export const lightStudySuccessions=sqliteTable('light_study_successions',{
  legacySessionId:text('legacy_session_id').primaryKey(),currentSessionId:text('current_session_id'),cutoverVersion:integer('cutover_version').notNull(),remainingJson:text('remaining_json').notNull().default('[]'),createdAt:text('created_at').notNull(),updatedAt:text('updated_at').notNull(),
});
export const lightStudySuccessionBatches=sqliteTable('light_study_succession_batches',{
  legacySessionId:text('legacy_session_id').notNull(),batchNo:integer('batch_no').notNull(),sessionId:text('session_id').notNull().unique(),createdAt:text('created_at').notNull(),
},t=>[primaryKey({columns:[t.legacySessionId,t.batchNo]})]);
export const speechRequests=sqliteTable('speech_requests',{
  id:text('id').primaryKey(),cacheKey:text('cache_key').notNull(),descriptorJson:text('descriptor_json').notNull(),status:text('status').notNull(),priority:integer('priority').notNull().default(0),errorCode:text('error_code'),assetId:text('asset_id'),ownerBootId:text('owner_boot_id'),createdAt:text('created_at').notNull(),updatedAt:text('updated_at').notNull(),
},t=>[index('speech_requests_cache').on(t.cacheKey,t.createdAt)]);
export const speechLane=sqliteTable('speech_lane',{
  singleton:integer('singleton').primaryKey(),owner:text('owner').notNull(),expiresAt:text('expires_at').notNull(),
});
export const expressionPreferences=sqliteTable('expression_preferences',{
  selfKnown:integer('self_known').notNull().default(0),
  learningItemId:text('learning_item_id').primaryKey(),hidden:integer('hidden').notNull().default(0),favorite:integer('favorite').notNull().default(0),note:text('note').notNull().default(''),version:integer('version').notNull().default(0),updatedAt:text('updated_at').notNull(),
});
export const materialFeedback=sqliteTable('material_feedback',{
  id:text('id').primaryKey(),materialId:text('material_id').notNull(),materialHash:text('material_hash').notNull(),learningItemId:text('learning_item_id').notNull(),rowIndex:integer('row_index').notNull(),reason:text('reason').notNull(),createdAt:text('created_at').notNull(),
});


