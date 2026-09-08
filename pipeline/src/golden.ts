/**
 * Golden Set 回归：验证题目蓝图、Chunk 覆盖和逐句处理证据。
 * 该命令只读取数据库，不会修改真实内容或学习进度。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { getDbReady } from "../../db/client";
import { CONTENT_VERSION } from "./compiler/chunk_candidate";

const questionGoldenSchema = z.object({
  questions: z.array(z.object({
    questionId: z.string(),
    textEn: z.string(),
    note: z.string().optional(),
    expected: z.object({
      minDimensions: z.number().int().min(0),
      requiredDimensionHints: z.array(z.string()),
      minChunks: z.number().int().min(0),
      mustIncludeChunks: z.array(z.string()),
    }),
  })),
});

const sentenceGoldenSchema = z.object({
  sentences: z.array(z.object({
    sentenceId: z.string(),
    textEn: z.string(),
    expected: z.object({
      noNewUnit: z.boolean(),
      noNewUnitReasonHint: z.string().optional(),
      mustIncludeChunks: z.array(z.string()).optional(),
      minChunks: z.number().int().min(0).optional(),
      notes: z.string().optional(),
    }),
  })),
});

export interface GoldenFailure {
  kind: "question" | "sentence";
  id: string;
  message: string;
}

export interface GoldenReport {
  ok: boolean;
  checkedQuestions: number;
  checkedSentences: number;
  failures: GoldenFailure[];
}

function readGolden<T>(name: string, schema: z.ZodType<T>): T {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const value = JSON.parse(fs.readFileSync(path.join(here, "../golden", name), "utf8"));
  return schema.parse(value);
}

function normalize(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/[^a-z0-9'\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function chunkIsPresent(actual: string[], expected: string): boolean {
  const needle = normalize(expected);
  return actual.some((item) => {
    const candidate = normalize(item);
    return candidate.includes(needle) || needle.includes(candidate);
  });
}

function parseArray(value: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function runGolden(): Promise<GoldenReport> {
  const questionGolden = readGolden("questions.json", questionGoldenSchema);
  const sentenceGolden = readGolden("sentences.json", sentenceGoldenSchema);
  const db = await getDbReady();
  const book1 = await db.all<{ id: string }>(sql`SELECT id FROM books WHERE id = 'book1_ielts_complete' LIMIT 1`);
  if (!book1.length) {
    console.log("公共 Book 1 已清退，跳过已下线词书的 Golden 回归。");
    return {
      ok: true,
      checkedQuestions: 0,
      checkedSentences: 0,
      failures: [],
    };
  }
  const failures: GoldenFailure[] = [];

  for (const item of questionGolden.questions) {
    const rows = await db.all<{ id: string; text: string; blueprintJson: string }>(sql`
      SELECT id, text, blueprint_json AS blueprintJson
      FROM questions
      WHERE id = ${item.questionId} OR norm_text = ${normalize(item.textEn)}
      ORDER BY CASE WHEN id = ${item.questionId} THEN 0 ELSE 1 END
      LIMIT 1`);
    const question = rows[0];
    if (!question) {
      failures.push({ kind: "question", id: item.questionId, message: "Golden 题目不存在" });
      continue;
    }

    const dimensions = parseArray(question.blueprintJson);
    const blueprintText = JSON.stringify(dimensions).toLowerCase();
    if (dimensions.length < item.expected.minDimensions) {
      failures.push({ kind: "question", id: item.questionId, message: `Answer Dimension ${dimensions.length}/${item.expected.minDimensions}` });
    }
    const missingHints = item.expected.requiredDimensionHints.filter((hint) => !blueprintText.includes(hint.toLowerCase()));
    if (missingHints.length) {
      failures.push({ kind: "question", id: item.questionId, message: `蓝图缺少提示词：${missingHints.join("、")}` });
    }

    const chunks = await db.all<{ canonical: string }>(sql`
      SELECT DISTINCT c.canonical_chunk AS canonical
      FROM chunks c
      WHERE c.id IN (
        SELECT chunk_id FROM chunk_question_links WHERE question_id = ${question.id}
        UNION
        SELECT chunk_id FROM chunk_coverage_refs WHERE question_id = ${question.id}
      )`);
    const canonicals = chunks.map((chunk) => chunk.canonical);
    if (canonicals.length < item.expected.minChunks) {
      failures.push({ kind: "question", id: item.questionId, message: `关联 Chunk ${canonicals.length}/${item.expected.minChunks}` });
    }
    const missingChunks = item.expected.mustIncludeChunks.filter((expected) => !chunkIsPresent(canonicals, expected));
    if (missingChunks.length) {
      failures.push({ kind: "question", id: item.questionId, message: `缺少必含 Chunk：${missingChunks.join("、")}` });
    }
  }

  for (const item of sentenceGolden.sentences) {
    const rows = await db.all<{
      id: string;
      status: string;
      noNewUnitReason: string | null;
      coveredByJson: string;
    }>(sql`
      SELECT id, status, no_new_unit_reason AS noNewUnitReason, covered_by_json AS coveredByJson
      FROM source_sentences
      WHERE id = ${item.sentenceId} OR text = ${item.textEn}
      ORDER BY CASE WHEN id = ${item.sentenceId} THEN 0 ELSE 1 END
      LIMIT 1`);
    const sentence = rows[0];
    if (!sentence) {
      failures.push({ kind: "sentence", id: item.sentenceId, message: "Golden 原句不存在" });
      continue;
    }

    if (item.expected.noNewUnit) {
      if (sentence.status !== "no_new_unit") {
        failures.push({ kind: "sentence", id: item.sentenceId, message: `期望 no_new_unit，实际 ${sentence.status}` });
      }
      const reasonHint = item.expected.noNewUnitReasonHint?.toLowerCase();
      if (reasonHint && !(sentence.noNewUnitReason ?? "").toLowerCase().includes(reasonHint)) {
        failures.push({ kind: "sentence", id: item.sentenceId, message: `no_new_unit 理由缺少 ${reasonHint}` });
      }
      continue;
    }

    if (!new Set(["chunked", "covered"]).has(sentence.status)) {
      failures.push({ kind: "sentence", id: item.sentenceId, message: `原句仍未覆盖：${sentence.status}` });
    }
    const coveredIds = parseArray(sentence.coveredByJson).filter((value): value is string => typeof value === "string");
    const chunks = await db.all<{ canonical: string }>(sql`
      SELECT DISTINCT c.canonical_chunk AS canonical
      FROM chunks c
      WHERE c.id IN (${sql.join(coveredIds.map((id) => sql`${id}`), sql`, `)})
         OR c.id IN (SELECT chunk_id FROM chunk_sources WHERE sentence_id = ${sentence.id})`);
    const canonicals = chunks.map((chunk) => chunk.canonical);
    const minimum = item.expected.minChunks ?? 1;
    if (canonicals.length < minimum) {
      failures.push({ kind: "sentence", id: item.sentenceId, message: `覆盖 Chunk ${canonicals.length}/${minimum}` });
    }
    const expectedChunks = item.expected.mustIncludeChunks ?? [];
    const hits = expectedChunks.filter((expected) => chunkIsPresent(canonicals, expected)).length;
    if (expectedChunks.length && hits / expectedChunks.length < 0.6) {
      const missing = expectedChunks.filter((expected) => !chunkIsPresent(canonicals, expected));
      failures.push({ kind: "sentence", id: item.sentenceId, message: `必含 Chunk 命中 ${hits}/${expectedChunks.length}，缺少：${missing.join("、")}` });
    }
  }

  return {
    ok: failures.length === 0,
    checkedQuestions: questionGolden.questions.length,
    checkedSentences: sentenceGolden.sentences.length,
    failures,
  };
}

async function main() {
  const report = await runGolden();
  const reportsDirectory = process.env.ROASTDUCK_REPORTS_DIR
    ? path.resolve(process.env.ROASTDUCK_REPORTS_DIR)
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../reports");
  fs.mkdirSync(reportsDirectory, { recursive: true });
  fs.writeFileSync(path.join(reportsDirectory, "golden-latest.json"), JSON.stringify({
    ...report,
    contentVersion: CONTENT_VERSION,
    checkedAt: new Date().toISOString(),
  }, null, 1), "utf8");
  console.log(`Golden 回归：题目 ${report.checkedQuestions}，原句 ${report.checkedSentences}，失败 ${report.failures.length}`);
  for (const failure of report.failures) console.error(`- [${failure.kind}] ${failure.id}: ${failure.message}`);
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
