/**
 * compile_book 阶段（确定性）：编译 Book 1 → pipeline/books/*.json + Compilation Report。
 * 仅在 coverage audit 通过后执行；报告字段对齐主开发文档 §58。
 */
import fs from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import { getDbReady } from "../../../db/client";
import { runAudit, type AuditResult } from "./audit";
import { queueStatus } from "../lib/queue";
import { CONTENT_VERSION } from "./chunk_candidate";

const ROOT = path.resolve(process.cwd());
const BOOKS_DIR = path.join(ROOT, "pipeline/books");
const REPORTS = path.join(ROOT, "pipeline/reports");

const BOOK_ID = "book1_ielts_complete";

export async function compileBook1(): Promise<{ ok: boolean; audit: AuditResult }> {
  const db = await getDbReady();
  const audit = await runAudit();
  if (!audit.ok) {
    console.error("Coverage audit 未通过，拒绝编译。先解决 pipeline/reports/coverage-audit-latest.json 中的问题。");
    return { ok: false, audit };
  }

  // 标记已覆盖题目为 audited
  await db.run(sql`
    UPDATE questions SET status = 'audited'
    WHERE status IN ('blueprint_done', 'chunked')`);

  const chunksRows = await db.all(sql`
    SELECT c.*, t.name_en AS topic_name_en, t.name_zh AS topic_name_zh,
      (SELECT json_group_array(json_object('en', e.text_en, 'zh', e.text_zh))
       FROM chunk_examples e WHERE e.chunk_id = c.id) AS examples,
      (SELECT json_group_array(json_object('type', s.source_type, 'questionId', s.question_id,
              'sentenceId', s.sentence_id, 'context', s.source_context))
       FROM chunk_sources s WHERE s.chunk_id = c.id) AS sources,
      (SELECT json_group_array(json_object('refType', r.ref_type, 'questionId', r.question_id,
              'dimId', r.dim_id, 'topicId', r.topic_id, 'domainId', r.domain_id))
       FROM chunk_coverage_refs r WHERE r.chunk_id = c.id) AS coverageRefs
    FROM chunks c LEFT JOIN topics t ON t.id = c.topic_id
    WHERE c.book_id = ${BOOK_ID} AND c.quality_status IN ('approved', 'edited')`);
  const questionsRows = await db.all(sql`SELECT * FROM questions ORDER BY part, topic_id`);
  const topicsRows = await db.all(sql`SELECT * FROM topics ORDER BY ielts_part, sort`);
  const sentencesRows = await db.all(sql`SELECT * FROM source_sentences`);

  const book = {
    bookId: BOOK_ID,
    contentVersion: CONTENT_VERSION,
    compiledAt: new Date().toISOString(),
    counts: {
      chunks: chunksRows.length,
      questions: questionsRows.length,
      topics: topicsRows.length,
      sentences: sentencesRows.length,
    },
    chunks: chunksRows,
    topics: topicsRows,
    questions: questionsRows,
    sentences: sentencesRows,
  };
  fs.mkdirSync(BOOKS_DIR, { recursive: true });
  const outFile = path.join(BOOKS_DIR, `${BOOK_ID}.json`);
  fs.writeFileSync(outFile, JSON.stringify(book, null, 1), "utf-8");

  // Compilation Report（§58 全字段）
  const q = queueStatus();
  const doneCounts = (stage: string) => q[stage]?.done ?? 0;
  const date = new Date().toISOString();
  const md = [
    `# Content Compilation Report — Book 1`,
    "",
    `- 编译时间: ${date}`,
    `- content_version: ${CONTENT_VERSION}`,
    `- Source count: 8（题库 PDF）`,
    `- Questions processed: ${audit.questions.total}`,
    `- Podcast sentences processed: 0（Book 2-4 待 transcript）`,
    `- Demo answer sentences processed: ${audit.sentences.total}`,
    `- Generated candidate units（批次）: blueprint=${doneCounts("blueprint")}, topic_domains=${doneCounts("topic_domains")}, chunk_candidate=${doneCounts("chunk_candidate")}, dedup=${doneCounts("dedup")}, quality_review=${doneCounts("quality_review")}`,
    `- Final units: ${chunksRows.length}`,
    `- Merged duplicates（确定性+语义裁决）: 见 dedup 批次`,
    `- Rejected units: ${audit.chunks.rejected}`,
    `- No-new-unit sentences: ${audit.sentences.noNewUnit}`,
    `- Coverage status: ${audit.ok ? "PASS" : "见审计报告"}`,
    `- Uncovered questions: ${audit.uncoveredQuestions.length}`,
    `- Failed records（rejected 批次）: ${Object.entries(q).map(([k, v]) => `${k}:${v.rejected}`).join(", ")}`,
    `- Quality review failures: ${audit.chunks.rejected}`,
    "",
    `- 导出文件: pipeline/books/${BOOK_ID}.json`,
  ].join("\n");
  fs.writeFileSync(path.join(REPORTS, `compilation-report-book1.md`), md, "utf-8");

  console.log(`Book 1 编译完成: ${chunksRows.length} chunks → ${outFile}`);
  return { ok: true, audit };
}
