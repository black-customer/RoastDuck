import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@libsql/client";
import { ensureSchema } from "../db/migrate";

const databaseUrl = process.env.ROASTDUCK_DB ?? "file:./data/app.db";
const databaseFile = databaseUrl.startsWith("file:") ? path.resolve(databaseUrl.slice("file:".length).replace(/^\.\//, "")) : null;
const reportFile = path.resolve("pipeline/agent-work/personal-import/audits/quarantine-latest.json");
const blockedSegments = [
  "seg_8da0f2af3fd4bfe94514",
  "seg_124f5880fa1fae04c697",
  "seg_3228e788b4530af4f5c4",
  "seg_e3bbb4c74b99e7966cc9",
  "seg_b4ec85c31923d7673adf",
] as const;

function sha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

if (!databaseFile || !fs.existsSync(databaseFile)) throw new Error("隔离操作只支持已存在的本地 file: SQLite 数据库");
const backupDir = path.resolve("data/backups");
fs.mkdirSync(backupDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupFile = path.join(backupDir, `app.db.pre-personal-review-quarantine.${stamp}.bak`);
fs.copyFileSync(databaseFile, backupFile, fs.constants.COPYFILE_EXCL);
if (sha256(databaseFile) !== sha256(backupFile)) throw new Error("隔离前数据库备份哈希校验失败");

const client = createClient({ url: databaseUrl });
await ensureSchema(client);
const gapCountBefore = await client.execute("SELECT COUNT(*) AS count FROM answer_gaps g JOIN personal_answers a ON a.id=g.answer_id WHERE a.source_kind='historical_import'");
const unitCountBefore = await client.execute("SELECT COUNT(*) AS count FROM question_learning_units u JOIN answer_gaps g ON g.id=u.gap_id JOIN personal_answers a ON a.id=g.answer_id WHERE a.source_kind='historical_import' AND u.status='active'");
const historicalScenarioExamplePredicate = "EXISTS (SELECT 1 FROM learning_scenarios s JOIN answer_gaps g ON g.id=s.gap_id JOIN personal_answers a ON a.id=g.answer_id WHERE chunk_examples.source_ref='learning_scenario:' || s.id AND a.source_kind='historical_import')";
const derivedExamplesBefore = await client.execute(`SELECT COUNT(*) AS count FROM chunk_examples WHERE ${historicalScenarioExamplePredicate}`);
await client.batch([
  "UPDATE answer_gaps SET reviewer_decision='pending_review', reviewer_reason='旧规则自动批准已被独立 Reviewer 撤销；等待 v2 checkpoint。', reviewer_run_id='revoked_legacy_auto_review', status='needs_attention', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE answer_id IN (SELECT id FROM personal_answers WHERE source_kind='historical_import')",
  "UPDATE question_learning_units SET status='pending_review', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE gap_id IN (SELECT g.id FROM answer_gaps g JOIN personal_answers a ON a.id=g.answer_id WHERE a.source_kind='historical_import')",
  "UPDATE personal_chunk_links SET status='hidden' WHERE answer_id IN (SELECT id FROM personal_answers WHERE source_kind='historical_import')",
  "UPDATE learning_scenarios SET review_decision='pending', review_reason='旧自动审核已撤销；等待独立语境 Reviewer checkpoint。', reviewer_run_id=NULL, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE gap_id IN (SELECT g.id FROM answer_gaps g JOIN personal_answers a ON a.id=g.answer_id WHERE a.source_kind='historical_import')",
  "UPDATE learning_inbox_items SET status='dismissed', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE source_type='answer_gap' AND source_id IN (SELECT g.id FROM answer_gaps g JOIN personal_answers a ON a.id=g.answer_id WHERE a.source_kind='historical_import')",
  "UPDATE chunks SET quality_status='pending_review', review_provenance='unreviewed', reviewer_version=NULL, reviewed_at=NULL, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE book_id='book_personal_ielts_answers'",
  "UPDATE answer_imports SET status='needs_attention', checkpoint_json=json_set(checkpoint_json, '$.stage', 'independent_review_required'), updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')",
  `DELETE FROM chunk_examples WHERE ${historicalScenarioExamplePredicate}`,
], "write");
for (const segmentId of blockedSegments) {
  await client.execute({ sql: "UPDATE answer_import_segments SET status='needs_attention' WHERE id=?", args: [segmentId] });
  await client.execute({ sql: "UPDATE personal_answers SET status='needs_attention', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE source_segment_id=?", args: [segmentId] });
}
const activeUnitsAfter = await client.execute("SELECT COUNT(*) AS count FROM question_learning_units u JOIN answer_gaps g ON g.id=u.gap_id JOIN personal_answers a ON a.id=g.answer_id WHERE a.source_kind='historical_import' AND u.status='active'");
const report = {
  stage: "legacy_personal_review_quarantined",
  generatedAt: new Date().toISOString(),
  backup: { file: path.relative(process.cwd(), backupFile).replaceAll("\\", "/"), sha256: sha256(backupFile) },
  counts: {
    historicalGapsQuarantined: Number(gapCountBefore.rows[0]?.count ?? 0),
    activeLearningUnitsBefore: Number(unitCountBefore.rows[0]?.count ?? 0),
    activeLearningUnitsAfter: Number(activeUnitsAfter.rows[0]?.count ?? 0),
    blockedSegments: blockedSegments.length,
    derivedPersonalExamplesRemoved: Number(derivedExamplesBefore.rows[0]?.count ?? 0),
  },
  reviewerFinding: { approved: 39, edited: 13, rejected: 6, publishableNow: false },
  networkCalls: 0,
};
fs.mkdirSync(path.dirname(reportFile), { recursive: true });
fs.writeFileSync(reportFile, JSON.stringify(report, null, 2), "utf8");
console.log(JSON.stringify(report, null, 2));
client.close();
