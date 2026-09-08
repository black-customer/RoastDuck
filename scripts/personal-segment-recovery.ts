import fs from "node:fs";
import path from "node:path";
import { createClient } from "@libsql/client";
import { ensureSchema } from "../db/migrate";
import { sha256 } from "../src/lib/imports/personal-import";
import { compileSegmentRecovery, SegmentReviewSchema } from "../src/lib/imports/segment-recovery";
import { applySegmentRecovery } from "../src/lib/imports/apply-segment-recovery";

function privatePath(relative: string) {
  const root = path.resolve("data/imports/private");
  const file = path.resolve(relative);
  if (!file.startsWith(root + path.sep)) throw new Error("修订文件必须位于本机私人导入目录");
  const real = fs.realpathSync(file);
  if (!real.startsWith(fs.realpathSync(root) + path.sep)) throw new Error("修订文件不能通过链接越出私人目录");
  return file;
}
function writeImmutable(file: string, value: unknown) {
  const bytes = JSON.stringify(value, null, 2);
  if (fs.existsSync(file)) {
    if (fs.readFileSync(file, "utf8") !== bytes) throw new Error("已有检查点发生变化，禁止覆盖");
    return;
  }
  fs.writeFileSync(file, bytes, { encoding: "utf8", flag: "wx" });
}

export async function runSegmentRecovery(mode: "recover-prepare" | "recover-apply", reviewPath: string | undefined, inputPath: string | undefined) {
  if (!reviewPath || !inputPath) throw new Error("请提供私有审核文件与原输入快照路径");
  const reviewFile = privatePath(reviewPath), inputFile = privatePath(inputPath);
  const reviewBytes = fs.readFileSync(reviewFile), inputBytes = fs.readFileSync(inputFile);
  const review = SegmentReviewSchema.parse(JSON.parse(reviewBytes.toString("utf8")));
  const inputSnapshot = JSON.parse(inputBytes.toString("utf8")) as { cases?: Array<{ segment?: { id?: string } }> };
  if (review.inputSha256 !== sha256(inputBytes)) throw new Error("Reviewer 输入快照哈希不匹配");
  const expectedCases = new Set(inputSnapshot.cases?.map((c) => c.segment?.id));
  if (expectedCases.has(undefined) || expectedCases.size !== review.cases.length || review.cases.some((c) => !expectedCases.has(c.originalSegmentId))) throw new Error("审核 case 未完整覆盖输入任务");
  const dbUrl = process.env.ROASTDUCK_DB ?? "file:./data/app.db";
  if (!dbUrl.startsWith("file:")) throw new Error("开发期切分修复只允许本机数据库");
  const client = createClient({ url: dbUrl });
  try {
    // prepare 只读，不运行迁移；应用要求先执行 init。
    if (mode === "recover-apply") await ensureSchema(client, dbUrl);
    const questions = (await client.execute("SELECT id,part FROM questions")).rows.map((q) => ({ id: String(q.id), part: Number(q.part) }));
    const snapshots = review.sourceSnapshots.map((source) => {
      const sourceFile = privatePath(source.path);
      const workDir = path.dirname(sourceFile), importId = path.basename(path.dirname(workDir));
      const originalManifest = JSON.parse(fs.readFileSync(privatePath(path.join(workDir, "..", "private-manifest.json")), "utf8")) as { sourceSha256: string; privateOriginalPath: string };
      if (sha256(fs.readFileSync(privatePath(originalManifest.privateOriginalPath))) !== originalManifest.sourceSha256) throw new Error("原始文件哈希发生变化");
      return compileSegmentRecovery({
        importId, text: fs.readFileSync(sourceFile, "utf8"), sourcePath: source.path,
        baseSegments: JSON.parse(fs.readFileSync(privatePath(path.join(workDir, "segments.json")), "utf8")),
        review, inputSnapshotSha256: sha256(inputBytes), reviewSha256: sha256(reviewBytes), questions,
      });
    }).filter((s) => s !== null);
    if (snapshots.reduce((n, s) => n + review.cases.filter((c) => s.replacesSegmentIds.includes(c.originalSegmentId)).length, 0) !== review.cases.length) throw new Error("有审核 case 不属于任何源文件");
    for (const snapshot of snapshots) {
      writeImmutable(path.join(path.dirname(reviewFile), `${snapshot.id}.snapshot.json`), snapshot);
      const golden = snapshot.segments.filter((s) => s.reviewed).map((s) => ({
        id: s.id, startOffset: s.startOffset, endOffset: s.endOffset, type: s.type, questionId: s.questionId,
        answerGroupKey: s.answerGroupKey, rawText: s.rawText, sourceSha256: sha256(s.rawText), reviewer: snapshot.reviewer,
      }));
      writeImmutable(path.join(path.dirname(reviewFile), `${snapshot.id}.golden.json`), golden);
    }
    let backupPath: string | null = null;
    const applied = [];
    if (mode === "recover-apply") {
      // VACUUM INTO 提供一致性快照，不复制仍可能正在写入的 WAL 主文件。
      const databaseFile = path.resolve(dbUrl.slice(5));
      const backups = path.join(path.dirname(databaseFile), "backups");
      fs.mkdirSync(backups, { recursive: true });
      backupPath = path.join(backups, `app.db.segment-recovery.${Date.now()}.bak`);
      await client.execute({ sql: "VACUUM INTO ?", args: [backupPath] });
      if (!fs.statSync(backupPath).size) throw new Error("修订前备份为空");
      for (const snapshot of snapshots) applied.push(await applySegmentRecovery(client, snapshot));
    }
    const report = {
      version: "segment-recovery-report-v1", command: mode, inputSha256: sha256(inputBytes), reviewSha256: sha256(reviewBytes),
      reviewer: review.reviewer, networkCalls: 0, runtimeApiCalls: 0,
      backupPath: backupPath ? path.relative(process.cwd(), backupPath).replaceAll("\\", "/") : null,
      revisions: snapshots.map((s) => ({
        id: s.id, importId: s.importId, sourceSha256: s.sourceSha256, baseSegmentsSha256: s.baseSegmentsSha256,
        replacedSegments: s.replacesSegmentIds.length, reviewedPieces: s.segments.filter((p) => p.reviewed).length,
        answerGroups: s.attempts.length, classifiedCharacters: s.segments.reduce((n, p) => n + p.rawText.length, 0),
        unclassifiedPieces: s.segments.filter((p) => p.type === "unclassified").length,
        asrUncertainPieces: s.segments.filter((p) => p.type === "asr_uncertain").length,
      })), applied,
    };
    const evidenceDir = path.resolve("pipeline/agent-work/personal-import/recovery");
    fs.mkdirSync(evidenceDir, { recursive: true });
    writeImmutable(path.join(evidenceDir, `${mode}-${sha256(reviewBytes).slice(0, 16)}${mode === "recover-apply" ? `-${Date.now()}` : ""}.json`), report);
    console.log(JSON.stringify(report, null, 2));
  } finally { client.close(); }
}
