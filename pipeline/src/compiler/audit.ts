/**
 * 发布审计：Coverage、Reviewer、关联、翻译、IPA、英文注解、来源、队列与 Golden 的统一硬闸门。
 * 任一项失败都不得编译词书，不提供绕过发布闸门的强制参数。
 */
import fs from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import { getDbReady } from "../../../db/client";
import { queueStatus } from "../lib/queue";
import { auditPublicationEvidence } from './quality_review';

const ROOT = path.resolve(process.cwd());
const REPORTS = process.env.ROASTDUCK_REPORTS_DIR ? path.resolve(process.env.ROASTDUCK_REPORTS_DIR) : path.join(ROOT, "pipeline/reports");

interface TextRecord {
  contentType: "sentence" | "example" | "question";
  contentId: string;
  text: string;
}

interface AnnotationRecord {
  contentType: string;
  contentId: string;
  startOffset: number;
  endOffset: number;
}

export interface AuditResult {
  ok: boolean;
  questions: { total: number; blueprintDone: number; chunked: number; audited: number };
  uncoveredQuestions: Array<{ id: string; text: string; reason: string }>;
  uncoveredDimensions: Array<{ questionId: string; dimId: string; dimZh: string }>;
  topics: { total: number; domainsDone: number; chunked: number; uncoveredDomains: number };
  sentences: { total: number; pending: number; chunked: number; covered: number; noNewUnit: number };
  chunks: {
    total: number;
    approved: number;
    edited: number;
    pendingReview: number;
    rejected: number;
    independentlyReviewed: number;
  };
  queues: { pending: number; byStage: Record<string, { pending: number; done: number; rejected: number }> };
  relations: { missingTopicLinks: string[]; linkedQuestions: number; missingSources: string[] };
  content: { missingEnglishGloss: string[]; missingExampleTranslation: string[]; missingIpa: string[] };
  annotations: {
    totalEnglishTokens: number;
    coveredEnglishTokens: number;
    coverageRate: number;
    uncovered: Array<{ contentType: string; contentId: string; token: string; start: number }>;
    unverifiedLexemes: Array<{ id: string; surface: string; status: string }>;
  };
  sources: { invalidContexts: string[]; blockedPodcastBooks: string[] };
  golden: { passed: boolean; reason: string };
  violations: string[];
  reviewerEvidenceFailures: Array<{ chunkId: string; reason: string }>;
}

function numberValue(value: number | bigint | null | undefined): number {
  return Number(value ?? 0);
}

function readGoldenStatus(): { passed: boolean; reason: string } {
  const file = path.join(REPORTS, "golden-latest.json");
  if (!fs.existsSync(file)) return { passed: false, reason: "当前证据目录缺少 golden-latest.json" };
  try {
    const report = JSON.parse(fs.readFileSync(file, "utf-8")) as {
      ok?: boolean;
      contentVersion?: string;
      checkedAt?: string;
    };
    if (!report.ok) return { passed: false, reason: "Golden Runner 最近一次结果未通过" };
    if (!report.contentVersion) return { passed: false, reason: "Golden 报告缺少 contentVersion" };
    return { passed: true, reason: `通过（${report.contentVersion}，${report.checkedAt ?? "时间未知"}）` };
  } catch {
    return { passed: false, reason: "Golden 报告无法解析" };
  }
}

function calculateAnnotationCoverage(texts: TextRecord[], annotations: AnnotationRecord[]) {
  const byContent = new Map<string, AnnotationRecord[]>();
  for (const annotation of annotations) {
    const key = `${annotation.contentType}|${annotation.contentId}`;
    const list = byContent.get(key) ?? [];
    list.push(annotation);
    byContent.set(key, list);
  }

  let totalEnglishTokens = 0;
  let coveredEnglishTokens = 0;
  const uncovered: Array<{ contentType: string; contentId: string; token: string; start: number }> = [];
  for (const record of texts) {
    const spans = byContent.get(`${record.contentType}|${record.contentId}`) ?? [];
    for (const match of record.text.matchAll(/[A-Za-z]+(?:['’][A-Za-z]+)*/g)) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      totalEnglishTokens += 1;
      if (spans.some((span) => span.startOffset <= start && span.endOffset >= end)) {
        coveredEnglishTokens += 1;
      } else if (uncovered.length < 200) {
        uncovered.push({ contentType: record.contentType, contentId: record.contentId, token: match[0], start });
      }
    }
  }
  return {
    totalEnglishTokens,
    coveredEnglishTokens,
    coverageRate: totalEnglishTokens === 0 ? 0 : coveredEnglishTokens / totalEnglishTokens,
    uncovered,
  };
}

export async function runAudit(): Promise<AuditResult> {
  const db = await getDbReady();
  const violations: string[] = [];
  const reviewerEvidenceFailures = await auditPublicationEvidence();
  if (reviewerEvidenceFailures.length) violations.push(`${reviewerEvidenceFailures.length} 条已发布 Chunk 的独立审核证据失效`);

  const qStats = await db.all<{ total: number; blueprint_done: number; chunked: number; audited: number }>(sql`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN q.status = 'blueprint_done' THEN 1 ELSE 0 END) AS blueprint_done,
      SUM(CASE WHEN q.status = 'chunked' THEN 1 ELSE 0 END) AS chunked,
      SUM(CASE WHEN q.status = 'audited' THEN 1 ELSE 0 END) AS audited
    FROM questions q JOIN books b ON b.id = q.book_id
    WHERE b.source_type != 'personal_answers'`);
  const tStats = await db.all<{ total: number; domains_done: number; chunked: number }>(sql`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN t.status = 'domains_done' THEN 1 ELSE 0 END) AS domains_done,
      SUM(CASE WHEN t.status = 'chunked' THEN 1 ELSE 0 END) AS chunked
    FROM topics t JOIN books b ON b.id = t.book_id
    WHERE b.source_type != 'personal_answers'`);
  const sStats = await db.all<{ total: number; pending: number; chunked: number; covered: number; no_new_unit: number }>(sql`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN s.status = 'pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN s.status = 'chunked' THEN 1 ELSE 0 END) AS chunked,
      SUM(CASE WHEN s.status = 'covered' THEN 1 ELSE 0 END) AS covered,
      SUM(CASE WHEN s.status = 'no_new_unit' THEN 1 ELSE 0 END) AS no_new_unit
    FROM source_sentences s JOIN books b ON b.id = s.book_id
    WHERE b.source_type != 'personal_answers'`);
  const cStats = await db.all<{
    total: number;
    approved: number;
    edited: number;
    pending_review: number;
    rejected: number;
    independently_reviewed: number;
  }>(sql`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN quality_status = 'approved' THEN 1 ELSE 0 END) AS approved,
      SUM(CASE WHEN quality_status = 'edited' THEN 1 ELSE 0 END) AS edited,
      SUM(CASE WHEN quality_status = 'pending_review' THEN 1 ELSE 0 END) AS pending_review,
      SUM(CASE WHEN quality_status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
      SUM(CASE WHEN review_provenance IN ('independent_reviewer','human_reviewer')
        AND quality_status IN ('approved','edited','rejected') THEN 1 ELSE 0 END) AS independently_reviewed
    FROM chunks c JOIN books b ON b.id = c.book_id
    WHERE b.source_type != 'personal_answers'`);

  const uncoveredDims = await db.all<{ question_id: string; dim_id: string; dim_zh: string }>(sql`
    SELECT q.id AS question_id, json_extract(d.value, '$.dimId') AS dim_id,
           json_extract(d.value, '$.dimZh') AS dim_zh
    FROM questions q JOIN books b ON b.id = q.book_id, json_each(q.blueprint_json) d
    WHERE b.source_type != 'personal_answers'
      AND q.status IN ('blueprint_done', 'chunked', 'audited')
      AND json_extract(d.value, '$.dimId') IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM chunk_coverage_refs r JOIN chunks c ON c.id = r.chunk_id
        WHERE r.question_id = q.id AND r.dim_id = json_extract(d.value, '$.dimId')
          AND c.quality_status IN ('approved','edited')
      )`);
  const uncoveredDomains = await db.all<{ topic_id: string; domain_id: string }>(sql`
    SELECT t.id AS topic_id, json_extract(d.value, '$.domainId') AS domain_id
    FROM topics t JOIN books b ON b.id = t.book_id, json_each(t.domains_json) d
    WHERE b.source_type != 'personal_answers'
      AND t.status IN ('domains_done','chunked','audited')
      AND NOT EXISTS (
        SELECT 1 FROM chunk_coverage_refs r JOIN chunks c ON c.id = r.chunk_id
        WHERE r.topic_id = t.id AND r.domain_id = json_extract(d.value, '$.domainId')
          AND c.quality_status IN ('approved','edited')
      )`);
  const unprocessed = await db.all<{ id: string; text: string; status: string }>(sql`
    SELECT q.id, q.text, q.status FROM questions q JOIN books b ON b.id = q.book_id
    WHERE b.source_type != 'personal_answers' AND q.status = 'pending' LIMIT 200`);

  const missingTopicLinks = await db.all<{ id: string }>(sql`
    SELECT c.id FROM chunks c JOIN books b ON b.id = c.book_id
    WHERE b.source_type != 'personal_answers' AND c.quality_status != 'rejected'
      AND NOT EXISTS (SELECT 1 FROM chunk_topic_links l WHERE l.chunk_id = c.id)
    ORDER BY c.id`);
  const linkedQuestionsRows = await db.all<{ count: number }>(sql`
    SELECT COUNT(DISTINCT l.chunk_id) AS count
    FROM chunk_question_links l JOIN chunks c ON c.id = l.chunk_id JOIN books b ON b.id = c.book_id
    WHERE b.source_type != 'personal_answers'`);
  const missingSources = await db.all<{ id: string }>(sql`
    SELECT c.id FROM chunks c JOIN books b ON b.id = c.book_id
    WHERE b.source_type != 'personal_answers' AND c.quality_status != 'rejected'
      AND NOT EXISTS (SELECT 1 FROM chunk_sources s WHERE s.chunk_id = c.id)
    ORDER BY c.id`);
  const missingGloss = await db.all<{ id: string }>(sql`
    SELECT c.id FROM chunks c JOIN books b ON b.id = c.book_id
    WHERE b.source_type != 'personal_answers' AND c.quality_status != 'rejected' AND trim(c.english_gloss) = '' ORDER BY c.id`);
  const missingTranslations = await db.all<{ id: string }>(sql`
    SELECT e.id FROM chunk_examples e JOIN chunks c ON c.id = e.chunk_id JOIN books b ON b.id = c.book_id
    WHERE b.source_type != 'personal_answers' AND c.quality_status != 'rejected' AND trim(e.text_zh) = '' ORDER BY e.id`);
  const missingIpa = await db.all<{ id: string }>(sql`
    SELECT c.id FROM chunks c JOIN books b ON b.id = c.book_id
    WHERE b.source_type != 'personal_answers' AND c.quality_status != 'rejected'
      AND NOT EXISTS (SELECT 1 FROM chunk_pronunciations p WHERE p.chunk_id = c.id AND trim(p.ipa) != '')
    ORDER BY c.id`);
  const invalidContexts = await db.all<{ id: string }>(sql`
    SELECT e.id FROM chunk_examples e JOIN chunks c ON c.id = e.chunk_id JOIN books b ON b.id = c.book_id
    WHERE b.source_type != 'personal_answers' AND c.quality_status != 'rejected' AND (
      (e.context_type = 'source_neighbors' AND (e.generated != 0 OR e.source_sentence_id IS NULL
        OR NOT EXISTS (SELECT 1 FROM source_sentences s WHERE s.id = e.source_sentence_id)))
      OR
      (e.context_type = 'generated_ielts' AND (e.generated != 1
        OR NOT EXISTS (SELECT 1 FROM chunk_question_links q WHERE q.chunk_id = e.chunk_id)))
    ) ORDER BY e.id`);
  const blockedPodcastBooks = await db.all<{ id: string }>(sql`
    SELECT b.id FROM books b WHERE b.source_type = 'podcast'
      AND NOT EXISTS (SELECT 1 FROM source_sentences s WHERE s.book_id = b.id)
      AND (b.status != 'blocked' OR trim(COALESCE(b.blocked_reason,'')) = '')`);

  const texts = await db.all<TextRecord>(sql`
    SELECT 'sentence' AS contentType, s.id AS contentId, s.text
    FROM source_sentences s JOIN books b ON b.id = s.book_id WHERE b.source_type != 'personal_answers'
    UNION ALL
    SELECT 'example', e.id, e.text_en
    FROM chunk_examples e JOIN chunks c ON c.id = e.chunk_id JOIN books b ON b.id = c.book_id
    WHERE b.source_type != 'personal_answers'
    UNION ALL
    SELECT 'question', q.id, q.text
    FROM questions q JOIN books b ON b.id = q.book_id WHERE b.source_type != 'personal_answers'`);
  const annotationRows = await db.all<AnnotationRecord>(sql`
    SELECT content_type AS contentType, content_id AS contentId,
      start_offset AS startOffset, end_offset AS endOffset FROM text_annotations`);
  const annotations = calculateAnnotationCoverage(texts, annotationRows);
  const unverifiedLexemes = await db.all<{ id: string; surface: string; status: string }>(sql`
    SELECT DISTINCT l.id, l.surface, l.status
    FROM text_annotations a JOIN lexemes l ON l.id = a.lexeme_id
    WHERE l.status != 'verified' AND (
      (a.content_type = 'sentence' AND EXISTS (
        SELECT 1 FROM source_sentences s JOIN books b ON b.id = s.book_id
        WHERE s.id = a.content_id AND b.source_type != 'personal_answers'))
      OR (a.content_type = 'example' AND EXISTS (
        SELECT 1 FROM chunk_examples e JOIN chunks c ON c.id = e.chunk_id JOIN books b ON b.id = c.book_id
        WHERE e.id = a.content_id AND b.source_type != 'personal_answers'))
      OR (a.content_type = 'question' AND EXISTS (
        SELECT 1 FROM questions q JOIN books b ON b.id = q.book_id
        WHERE q.id = a.content_id AND b.source_type != 'personal_answers'))
    ) ORDER BY l.surface`);

  const queuesByStage = queueStatus();
  const pendingBatches = Object.values(queuesByStage).reduce((sum, stage) => sum + stage.pending, 0);
  const golden = readGoldenStatus();

  const checks: Array<[boolean, string]> = [
    [unprocessed.length === 0, `待处理题目 ${unprocessed.length}`],
    [uncoveredDims.length === 0, `未覆盖 Answer Dimension ${uncoveredDims.length}`],
    [uncoveredDomains.length === 0, `未覆盖 Topic Domain ${uncoveredDomains.length}`],
    [numberValue(sStats[0]?.pending) === 0, `待处理原句 ${numberValue(sStats[0]?.pending)}`],
    [numberValue(cStats[0]?.pending_review) === 0, `待独立 Reviewer Chunk ${numberValue(cStats[0]?.pending_review)}`],
    [numberValue(cStats[0]?.independently_reviewed) === numberValue(cStats[0]?.total), "存在没有独立 Reviewer 证据的 Chunk"],
    [pendingBatches === 0, `待处理批次 ${pendingBatches}`],
    [missingTopicLinks.length === 0, `缺 Topic 关联 Chunk ${missingTopicLinks.length}`],
    [missingSources.length === 0, `缺来源 Chunk ${missingSources.length}`],
    [missingGloss.length === 0, `缺英文释义 Chunk ${missingGloss.length}`],
    [missingTranslations.length === 0, `缺例句中译 ${missingTranslations.length}`],
    [missingIpa.length === 0, `缺 IPA Chunk ${missingIpa.length}`],
    [annotations.totalEnglishTokens > 0 && annotations.coverageRate === 1, `英文点击注解覆盖率 ${(annotations.coverageRate * 100).toFixed(2)}%`],
    [unverifiedLexemes.length === 0, `待人工确认词条 ${unverifiedLexemes.length}`],
    [invalidContexts.length === 0, `来源/生成上下文标记非法 ${invalidContexts.length}`],
    [blockedPodcastBooks.length === 0, `缺 Transcript 的 Podcast Book 未正确阻塞 ${blockedPodcastBooks.length}`],
    [golden.passed, golden.reason],
  ];
  for (const [passed, message] of checks) if (!passed) violations.push(message);

  const result: AuditResult = {
    ok: violations.length === 0,
    questions: {
      total: numberValue(qStats[0]?.total),
      blueprintDone: numberValue(qStats[0]?.blueprint_done),
      chunked: numberValue(qStats[0]?.chunked),
      audited: numberValue(qStats[0]?.audited),
    },
    uncoveredQuestions: unprocessed.map((u) => ({ id: u.id, text: u.text, reason: u.status })),
    uncoveredDimensions: uncoveredDims.map((d) => ({ questionId: d.question_id, dimId: d.dim_id, dimZh: d.dim_zh })),
    topics: {
      total: numberValue(tStats[0]?.total),
      domainsDone: numberValue(tStats[0]?.domains_done),
      chunked: numberValue(tStats[0]?.chunked),
      uncoveredDomains: uncoveredDomains.length,
    },
    sentences: {
      total: numberValue(sStats[0]?.total),
      pending: numberValue(sStats[0]?.pending),
      chunked: numberValue(sStats[0]?.chunked),
      covered: numberValue(sStats[0]?.covered),
      noNewUnit: numberValue(sStats[0]?.no_new_unit),
    },
    chunks: {
      total: numberValue(cStats[0]?.total),
      approved: numberValue(cStats[0]?.approved),
      edited: numberValue(cStats[0]?.edited),
      pendingReview: numberValue(cStats[0]?.pending_review),
      rejected: numberValue(cStats[0]?.rejected),
      independentlyReviewed: Math.max(0, numberValue(cStats[0]?.approved) + numberValue(cStats[0]?.edited) - reviewerEvidenceFailures.length),
    },
    queues: { pending: pendingBatches, byStage: queuesByStage },
    relations: {
      missingTopicLinks: missingTopicLinks.map((row) => row.id),
      linkedQuestions: numberValue(linkedQuestionsRows[0]?.count),
      missingSources: missingSources.map((row) => row.id),
    },
    content: {
      missingEnglishGloss: missingGloss.map((row) => row.id),
      missingExampleTranslation: missingTranslations.map((row) => row.id),
      missingIpa: missingIpa.map((row) => row.id),
    },
    annotations: { ...annotations, unverifiedLexemes },
    sources: {
      invalidContexts: invalidContexts.map((row) => row.id),
      blockedPodcastBooks: blockedPodcastBooks.map((row) => row.id),
    },
    golden,
    violations,
    reviewerEvidenceFailures,
  };

  const date = new Date().toISOString().slice(0, 10);
  const md = [
    `# Coverage & Publication Audit (${date})`,
    "",
    `- 结论: **${result.ok ? "PASS" : "未通过"}**`,
    `- Questions: ${result.questions.total}；未覆盖 Dimension=${result.uncoveredDimensions.length}`,
    `- Topics: ${result.topics.total}；未覆盖 Domain=${result.topics.uncoveredDomains}`,
    `- Sentences: ${result.sentences.total}；pending=${result.sentences.pending}`,
    `- Chunks: ${result.chunks.total}；独立 Reviewer=${result.chunks.independentlyReviewed}；pending=${result.chunks.pendingReview}`,
    `- 待处理批次: ${result.queues.pending}`,
    `- Topic 缺链: ${result.relations.missingTopicLinks.length}；Source 缺链: ${result.relations.missingSources.length}`,
    `- 缺英文释义: ${result.content.missingEnglishGloss.length}；缺例句中译: ${result.content.missingExampleTranslation.length}；缺 IPA: ${result.content.missingIpa.length}`,
    `- 英文注解覆盖: ${result.annotations.coveredEnglishTokens}/${result.annotations.totalEnglishTokens} (${(result.annotations.coverageRate * 100).toFixed(2)}%)`,
    `- 待人工确认词条: ${result.annotations.unverifiedLexemes.length}`,
    `- Golden: ${result.golden.passed ? "PASS" : "FAIL"} — ${result.golden.reason}`,
    "",
    `## 违规 (${result.violations.length})`,
    ...result.violations.map((violation) => `- ${violation}`),
  ].join("\n");
  fs.mkdirSync(REPORTS, { recursive: true });
  fs.writeFileSync(path.join(REPORTS, `coverage-audit-${date}.md`), md, "utf-8");
  fs.writeFileSync(path.join(REPORTS, "coverage-audit-latest.json"), JSON.stringify(result, null, 1), "utf-8");
  return result;
}
