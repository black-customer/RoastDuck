import fs from "node:fs";
import path from "node:path";
import { createClient, type InValue } from "@libsql/client";
import { ensureSchema } from "../db/migrate";
import { applyV3PilotMaterials, auditV3Pilot, verifyV3PilotSelection } from "../src/lib/imports/apply-v3-pilot";
import {
  V3_PILOT_VERSION,
  validateV3PilotArtifacts,
  v3PilotHash,
  v3PilotInputSchema,
  type V3PilotInput,
} from "../src/lib/imports/v3-pilot-material";

const privateRoot = path.resolve("data/imports/private");
const promptFiles = {
  generator: "v3_pilot_material.generator.v1",
  materialReviewer: "v3_pilot_material.reviewer.v1",
  scenarioReviewer: "v3_pilot_scenario.reviewer.v1",
} as const;

function prompts() {
  return Object.fromEntries(Object.entries(promptFiles).map(([key, version]) => [key, {
    version,
    sha256: v3PilotHash(fs.readFileSync(path.resolve(`pipeline/prompts/${version}.md`), "utf8")),
  }])) as V3PilotInput["prompts"];
}

function privateDirectory(value: string) {
  const directory = path.resolve(value);
  if (!directory.startsWith(privateRoot + path.sep)) throw new Error("V3 私人材料必须保存在 data/imports/private 下");
  let ancestor = directory;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const realRoot = fs.realpathSync(privateRoot);
  const realAncestor = fs.realpathSync(ancestor);
  if (realAncestor !== realRoot && !realAncestor.startsWith(realRoot + path.sep)) throw new Error("私人材料目录不能经链接越界");
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function readPrivate(directory: string, name: string) {
  const file = path.join(directory, name);
  const realFile = fs.realpathSync(file);
  if (!realFile.startsWith(fs.realpathSync(privateRoot) + path.sep)) throw new Error("私人材料文件越界");
  return fs.readFileSync(realFile, "utf8");
}

function immutable(file: string, value: unknown) {
  const text = JSON.stringify(value, null, 2);
  if (fs.existsSync(file)) {
    if (fs.readFileSync(file, "utf8") !== text) throw new Error("已有检查点不同，禁止覆盖；请新建 pilotId");
  } else {
    fs.writeFileSync(file, text, { encoding: "utf8", flag: "wx" });
  }
}

function usage(): never {
  throw new Error("用法：prepare <私有目录> <10个gapId> / validate <私有目录> / apply <私有目录> / audit / status");
}

async function main() {
  const [mode, directoryArg, ...gapIds] = process.argv.slice(2);
  if (!mode || !["prepare", "validate", "apply", "audit", "status"].includes(mode)) usage();
  if (["prepare", "validate", "apply"].includes(mode) && !directoryArg) usage();
  const dbUrl = process.env.ROASTDUCK_DB ?? "file:./data/app.db";
  if (!dbUrl.startsWith("file:")) throw new Error("离线 V3 编译只允许本机数据库");
  const client = createClient({ url: dbUrl });
  const query = (sql: string, args: InValue[] = []) => client.execute({ sql, args });

  try {
    if (mode === "status") {
      await ensureSchema(client, dbUrl);
      console.log(JSON.stringify({ ...(await auditV3Pilot(client, 10)), runtimeApiCalls: 0, networkCalls: 0 }, null, 2));
      return;
    }
    if (mode === "audit") {
      await ensureSchema(client, dbUrl);
      const result = await auditV3Pilot(client, 10);
      console.log(JSON.stringify({ ...result, runtimeApiCalls: 0, networkCalls: 0 }, null, 2));
      if (!result.ok) process.exitCode = 1;
      return;
    }

    const directory = privateDirectory(directoryArg!);
    if (mode === "prepare") {
      if (gapIds.length !== 10 || new Set(gapIds).size !== 10) throw new Error("V3 首批必须明确选择 10 个不重复 Gap");
      const placeholders = gapIds.map(() => "?").join(",");
      const rows = await query(
        `SELECT g.id AS gapId,g.answer_id AS answerId,g.answer_version_id AS answerVersionId,a.question_id AS questionId,
          g.gap_type AS gapType,g.cluster_id AS clusterId,g.evidence_text AS evidenceText,g.intent_zh AS intentZh,
          g.recommended_expression AS recommendedExpression,g.explanation_zh AS explanationZh,g.impact_level AS impactLevel,
          g.reviewer_run_id AS diagnosisReviewerRunId,e.batch_id AS batchId,b.review_sha256 AS sourceReviewSha256
        FROM answer_gaps g JOIN personal_answers a ON a.id=g.answer_id JOIN personal_gap_evidence e ON e.gap_id=g.id
        JOIN personal_diagnosis_batches b ON b.id=e.batch_id
        WHERE g.id IN (${placeholders}) AND g.learning_fit=1 AND g.reviewer_decision IN ('approved','edited')
          AND g.status IN ('open','learning') AND a.superseded_by_revision_id IS NULL`,
        gapIds,
      );
      if (rows.rows.length !== 10) throw new Error("部分 Gap 不存在、已失效或未通过诊断审核");
      const batchIds = new Set(rows.rows.map((row) => String(row.batchId)));
      const reviewHashes = new Set(rows.rows.map((row) => String(row.sourceReviewSha256)));
      if (batchIds.size !== 1 || reviewHashes.size !== 1) throw new Error("V3 首批只能来自同一个已审核诊断批次");
      const byId = new Map(rows.rows.map((row) => [String(row.gapId), row]));
      const input = v3PilotInputSchema.parse({
        schemaVersion: V3_PILOT_VERSION,
        pilotId: path.basename(directory),
        sourceBatchId: [...batchIds][0],
        sourceReviewSha256: [...reviewHashes][0],
        prompts: prompts(),
        selected: gapIds.map((gapId) => {
          const row = byId.get(gapId)!;
          return {
            gapId,
            answerId: String(row.answerId),
            answerVersionId: String(row.answerVersionId),
            questionId: String(row.questionId),
            gapType: String(row.gapType),
            clusterId: String(row.clusterId),
            evidenceSha256: v3PilotHash(String(row.evidenceText)),
            intentZh: String(row.intentZh),
            recommendedExpression: String(row.recommendedExpression),
            explanationZh: String(row.explanationZh),
            impactLevel: String(row.impactLevel),
            diagnosisReviewerRunId: String(row.diagnosisReviewerRunId),
          };
        }),
      });
      await verifyV3PilotSelection(client, input);
      immutable(path.join(directory, "input.json"), input);
      console.log(JSON.stringify({ prepared: input.pilotId, selected: 10, inputSha256: v3PilotHash(readPrivate(directory, "input.json")), runtimeApiCalls: 0, networkCalls: 0 }, null, 2));
      return;
    }

    const inputText = readPrivate(directory, "input.json");
    const generationText = readPrivate(directory, "material-generation.json");
    const materialReviewText = readPrivate(directory, "material-review.json");
    const scenarioReviewText = readPrivate(directory, "scenario-review.json");
    const artifacts = validateV3PilotArtifacts(inputText, generationText, materialReviewText, scenarioReviewText);
    if (JSON.stringify(artifacts.input.prompts) !== JSON.stringify(prompts())) throw new Error("V3 Prompt 已变化，必须基于新版本重新编译");
    await verifyV3PilotSelection(client, artifacts.input);

    let backupPath: string | null = null;
    let published: Awaited<ReturnType<typeof applyV3PilotMaterials>> = [];
    if (mode === "apply") {
      await ensureSchema(client, dbUrl);
      if (process.env.ROASTDUCK_SKIP_DB_BACKUP !== "1") {
        const dbFile = path.resolve(dbUrl.slice(5));
        const backupDirectory = path.join(path.dirname(dbFile), "backups");
        fs.mkdirSync(backupDirectory, { recursive: true });
        backupPath = path.join(backupDirectory, `app.db.v3-pilot.${Date.now()}.bak`);
        await query("VACUUM INTO ?", [backupPath]);
        if (!fs.statSync(backupPath).size) throw new Error("V3 发布前数据库备份为空");
      }
      published = await applyV3PilotMaterials(client, artifacts.input, artifacts.finalMaterials, {
        generationSha256: artifacts.generationSha256,
        materialReviewSha256: artifacts.materialReviewSha256,
        scenarioReviewSha256: artifacts.scenarioReviewSha256,
        generatorRunId: artifacts.generation.runId,
        materialReviewerRunId: artifacts.materialReview.runId,
        scenarioReviewerRunId: artifacts.scenarioReview.runId,
      });
      const audit = await auditV3Pilot(client, 10);
      if (!audit.ok) throw new Error("V3 发布后审计失败");
    }

    const report = {
      schemaVersion: V3_PILOT_VERSION,
      mode,
      pilotId: artifacts.input.pilotId,
      inputSha256: artifacts.inputSha256,
      generationSha256: artifacts.generationSha256,
      materialReviewSha256: artifacts.materialReviewSha256,
      scenarioReviewSha256: artifacts.scenarioReviewSha256,
      selected: artifacts.input.selected.length,
      publishable: artifacts.finalMaterials.length,
      published: published.map((item) => ({ gapId: item.gapId, chunkId: item.chunkId, questionId: item.questionId })),
      generator: { runId: artifacts.generation.runId, sessionId: artifacts.generation.sessionId },
      materialReviewer: { runId: artifacts.materialReview.runId, sessionId: artifacts.materialReview.sessionId },
      scenarioReviewer: { runId: artifacts.scenarioReview.runId, sessionId: artifacts.scenarioReview.sessionId },
      backupPath: backupPath ? path.relative(process.cwd(), backupPath).replaceAll("\\", "/") : null,
      runtimeApiCalls: 0,
      networkCalls: 0,
    };
    const reportDirectory = path.resolve("pipeline/agent-work/personal-import/v3-pilot");
    fs.mkdirSync(reportDirectory, { recursive: true });
    immutable(path.join(reportDirectory, `${mode}-${artifacts.scenarioReviewSha256.slice(0, 16)}${mode === "apply" ? `-${Date.now()}` : ""}.json`), report);
    console.log(JSON.stringify(report, null, 2));
  } finally {
    client.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error && !["ZodError", "LibsqlError"].includes(error.name) ? error.message : "V3 私人材料校验或发布失败；为保护隐私不输出原文及 SQL 参数");
  process.exitCode = 1;
});
