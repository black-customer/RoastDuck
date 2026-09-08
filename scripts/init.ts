import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@libsql/client";
import { ensureSchema } from "../db/migrate";

const dbUrl = process.env.ROASTDUCK_DB ?? "file:./data/app.db";
const root = process.cwd();

function runGit(args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", shell: false });
  if (result.status !== 0) return "unavailable";
  return result.stdout.trim();
}

function localDbPath(url: string): string | null {
  if (!url.startsWith("file:")) return null;
  return path.resolve(root, url.slice("file:".length).split("?")[0]);
}

function sha256File(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

async function scalar(client: ReturnType<typeof createClient>, sql: string): Promise<number> {
  const result = await client.execute(sql);
  return Number(result.rows[0]?.value ?? 0);
}

async function main() {
  const databasePath = localDbPath(dbUrl);
  // Fresh public clones intentionally contain no data directory or private database.
  if(databasePath)fs.mkdirSync(path.dirname(databasePath),{recursive:true});
  const client = createClient({ url: dbUrl });
  let initBackup: string | null = null;

  if (databasePath && fs.existsSync(databasePath) && fs.statSync(databasePath).size > 0) {
    await client.execute("PRAGMA wal_checkpoint(FULL)");
    const backupDir = path.join(path.dirname(databasePath), "backups");
    fs.mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    initBackup = path.join(backupDir, `app.db.init.${stamp}.bak`);
    fs.copyFileSync(databasePath, initBackup);
    if (sha256File(databasePath) !== sha256File(initBackup)) {
      throw new Error("init 备份哈希校验失败，已停止迁移");
    }
  }

  await ensureSchema(client, dbUrl);

  const tables = {
    schemaMigrations: await scalar(client, "SELECT COUNT(*) AS value FROM _schema_migrations"),
    books: await scalar(client, "SELECT COUNT(*) AS value FROM books"),
    topics: await scalar(client, "SELECT COUNT(*) AS value FROM topics"),
    questions: await scalar(client, "SELECT COUNT(*) AS value FROM questions"),
    chunks: await scalar(client, "SELECT COUNT(*) AS value FROM chunks"),
    personalAnswers: await scalar(client, "SELECT COUNT(*) AS value FROM personal_answers"),
    answerImports: await scalar(client, "SELECT COUNT(*) AS value FROM answer_imports"),
    answerGaps: await scalar(client, "SELECT COUNT(*) AS value FROM answer_gaps"),
    learningScenarios: await scalar(client, "SELECT COUNT(*) AS value FROM learning_scenarios"),
    speakingMessages: await scalar(client, "SELECT COUNT(*) AS value FROM speaking_messages"),
    speakingQuestionAttempts: await scalar(client, "SELECT COUNT(*) AS value FROM speaking_question_attempts"),
    learningItems: await scalar(client, "SELECT COUNT(*) AS value FROM learning_items"),
    gapEvents: await scalar(client, "SELECT COUNT(*) AS value FROM gap_events"),
    freeTalkConversations: await scalar(client, "SELECT COUNT(*) AS value FROM free_talk_conversations"),
    freeTalkMessages: await scalar(client, "SELECT COUNT(*) AS value FROM free_talk_messages"),
  };

  const stableIdAudit = {
    duplicateChunkIds: await scalar(client, "SELECT COUNT(*) AS value FROM (SELECT id FROM chunks GROUP BY id HAVING COUNT(*) > 1)"),
    duplicateQuestionIds: await scalar(client, "SELECT COUNT(*) AS value FROM (SELECT id FROM questions GROUP BY id HAVING COUNT(*) > 1)"),
    duplicateAnswerIds: await scalar(client, "SELECT COUNT(*) AS value FROM (SELECT id FROM personal_answers GROUP BY id HAVING COUNT(*) > 1)"),
    orphanProgress: await scalar(client, "SELECT COUNT(*) AS value FROM learning_progress p LEFT JOIN chunks c ON c.id = p.chunk_id WHERE c.id IS NULL"),
    orphanAnswers: await scalar(client, "SELECT COUNT(*) AS value FROM personal_answers a LEFT JOIN questions q ON q.id = a.question_id WHERE q.id IS NULL"),
  };

  const report = {
    version: "init-v1",
    createdAt: new Date().toISOString(),
    networkCalls: 0,
    dbUrl: databasePath ? "file:<local>" : "remote-or-memory",
    backupPath: initBackup ? path.relative(root, initBackup).replaceAll("\\", "/") : null,
    git: {
      branch: runGit(["branch", "--show-current"]),
      commit: runGit(["rev-parse", "HEAD"]),
      dirtyFiles: runGit(["status", "--short"]).split(/\r?\n/).filter(Boolean),
    },
    tables,
    stableIdAudit,
  };

  const reportDir = path.join(root, "data", "init");
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(path.join(reportDir, "latest.json"), JSON.stringify(report, null, 2), "utf8");

  console.log(JSON.stringify(report, null, 2));
  const failures = Object.entries(stableIdAudit).filter(([, value]) => value !== 0);
  if (failures.length) {
    throw new Error(`稳定 ID 审计失败：${failures.map(([key, value]) => `${key}=${value}`).join(", ")}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
