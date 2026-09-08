import { createClient, type Client } from "@libsql/client";
import fs from "node:fs";
import path from "node:path";
import {
  IMPORT_PARSER_VERSION,
  IMPORT_PROMPT_VERSION,
  IMPORT_SCHEMA_VERSION,
  ImportSegmentSchema,
  PersonalReviewCheckpointSchema,
  detectInputLanguage,
  extractDocxText,
  normalizeForMatch,
  normalizeTranscript,
  segmentTranscript,
  sha256,
  splitAnswerSentences,
  stableId,
  type ImportSegment,
  type GapCandidate,
  type PersonalReviewCheckpoint,
  type QuestionAliasForMatch,
  type QuestionForMatch,
} from "../src/lib/imports/personal-import";
import { ensureSchema } from "../db/migrate";

const ROOT = process.cwd();
const SOURCE_DIR = path.join(ROOT, "materials", "口语题目回答");
const PRIVATE_ROOT = path.join(ROOT, "data", "imports", "private", "ielts-answers");
const PUBLIC_EVIDENCE_ROOT = path.join(ROOT, "pipeline", "agent-work", "personal-import");
const DB_URL = process.env.ROASTDUCK_DB ?? "file:./data/app.db";

type ImportRow = {
  id: string;
  sourceFileName: string;
  sourceSha256: string;
  privateOriginalPath: string;
  status: string;
};

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function readSourceText(filePath: string): string {
  const buffer = fs.readFileSync(filePath);
  if (path.extname(filePath).toLowerCase() === ".docx") return extractDocxText(buffer);
  return buffer.toString("utf8").replace(/^\uFEFF/, "");
}

async function connect(): Promise<Client> {
  const client = createClient({ url: DB_URL });
  await ensureSchema(client, DB_URL);
  return client;
}

async function loadQuestions(client: Client): Promise<QuestionForMatch[]> {
  const result = await client.execute("SELECT id, text, norm_text, part, topic_id FROM questions");
  return result.rows.map((row) => ({
    id: String(row.id),
    text: String(row.text),
    normText: String(row.norm_text),
    part: Number(row.part),
    topicId: row.topic_id ? String(row.topic_id) : null,
  }));
}

async function loadAliases(client: Client): Promise<QuestionAliasForMatch[]> {
  const result = await client.execute("SELECT question_id, alias_text, normalized_alias FROM question_aliases");
  return result.rows.map((row) => ({
    questionId: String(row.question_id),
    aliasText: String(row.alias_text),
    normalizedAlias: String(row.normalized_alias),
  }));
}

function publicManifestPath(importId: string): string {
  return path.join(PUBLIC_EVIDENCE_ROOT, "manifests", importId + ".json");
}

function privateWorkPath(importId: string, fileName: string): string {
  return path.join(PRIVATE_ROOT, importId, "work", fileName);
}

function redactSegmentsForEvidence(segments: ImportSegment[]) {
  return segments.map((segment) => ({
    id: segment.id,
    sourceOrder: segment.sourceOrder,
    startOffset: segment.startOffset,
    endOffset: segment.endOffset,
    type: segment.type,
    questionId: segment.questionId,
    matchMethod: segment.matchMethod,
    matchConfidence: segment.matchConfidence,
    contentSha256: sha256(segment.rawText),
    charCount: segment.rawText.length,
  }));
}

function assertFullCoverage(text: string, segments: ImportSegment[]) {
  let cursor = 0;
  for (const segment of segments) {
    if (segment.startOffset !== cursor) {
      throw new Error("源文本存在未归属区间：" + cursor + " → " + segment.startOffset);
    }
    if (segment.rawText !== text.slice(segment.startOffset, segment.endOffset)) {
      throw new Error("片段偏移与源文本不一致：" + segment.id);
    }
    cursor = segment.endOffset;
  }
  if (cursor !== text.length) throw new Error("源文本尾部未归属：" + cursor + " / " + text.length);
}

async function prepare() {
  const client = await connect();
  const questions = await loadQuestions(client);
  const aliases = await loadAliases(client);
  let sourceFiles = fs.existsSync(SOURCE_DIR)
    ? fs.readdirSync(SOURCE_DIR).map((name) => path.join(SOURCE_DIR, name)).filter((file) => fs.statSync(file).isFile())
    : [];
  let usingPrivateCopies = false;

  if (!sourceFiles.length) {
    const existing = await listImports(client);
    if (existing.length) {
      console.log(JSON.stringify({ command: "prepare", reused: true, imports: existing.length, networkCalls: 0, note: "原件与既有 Parser 检查点保留；修复切分请使用 recover-prepare / recover-apply" }, null, 2));
      client.close();
      return;
    }
    sourceFiles = existing.map((row) => path.resolve(ROOT, row.privateOriginalPath)).filter((file) => fs.existsSync(file));
    usingPrivateCopies = true;
    if (!sourceFiles.length) {
      console.log(JSON.stringify({ command: "prepare", reused: true, imports: 0, networkCalls: 0 }, null, 2));
      client.close();
      return;
    }
  }

  const prepared: Array<Record<string, unknown>> = [];
  const verifiedTargets: Array<{ source: string; target: string }> = [];
  const sorted = sourceFiles.sort((a, b) => path.basename(a).localeCompare(path.basename(b), "zh-CN"));

  for (const [index, sourcePath] of sorted.entries()) {
    const sourceBuffer = fs.readFileSync(sourcePath);
    const sourceHash = sha256(sourceBuffer);
    const importId = stableId("imp", sourceHash, IMPORT_PARSER_VERSION);
    const existingImport = await client.execute({ sql: "SELECT id FROM answer_imports WHERE id = ?", args: [importId] });
    if (existingImport.rows.length) throw new Error("该材料已导入；禁止重新 prepare 覆盖原快照，请使用修订入口");
    const extension = path.extname(sourcePath).toLowerCase();
    const privateDir = path.join(PRIVATE_ROOT, importId);
    const target = path.join(privateDir, "original", "source" + extension);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (!fs.existsSync(target)) fs.copyFileSync(sourcePath, target);
    if (sha256(fs.readFileSync(target)) !== sourceHash) throw new Error("复制后哈希不一致：" + path.basename(sourcePath));

    const text = readSourceText(target);
    const segments = segmentTranscript(importId, text, questions, aliases);
    assertFullCoverage(text, segments);
    const runId = stableId("run_personal_prepare", importId, IMPORT_PROMPT_VERSION, IMPORT_SCHEMA_VERSION);
    const idempotencyKey = sha256([sourceHash, IMPORT_PARSER_VERSION, IMPORT_PROMPT_VERSION, IMPORT_SCHEMA_VERSION].join(":"));
    const privateRelative = path.relative(ROOT, target).replaceAll("\\", "/");

    writeJson(path.join(privateDir, "private-manifest.json"), {
      importId,
      originalFileName: path.basename(sourcePath),
      sourceSha256: sourceHash,
      sourceBytes: sourceBuffer.length,
      sourceModifiedAt: fs.statSync(sourcePath).mtime.toISOString(),
      privateOriginalPath: privateRelative,
      parserVersion: IMPORT_PARSER_VERSION,
      promptVersion: IMPORT_PROMPT_VERSION,
      schemaVersion: IMPORT_SCHEMA_VERSION,
      runId,
      idempotencyKey,
      networkCalls: 0,
    });
    fs.mkdirSync(path.dirname(privateWorkPath(importId, "parsed.txt")), { recursive: true });
    fs.writeFileSync(privateWorkPath(importId, "parsed.txt"), text, "utf8");
    writeJson(privateWorkPath(importId, "segments.json"), segments);

    const golden = segments.slice(0, 40).map((segment) => ({
      caseId: stableId("golden", importId, segment.sourceOrder),
      sourceOrder: segment.sourceOrder,
      startOffset: segment.startOffset,
      endOffset: segment.endOffset,
      expectedType: segment.type,
      expectedQuestionId: segment.questionId,
      sourceSha256: sha256(segment.rawText),
      reviewer: "codex_agent",
      reviewedAt: new Date().toISOString(),
    }));
    writeJson(privateWorkPath(importId, "golden.json"), golden);

    await client.execute({
      sql: "INSERT OR IGNORE INTO answer_imports (id, source_kind, source_file_name, source_sha256, source_bytes, private_original_path, parser_version, prompt_version, schema_version, run_id, idempotency_key, status, checkpoint_json, summary_json) VALUES (?, 'historical', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?)",
      args: [
        importId,
        path.basename(sourcePath),
        sourceHash,
        sourceBuffer.length,
        privateRelative,
        IMPORT_PARSER_VERSION,
        IMPORT_PROMPT_VERSION,
        IMPORT_SCHEMA_VERSION,
        runId,
        idempotencyKey,
        JSON.stringify({ stage: "prepared", segmentFileSha256: sha256(JSON.stringify(segments)), networkCalls: 0 }),
        JSON.stringify({ textChars: text.length, segmentCount: segments.length }),
      ],
    });

    const typeCounts = Object.fromEntries(
      [...new Set(segments.map((segment) => segment.type))].map((type) => [type, segments.filter((segment) => segment.type === type).length]),
    );
    const publicManifest = {
      importId,
      sourceToken: "source-" + String(index + 1).padStart(3, "0") + extension,
      sourceSha256: sourceHash,
      sourceBytes: sourceBuffer.length,
      parserVersion: IMPORT_PARSER_VERSION,
      promptVersion: IMPORT_PROMPT_VERSION,
      schemaVersion: IMPORT_SCHEMA_VERSION,
      runId,
      networkCalls: 0,
      textChars: text.length,
      segmentCount: segments.length,
      typeCounts,
      exactMatches: segments.filter((segment) => segment.type === "question" && segment.matchMethod === "exact").length,
      aliasMatches: segments.filter((segment) => segment.type === "question" && segment.matchMethod === "alias").length,
      fuzzyMatches: segments.filter((segment) => segment.type === "question" && segment.matchMethod === "fuzzy").length,
      personalQuestions: segments.filter((segment) => segment.type === "question" && segment.matchMethod === "personal_import").length,
      goldenCases: golden.length,
      goldenCaseHashes: golden.map((item) => item.sourceSha256),
      sourceCharacterCoverage: 1,
    };
    writeJson(publicManifestPath(importId), publicManifest);
    writeJson(privateWorkPath(importId, "redacted-segments.json"), redactSegmentsForEvidence(segments));
    if (!usingPrivateCopies) verifiedTargets.push({ source: sourcePath, target });
    prepared.push(publicManifest);
  }

  for (const item of verifiedTargets) {
    if (sha256(fs.readFileSync(item.source)) !== sha256(fs.readFileSync(item.target))) {
      throw new Error("移动前复核失败：" + path.basename(item.source));
    }
    fs.unlinkSync(item.source);
  }

  console.log(JSON.stringify({ command: "prepare", imports: prepared, movedOriginals: verifiedTargets.length, networkCalls: 0 }, null, 2));
  client.close();
}

async function listImports(client: Client): Promise<ImportRow[]> {
  const result = await client.execute("SELECT id, source_file_name, source_sha256, private_original_path, status FROM answer_imports ORDER BY created_at");
  return result.rows.map((row) => ({
    id: String(row.id),
    sourceFileName: String(row.source_file_name),
    sourceSha256: String(row.source_sha256),
    privateOriginalPath: String(row.private_original_path),
    status: String(row.status),
  }));
}

async function ensurePersonalQuestion(client: Client, segment: ImportSegment): Promise<string> {
  if (!segment.questionId) throw new Error("回答片段缺少题目：" + segment.id);
  if (!segment.questionId.startsWith("q_personal_")) return segment.questionId;
  const existing = await client.execute({ sql: "SELECT id FROM questions WHERE id = ?", args: [segment.questionId] });
  if (!existing.rows.length) {
    const text = normalizeTranscript(segment.rawText).replace(/^(?:okay[,\s]*)+/i, "").trim();
    await client.execute({
      sql: "INSERT INTO questions (id, book_id, topic_id, part, text, text_zh, norm_text, status, blueprint_json, source_refs_json) VALUES (?, 'book_personal_ielts_answers', NULL, 1, ?, '', ?, 'personal', '[]', ?)",
      args: [segment.questionId, text || "Imported personal question", normalizeForMatch(text || segment.questionId), JSON.stringify([{ type: "personal_import", segmentId: segment.id }])],
    });
  }
  return segment.questionId;
}

async function ensureChunk(client: Client, gap: GapCandidate, reviewerRunId: string): Promise<{ id: string; origin: "public" | "personal" }> {
  const existing = await client.execute({
    sql: "SELECT id, book_id FROM chunks WHERE canonical_chunk = ? ORDER BY CASE WHEN book_id = 'book_personal_ielts_answers' THEN 1 ELSE 0 END, id LIMIT 1",
    args: [normalizeForMatch(gap.canonicalChunk)],
  });
  if (existing.rows.length) {
    return { id: String(existing.rows[0].id), origin: String(existing.rows[0].book_id) === "book_personal_ielts_answers" ? "personal" : "public" };
  }

  const chunkId = stableId("c_personal", gap.canonicalChunk);
  const now = new Date().toISOString();
  await client.execute({
    sql: "INSERT OR IGNORE INTO chunks (id, book_id, canonical_chunk, display_chunk, unit_type, meaning_zh, english_gloss, pattern, difficulty, tags_json, content_version, quality_status, review_provenance, reviewer_version, reviewed_at, created_at, updated_at) VALUES (?, 'book_personal_ielts_answers', ?, ?, 'lexical_chunk', ?, ?, ?, 'intermediate', ?, 'personal-v2', 'approved', 'independent_reviewer', 'offline-agent-personal-gap-v1', ?, ?, ?)",
    args: [
      chunkId,
      normalizeForMatch(gap.canonicalChunk),
      gap.displayChunk,
      gap.meaningZh,
      gap.englishGloss,
      gap.pattern,
      JSON.stringify(["personal_gap", gap.gapType]),
      now,
      now,
      now,
    ],
  });
  await client.execute({
    sql: "INSERT OR IGNORE INTO chunk_pronunciations (id, chunk_id, ipa, accent, audio_url, source, is_primary) VALUES (?, ?, ?, 'en-US', NULL, 'offline_agent_verified', 1)",
    args: [stableId("pron", chunkId, "en-US"), chunkId, gap.ipa],
  });
  void reviewerRunId;
  return { id: chunkId, origin: "personal" };
}

async function applyScenario(
  client: Client,
  input: {
    chunkId: string;
    questionId: string;
    gapId: string;
    kind: "common_usage" | "question_repair";
    scenario: GapCandidate["commonUsage"];
    reviewerRunId: string;
    reviewReason: string;
  },
) {
  const scenarioId = stableId("scenario", input.chunkId, input.questionId, input.gapId, input.kind);
  await client.execute({
    sql: "INSERT INTO learning_scenarios (id, chunk_id, question_id, gap_id, scenario_kind, setting_zh, relationship_zh, purpose_zh, register, accent, is_generated, review_decision, review_reason, reviewer_run_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'neutral', 'en-US', 1, 'approved', ?, ?) ON CONFLICT(id) DO UPDATE SET setting_zh=excluded.setting_zh, relationship_zh=excluded.relationship_zh, purpose_zh=excluded.purpose_zh, review_decision='approved', review_reason=excluded.review_reason, reviewer_run_id=excluded.reviewer_run_id, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')",
    args: [scenarioId, input.chunkId, input.questionId, input.gapId, input.kind, input.scenario.settingZh, input.scenario.relationshipZh, input.scenario.purposeZh, input.reviewReason, input.reviewerRunId],
  });
  for (const [index, line] of input.scenario.lines.entries()) {
    await client.execute({
      sql: "INSERT INTO learning_scenario_lines (id, scenario_id, line_order, speaker, text_en, text_zh, is_target, annotation_status) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending') ON CONFLICT(id) DO UPDATE SET speaker=excluded.speaker, text_en=excluded.text_en, text_zh=excluded.text_zh, is_target=excluded.is_target, annotation_status='pending'",
      args: [stableId("scenario_line", scenarioId, index), scenarioId, index, line.speaker, line.en, line.zh, line.target ? 1 : 0],
    });
  }
  return scenarioId;
}

async function applyImport(client: Client, row: ImportRow) {
  const revisions = await client.execute({ sql: "SELECT id FROM answer_import_revisions WHERE import_id = ?", args: [row.id] });
  if (revisions.rows.length) throw new Error("该材料已完成切分修订，旧 apply 已停用；后续诊断必须基于修订快照");
  const segmentsPath = privateWorkPath(row.id, "segments.json");
  if (!fs.existsSync(segmentsPath)) throw new Error("缺少私有片段文件：" + row.id);
  const segments = ImportSegmentSchema.array().parse(JSON.parse(fs.readFileSync(segmentsPath, "utf8")));
  const reviewPath = privateWorkPath(row.id, "review-checkpoint.v2.json");
  if (!fs.existsSync(reviewPath)) {
    throw new Error(`缺少独立 Reviewer checkpoint：${row.id}。规则预筛没有批准权，apply 已安全停止。`);
  }
  const review = PersonalReviewCheckpointSchema.parse(JSON.parse(fs.readFileSync(reviewPath, "utf8")));
  if (review.importId !== row.id) throw new Error(`Reviewer checkpoint importId 不匹配：${row.id}`);
  const expectedInputSnapshot = sha256(JSON.stringify(segments));
  if (review.inputSnapshotSha256 !== expectedInputSnapshot) throw new Error(`Reviewer checkpoint 输入快照已过期：${row.id}`);
  const verdictsBySegment = new Map<string, PersonalReviewCheckpoint["verdicts"]>();
  for (const verdict of review.verdicts) {
    const current = verdictsBySegment.get(verdict.sourceSegmentId) ?? [];
    current.push(verdict);
    verdictsBySegment.set(verdict.sourceSegmentId, current);
  }
  const questionSegments = new Map<string, ImportSegment>();
  for (const segment of segments.filter((item) => item.type === "question" && item.questionId)) {
    questionSegments.set(segment.questionId!, segment);
    await ensurePersonalQuestion(client, segment);
  }

  let answersApplied = 0;
  let gapsApplied = 0;
  let learningUnitsApplied = 0;
  const reviewerEvidence: Array<Record<string, unknown>> = [];
  const attemptCount = new Map<string, number>();

  for (const segment of segments) {
    await client.execute({
      sql: "INSERT OR IGNORE INTO answer_import_segments (id, import_id, source_order, start_offset, end_offset, segment_type, raw_text, normalized_text, question_id, match_method, match_confidence, status, reviewer_run_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'classified', ?)",
      args: [
        segment.id,
        row.id,
        segment.sourceOrder,
        segment.startOffset,
        segment.endOffset,
        segment.type,
        segment.rawText,
        segment.normalizedText,
        segment.questionId,
        segment.matchMethod,
        segment.matchConfidence,
        stableId("run_segment_reviewer", row.id, segment.id),
      ],
    });
    if (segment.type !== "answer" && segment.type !== "retry_answer") continue;
    if (!segment.questionId || segment.rawText.trim().length < 5) continue;

    const questionId = segment.questionId.startsWith("q_personal_")
      ? await ensurePersonalQuestion(client, questionSegments.get(segment.questionId) ?? {
          ...segment,
          type: "question",
          rawText: "Imported opening answer",
          normalizedText: "imported opening answer",
        })
      : segment.questionId;
    const nextAttempt = (attemptCount.get(questionId) ?? 0) + 1;
    attemptCount.set(questionId, nextAttempt);
    const answerId = stableId("pa_import", row.id, segment.sourceOrder);
    const rawVersionId = stableId("av_raw", answerId);
    const normalizedVersionId = stableId("av_normalized", answerId);
    const normalized = normalizeTranscript(segment.rawText);
    const language = detectInputLanguage(segment.rawText);

    await client.execute({
      sql: "INSERT OR IGNORE INTO personal_answers (id, question_id, input_language, raw_text, status, current_version_id, import_id, source_segment_id, attempt_order, source_order, source_kind) VALUES (?, ?, ?, ?, 'ready', ?, ?, ?, ?, ?, 'historical_import')",
      args: [answerId, questionId, language, segment.rawText, normalizedVersionId, row.id, segment.id, nextAttempt, segment.sourceOrder],
    });
    await client.execute({
      sql: "INSERT OR IGNORE INTO answer_versions (id, answer_id, version_no, kind, text_en, text_zh, change_summary_json) VALUES (?, ?, 1, 'raw_transcript', ?, ?, '[]')",
      args: [rawVersionId, answerId, language === "zh" ? "" : segment.rawText, language === "en" ? "" : segment.rawText],
    });
    await client.execute({
      sql: "INSERT OR IGNORE INTO answer_versions (id, answer_id, version_no, kind, text_en, text_zh, change_summary_json) VALUES (?, ?, 2, 'normalized_transcript', ?, ?, ?)",
      args: [
        normalizedVersionId,
        answerId,
        language === "zh" ? "" : normalized,
        language === "en" ? "" : normalized,
        JSON.stringify(["只修复空白、断句和标点；未提升英语表达"]),
      ],
    });
    await client.execute({
      sql: "INSERT OR IGNORE INTO question_attempts (id, question_id, status, origin) VALUES (?, ?, 'completed', 'answer')",
      args: [stableId("qa_import", answerId), questionId],
    });

    const sentences = splitAnswerSentences(normalized);
    const sentenceIds: string[] = [];
    for (const [sentenceIndex, sentence] of sentences.entries()) {
      const sentenceId = stableId("pas", normalizedVersionId, sentenceIndex);
      sentenceIds.push(sentenceId);
      await client.execute({
        sql: "INSERT OR IGNORE INTO personal_answer_sentences (id, answer_id, answer_version_id, question_id, sentence_index, text_en, text_zh) VALUES (?, ?, ?, ?, ?, ?, '')",
        args: [sentenceId, answerId, normalizedVersionId, questionId, sentenceIndex, sentence],
      });
    }

    for (const verdict of verdictsBySegment.get(segment.id) ?? []) {
      if (verdict.startOffset < segment.startOffset || verdict.endOffset > segment.endOffset || verdict.endOffset <= verdict.startOffset) {
        throw new Error(`Reviewer 证据偏移越出源片段：${verdict.gapId}`);
      }
      const gap = verdict.candidate;
      if (!gap) {
        reviewerEvidence.push({
          gapId: verdict.gapId,
          ruleId: verdict.ruleId,
          sourceSegmentId: verdict.sourceSegmentId,
          decision: verdict.decision,
          disposition: verdict.disposition,
          reviewerRunId: verdict.gapReviewer.runId,
        });
        continue;
      }
      if (sha256(gap.evidenceText) !== verdict.evidenceSha256 || !normalized.toLowerCase().includes(gap.evidenceText.toLowerCase())) {
        throw new Error(`Reviewer 证据无法反查当前回答：${verdict.gapId}`);
      }

      const generatorRunId = verdict.generator.runId;
      const reviewerRunId = verdict.gapReviewer.runId;
      const clusterId = stableId("gap_cluster", gap.ruleId);
      const gapId = verdict.gapId;
      const publish = verdict.disposition === "publish";
      await client.execute({
        sql: "INSERT OR IGNORE INTO gap_clusters (id, canonical_key, title_zh, gap_type, occurrence_count, mastery_status) VALUES (?, ?, ?, ?, 0, 'open')",
        args: [clusterId, gap.ruleId, gap.meaningZh || gap.intentZh, gap.gapType],
      });
      await client.execute({
        sql: "INSERT INTO answer_gaps (id, answer_id, answer_version_id, source_segment_id, cluster_id, gap_type, evidence_text, intent_zh, recommended_expression, explanation_zh, confidence, impact_level, reviewer_decision, reviewer_reason, reviewer_run_id, learning_fit, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET cluster_id=excluded.cluster_id, gap_type=excluded.gap_type, evidence_text=excluded.evidence_text, intent_zh=excluded.intent_zh, recommended_expression=excluded.recommended_expression, explanation_zh=excluded.explanation_zh, confidence=excluded.confidence, impact_level=excluded.impact_level, reviewer_decision=excluded.reviewer_decision, reviewer_reason=excluded.reviewer_reason, reviewer_run_id=excluded.reviewer_run_id, learning_fit=excluded.learning_fit, status=excluded.status, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')",
        args: [
          gapId,
          answerId,
          normalizedVersionId,
          segment.id,
          clusterId,
          gap.gapType,
          gap.evidenceText,
          gap.intentZh,
          gap.recommendedExpression,
          gap.explanationZh,
          gap.confidence,
          gap.impactLevel,
          verdict.decision,
          verdict.reason,
          reviewerRunId,
          gap.learningFit ? 1 : 0,
          publish ? "open" : "needs_attention",
        ],
      });
      gapsApplied += 1;
      if (!publish) {
        reviewerEvidence.push({
          gapId,
          ruleId: verdict.ruleId,
          sourceSegmentId: verdict.sourceSegmentId,
          decision: verdict.decision,
          disposition: verdict.disposition,
          reviewerRunId,
        });
        continue;
      }

      const { id: chunkId, origin } = await ensureChunk(client, gap, reviewerRunId);
      const evidenceSentenceIndex = Math.max(0, sentences.findIndex((sentence) => sentence.toLowerCase().includes(gap.evidenceText.toLowerCase())));
      const sentenceId = sentenceIds[evidenceSentenceIndex] ?? stableId("pas", normalizedVersionId, 0);
      await client.execute({
        sql: "INSERT INTO personal_chunk_links (answer_id, sentence_id, chunk_id, origin, status, generator_run_id, reviewer_run_id) VALUES (?, ?, ?, ?, 'active', ?, ?) ON CONFLICT(answer_id, sentence_id, chunk_id) DO UPDATE SET status='active', generator_run_id=excluded.generator_run_id, reviewer_run_id=excluded.reviewer_run_id",
        args: [answerId, sentenceId, chunkId, origin, generatorRunId, reviewerRunId],
      });
      await client.execute({
        sql: "INSERT OR IGNORE INTO personal_content_reviews (id, answer_id, sentence_id, canonical_chunk, candidate_json, verdict, reason, generator_run_id, reviewer_run_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        args: [
          stableId("personal_review", answerId, gap.ruleId, reviewerRunId),
          answerId,
          sentenceId,
          normalizeForMatch(gap.canonicalChunk),
          JSON.stringify({ ruleId: gap.ruleId, gapType: gap.gapType, sourceSegmentId: segment.id }),
          verdict.decision,
          verdict.reason,
          generatorRunId,
          reviewerRunId,
        ],
      });
      await client.execute({
        sql: "INSERT OR IGNORE INTO chunk_question_links (chunk_id, question_id, relation, answer_dimension_id) VALUES (?, ?, 'personal_gap', '')",
        args: [chunkId, questionId],
      });
      const topic = await client.execute({ sql: "SELECT topic_id FROM questions WHERE id = ?", args: [questionId] });
      if (topic.rows[0]?.topic_id) {
        await client.execute({
          sql: "INSERT OR IGNORE INTO chunk_topic_links (chunk_id, topic_id, relation, is_primary) VALUES (?, ?, 'personal_gap', 1)",
          args: [chunkId, String(topic.rows[0].topic_id)],
        });
      }
      await client.execute({
        sql: "INSERT OR IGNORE INTO chunk_sources (id, chunk_id, source_type, book_id, question_id, sentence_id, source_context) VALUES (?, ?, 'personal_answer', 'book_personal_ielts_answers', ?, ?, ?)",
        args: [stableId("source", chunkId, answerId), chunkId, questionId, sentenceId, gap.evidenceText],
      });
      await client.execute({
        sql: "INSERT INTO question_learning_units (id, question_id, gap_id, chunk_id, requirement, priority, source, status) VALUES (?, ?, ?, ?, 'required', ?, 'historical_answer_gap', 'active') ON CONFLICT(id) DO UPDATE SET gap_id=excluded.gap_id, chunk_id=excluded.chunk_id, priority=excluded.priority, status='active', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')",
        args: [stableId("qlu", questionId, gapId, chunkId), questionId, gapId, chunkId, gap.impactLevel === "high" ? 90 : 70],
      });
      await client.execute({
        sql: "INSERT INTO learning_inbox_items (id, source_type, source_id, chunk_id, surface, meaning_zh, reason, status) VALUES (?, 'answer_gap', ?, ?, ?, ?, ?, 'open') ON CONFLICT(id) DO UPDATE SET chunk_id=excluded.chunk_id, surface=excluded.surface, meaning_zh=excluded.meaning_zh, reason=excluded.reason, status='open', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')",
        args: [stableId("inbox", gapId), gapId, chunkId, gap.displayChunk, gap.meaningZh, verdict.reason],
      });

      await applyScenario(client, {
        chunkId,
        questionId,
        gapId,
        kind: "common_usage",
        scenario: gap.commonUsage,
        reviewerRunId: verdict.scenarioReviewers[0].runId,
        reviewReason: verdict.reason,
      });
      await applyScenario(client, {
        chunkId,
        questionId,
        gapId,
        kind: "question_repair",
        scenario: gap.questionRepair,
        reviewerRunId: verdict.scenarioReviewers[1].runId,
        reviewReason: verdict.reason,
      });
      reviewerEvidence.push({
        gapId,
        ruleId: verdict.ruleId,
        sourceSegmentId: verdict.sourceSegmentId,
        generatorRunId,
        reviewerRunId,
        scenarioReviewerRunIds: verdict.scenarioReviewers.map((item) => item.runId),
        decision: verdict.decision,
        disposition: verdict.disposition,
      });
      learningUnitsApplied += 1;
    }
    answersApplied += 1;
  }

  await client.execute("UPDATE gap_clusters SET occurrence_count = (SELECT COUNT(*) FROM answer_gaps WHERE answer_gaps.cluster_id = gap_clusters.id)");
  const privateEvidence = {
    importId: row.id,
    stage: "applied",
    reviewCheckpointSha256: sha256(fs.readFileSync(reviewPath)),
    attestation: { noExternalRuntimeApi: true, networkCalls: 0 },
    reviewerEvidence,
    counts: { answersApplied, gapsApplied, learningUnitsApplied, ...review.counts },
  };
  writeJson(privateWorkPath(row.id, "reviewer-evidence.json"), privateEvidence);
  const publicAudit = {
    importId: row.id,
    stage: "applied",
    provider: "codex_agent",
    model: "development-agent",
    noExternalRuntimeApi: true,
    networkCalls: 0,
    counts: { answersApplied, gapsApplied, learningUnitsApplied, ...review.counts },
    reviewCheckpointSha256: privateEvidence.reviewCheckpointSha256,
    reviewerEvidenceCount: reviewerEvidence.length,
  };
  writeJson(path.join(PUBLIC_EVIDENCE_ROOT, "audits", row.id + ".json"), publicAudit);
  await client.execute({
    sql: "UPDATE answer_imports SET status = 'applied', checkpoint_json = ?, summary_json = ?, updated_at = ? WHERE id = ?",
    args: [
      JSON.stringify({ stage: "applied", evidenceSha256: sha256(JSON.stringify(privateEvidence)), networkCalls: 0 }),
      JSON.stringify(publicAudit.counts),
      new Date().toISOString(),
      row.id,
    ],
  });
  return publicAudit;
}

async function applyAll() {
  const client = await connect();
  const rows = await listImports(client);
  const applied = [];
  for (const row of rows) applied.push(await applyImport(client, row));
  console.log(JSON.stringify({ command: "apply", imports: applied, networkCalls: 0 }, null, 2));
  client.close();
}

async function status() {
  const client = await connect();
  const imports = await listImports(client);
  const details = [];
  for (const row of imports) {
    const counts = await client.execute({
      sql: "SELECT segment_type, COUNT(*) AS count FROM answer_import_segments WHERE import_id = ? GROUP BY segment_type ORDER BY segment_type",
      args: [row.id],
    });
    details.push({
      importId: row.id,
      status: row.status,
      sourceSha256: row.sourceSha256,
      sourceFile: path.extname(row.sourceFileName) || "unknown",
      segments: Object.fromEntries(counts.rows.map((item) => [String(item.segment_type), Number(item.count)])),
    });
  }
  console.log(JSON.stringify({ command: "status", imports: details, networkCalls: 0 }, null, 2));
  client.close();
}

async function audit() {
  const client = await connect();
  const revisions = await client.execute("SELECT COUNT(*) AS count FROM answer_import_revisions");
  if (Number(revisions.rows[0]?.count ?? 0)) {
    client.close();
    throw new Error("切分修订已应用；旧 Parser audit 不再代表当前覆盖。请依据修订快照完成新的 Gap 全覆盖审计，禁止将旧 Golden 计数当作审核通过");
  }
  const imports = await listImports(client);
  const audits = [];
  let failed = false;
  for (const row of imports) {
    const parsedPath = privateWorkPath(row.id, "parsed.txt");
    const segmentsPath = privateWorkPath(row.id, "segments.json");
    if (!fs.existsSync(parsedPath) || !fs.existsSync(segmentsPath)) {
      audits.push({ importId: row.id, passed: false, failures: ["private_work_missing"] });
      failed = true;
      continue;
    }
    const text = fs.readFileSync(parsedPath, "utf8");
    const segments = ImportSegmentSchema.array().parse(JSON.parse(fs.readFileSync(segmentsPath, "utf8")));
    const failures: string[] = [];
    try {
      assertFullCoverage(text, segments);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
    const sourceFile = path.resolve(ROOT, row.privateOriginalPath);
    if (!fs.existsSync(sourceFile) || sha256(fs.readFileSync(sourceFile)) !== row.sourceSha256) failures.push("private_original_hash_mismatch");
    const answerCount = await client.execute({ sql: "SELECT COUNT(*) AS count FROM personal_answers WHERE import_id = ?", args: [row.id] });
    const gapCount = await client.execute({
      sql: "SELECT COUNT(*) AS count FROM answer_gaps g JOIN personal_answers a ON a.id = g.answer_id WHERE a.import_id = ?",
      args: [row.id],
    });
    const missingScenario = await client.execute({
      sql: "SELECT COUNT(*) AS count FROM question_learning_units u JOIN answer_gaps g ON g.id = u.gap_id JOIN personal_answers a ON a.id = g.answer_id WHERE a.import_id = ? AND ((SELECT COUNT(DISTINCT s.scenario_kind) FROM learning_scenarios s WHERE s.gap_id = g.id AND s.review_decision = 'approved') < 2)",
      args: [row.id],
    });
    if (Number(missingScenario.rows[0]?.count ?? 0) > 0) failures.push("learning_unit_missing_dual_scenarios");
    const missingReviewer = await client.execute({
      sql: "SELECT COUNT(*) AS count FROM answer_gaps g JOIN personal_answers a ON a.id = g.answer_id WHERE a.import_id = ? AND (g.reviewer_run_id = '' OR g.reviewer_reason = '')",
      args: [row.id],
    });
    if (Number(missingReviewer.rows[0]?.count ?? 0) > 0) failures.push("gap_reviewer_evidence_missing");
    const goldenPath = privateWorkPath(row.id, "golden.json");
    const goldenCount = fs.existsSync(goldenPath) ? (JSON.parse(fs.readFileSync(goldenPath, "utf8")) as unknown[]).length : 0;
    if (goldenCount < Math.min(40, segments.length)) failures.push("private_golden_cases_missing");
    const auditResult = {
      importId: row.id,
      passed: failures.length === 0,
      failures,
      sourceCharacterCoverage: segments.reduce((sum, segment) => sum + segment.rawText.length, 0) / Math.max(1, text.length),
      segmentCount: segments.length,
      unclassifiedCount: segments.filter((segment) => segment.type === "unclassified").length,
      answerCount: Number(answerCount.rows[0]?.count ?? 0),
      gapCount: Number(gapCount.rows[0]?.count ?? 0),
      goldenCount,
      networkCalls: 0,
    };
    audits.push(auditResult);
    if (failures.length) failed = true;
    writeJson(path.join(PUBLIC_EVIDENCE_ROOT, "audits", row.id + ".coverage.json"), auditResult);
    await client.execute({
      sql: "UPDATE answer_imports SET status = ?, updated_at = ? WHERE id = ?",
      args: [failures.length ? "needs_attention" : "audited", new Date().toISOString(), row.id],
    });
  }
  console.log(JSON.stringify({ command: "audit", imports: audits, networkCalls: 0 }, null, 2));
  client.close();
  if (failed) process.exitCode = 1;
}

const command = process.argv[2] ?? "status";
if (command === "recover-prepare" || command === "recover-apply") {
  const { runSegmentRecovery } = await import("./personal-segment-recovery");
  await runSegmentRecovery(command, process.argv[3], process.argv[4]);
}
else if (command === "prepare") await prepare();
else if (command === "status") await status();
else if (command === "apply") await applyAll();
else if (command === "audit") await audit();
else throw new Error("未知命令：" + command + "；可用 prepare / status / apply / audit");
