import fs from "node:fs";
import path from "node:path";
import { createClient, type InValue } from "@libsql/client";
import { ensureSchema } from "../db/migrate";
import { GAP_BATCH_VERSION, gapBatchInputSchema, gapHash, validateGapBatch, type GapBatchInput } from "../src/lib/imports/personal-gap-batch";
import { applyPersonalGapBatch, verifyGapAnswerSnapshot } from "../src/lib/imports/apply-personal-gap-batch";

const root = path.resolve("data/imports/private");
const prompt = (role: "generator" | "reviewer") => {
  const version = `personal_gap.${role}.v1`;
  return { version, sha256: gapHash(fs.readFileSync(path.resolve(`pipeline/prompts/${version}.md`), "utf8")) };
};
function immutable(file: string, value: unknown) {
  const bytes = JSON.stringify(value, null, 2);
  if (fs.existsSync(file)) {
    if (fs.readFileSync(file, "utf8") !== bytes) throw new Error("已有产物不同，禁止覆盖；请保留旧版并使用新的检查点");
  } else fs.writeFileSync(file, bytes, { encoding: "utf8", flag: "wx" });
}
function privateDirectory(value: string) {
  const dir = path.resolve(value);
  if (!dir.startsWith(root + path.sep)) throw new Error("产物必须保存在 data/imports/private 下");
  let ancestor = dir;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const realRoot = fs.realpathSync(root), realAncestor = fs.realpathSync(ancestor);
  if (realAncestor !== realRoot && !realAncestor.startsWith(realRoot + path.sep)) throw new Error("私人路径不能经链接越界");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function readPrivate(dir: string, name: string) {
  const file = path.join(dir, name);
  if (!fs.realpathSync(file).startsWith(fs.realpathSync(root) + path.sep)) throw new Error("产物链接越出私人目录");
  return fs.readFileSync(file, "utf8");
}

async function main() {
  const [mode, directory, ...answerIds] = process.argv.slice(2);
  if (!["prepare", "validate", "apply", "status"].includes(mode) || (mode !== "status" && !directory)) throw new Error("用法：prepare <私有目录> <answerId...> / validate <私有目录> / apply <私有目录> / status");
  const dbUrl = process.env.ROASTDUCK_DB ?? "file:./data/app.db";
  if (!dbUrl.startsWith("file:")) throw new Error("离线诊断只能使用本机数据库");
  const client = createClient({ url: dbUrl });
  const query = (sql: string, args: InValue[] = []) => client.execute({ sql, args });
  try {
    if (mode === "status") {
      const rows = (await query(`SELECT b.id,b.input_sha256,b.review_sha256,b.created_at,COUNT(e.gap_id) AS gaps,COUNT(DISTINCT e.answer_id) AS answers_with_gaps
        FROM personal_diagnosis_batches b LEFT JOIN personal_gap_evidence e ON e.batch_id=b.id GROUP BY b.id ORDER BY b.created_at`)).rows;
      console.log(JSON.stringify({ batches: rows, runtimeApiCalls: 0, publishedByThisCommand: 0 }, null, 2));
      return;
    }
    const dir = privateDirectory(directory);
    if (mode === "prepare") {
      if (!answerIds.length || answerIds.length > 10 || new Set(answerIds).size !== answerIds.length) throw new Error("每批需要 1–10 个不重复的回答 ID");
      const answers: GapBatchInput["answers"] = [];
      for (const answerId of answerIds) {
        const a = (await query(`SELECT a.*,v.text_en,v.text_zh,q.text AS question_en,q.text_zh AS question_zh,q.part FROM personal_answers a
          JOIN answer_versions v ON v.id=a.current_version_id AND v.answer_id=a.id JOIN questions q ON q.id=a.question_id WHERE a.id=?`, [answerId])).rows[0];
        if (!a || a.superseded_by_revision_id || a.source_kind !== "historical_import") throw new Error("回答无效/已归档/非历史回答");
        const rawText = String(a.raw_text);
        const revisionId = a.source_revision_id ? String(a.source_revision_id) : null;
        let startOffset: number, textSha256: string;
        if (revisionId) {
          const revision = (await query("SELECT snapshot_json FROM answer_import_revisions WHERE id=?", [revisionId])).rows[0];
          const snapshot = JSON.parse(String(revision.snapshot_json)) as { segments: Array<{ rawText: string }>; attempts: Array<{ id: string; startOffset: number }> };
          const attempt = snapshot.attempts.find((a) => a.id === answerId);
          if (!attempt) throw new Error("回答缺少修订来源");
          startOffset = attempt.startOffset;
          textSha256 = gapHash(snapshot.segments.map((s) => s.rawText).join(""));
        } else {
          const segment = (await query("SELECT raw_text,start_offset FROM answer_import_segments WHERE id=? AND import_id=?", [String(a.source_segment_id), String(a.import_id)])).rows[0];
          if (!segment) throw new Error("回答缺少原片段");
          const text = String(segment.raw_text), relative = text.indexOf(rawText);
          if (relative < 0 || relative !== text.lastIndexOf(rawText)) throw new Error("原文无法唯一定位；先做切分修订");
          startOffset = Number(segment.start_offset) + relative;
          textSha256 = gapHash(text);
        }
        const answer = gapBatchInputSchema.shape.answers.element.parse({
          answerId, answerVersionId: a.current_version_id, questionId: a.question_id,
          question: { textEn: a.question_en, textZh: a.question_zh, part: Number(a.part) },
          rawText, rawSha256: gapHash(rawText), normalizedText: [String(a.text_en), String(a.text_zh)].filter(Boolean).join("\n"),
          versionSha256: gapHash(JSON.stringify([String(a.text_en), String(a.text_zh)])),
          source: { importId: a.import_id, revisionId, segmentId: a.source_segment_id, startOffset, endOffset: startOffset + rawText.length, textSha256 },
        });
        await verifyGapAnswerSnapshot(query, answer);
        answers.push(answer);
      }
      const input = gapBatchInputSchema.parse({ schemaVersion: GAP_BATCH_VERSION, batchId: path.basename(dir), prompts: { generator: prompt("generator"), reviewer: prompt("reviewer") }, answers });
      immutable(path.join(dir, "input.json"), input);
      console.log(JSON.stringify({ prepared: input.batchId, answers: answers.length, characters: answers.reduce((n, a) => n + a.rawText.length, 0), inputSha256: gapHash(readPrivate(dir, "input.json")), runtimeApiCalls: 0 }, null, 2));
      return;
    }
    const inputText = readPrivate(dir, "input.json"), generationText = readPrivate(dir, "generation.json"), reviewText = readPrivate(dir, "review.json");
    const batch = validateGapBatch(JSON.parse(inputText), generationText, reviewText, inputText);
    if (JSON.stringify(batch.input.prompts) !== JSON.stringify({ generator: prompt("generator"), reviewer: prompt("reviewer") })) throw new Error("Prompt 已更改，请以新版重新生成审核");
    for (const answer of batch.input.answers) await verifyGapAnswerSnapshot(query, answer);
    let backupPath: string | null = null;
    let result: Awaited<ReturnType<typeof applyPersonalGapBatch>> | null = null;
    const integrity = async () => {
      const snapshot: Record<string, { rows: number; sha256: string }> = {};
      for (const [table, order] of [["personal_answers", "id"], ["answer_versions", "id"], ["learning_progress", "chunk_id"], ["chunks", "id"], ["ai_runs", "run_id"]]) {
        const rows = (await query(`SELECT * FROM ${table} ORDER BY ${order}`)).rows;
        snapshot[table] = { rows: rows.length, sha256: gapHash(JSON.stringify(rows)) };
      }
      return snapshot;
    };
    let preservation: { before: Awaited<ReturnType<typeof integrity>>; after: Awaited<ReturnType<typeof integrity>>; unchanged: boolean } | null = null;
    if (mode === "apply") {
      await ensureSchema(client, dbUrl);
      const backupDir = path.resolve(path.dirname(dbUrl.slice(5)), "backups");
      fs.mkdirSync(backupDir, { recursive: true });
      backupPath = path.join(backupDir, `app.db.personal-gaps.${Date.now()}.bak`);
      await query("VACUUM INTO ?", [backupPath]);
      if (!fs.statSync(backupPath).size) throw new Error("应用前备份为空");
      const before = await integrity();
      result = await applyPersonalGapBatch(client, batch);
      const after = await integrity();
      preservation = { before, after, unchanged: JSON.stringify(before) === JSON.stringify(after) };
    }
    const items = batch.review.answers.flatMap((a) => a.items);
    const report = {
      schemaVersion: GAP_BATCH_VERSION, mode, batchId: batch.input.batchId, inputSha256: batch.inputSha256,
      generationSha256: batch.generationSha256, reviewSha256: batch.reviewSha256,
      generator: { runId: batch.generated.runId, sessionId: batch.generated.sessionId, prompt: batch.input.prompts.generator },
      reviewer: { runId: batch.review.runId, sessionId: batch.review.sessionId, prompt: batch.input.prompts.reviewer },
      answers: batch.input.answers.length, characters: batch.input.answers.reduce((n, a) => n + a.rawText.length, 0),
      verdicts: { approved: items.filter((i) => i.verdict === "approved").length, edited: items.filter((i) => i.verdict === "edited").length, rejected: items.filter((i) => i.verdict === "rejected").length },
      learningCandidates: items.filter((i) => i.verdict !== "rejected" && i.candidate.gap.learningFit).length,
      runtimeApiCalls: 0, networkCalls: 0, publicationStatus: "diagnosis_only", result, preservation,
      backupPath: backupPath ? path.relative(process.cwd(), backupPath).replaceAll("\\", "/") : null,
    };
    const evidenceDir = path.resolve("pipeline/agent-work/personal-import/diagnosis");
    fs.mkdirSync(evidenceDir, { recursive: true });
    immutable(path.join(evidenceDir, `${mode}-${batch.reviewSha256.slice(0, 16)}${mode === "apply" ? `-${Date.now()}` : ""}.json`), report);
    console.log(JSON.stringify(report, null, 2));
  } finally { client.close(); }
}
main().catch((error) => {
  // 不打印 Zod input / SQL args，避免将私人正文混入公开日志。
  console.error(error instanceof Error && !["ZodError", "LibsqlError"].includes(error.name) ? error.message : "结构校验或数据库应用失败；请在私有目录检查，不输出原文/SQL 参数");
  process.exitCode = 1;
});
