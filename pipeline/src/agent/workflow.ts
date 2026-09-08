import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { contentEnrichmentApply } from "../compiler/content_enrichment";
import { dedupPairsApply } from "../compiler/dedup";
import { pronunciationEnrichmentApply } from "../compiler/pronunciation_enrichment";
import { qualityApply } from "../compiler/quality_review";
import { runAudit } from "../compiler/audit";
import {
  contentEnrichmentBatchOutputSchema,
  dedupBatchOutputSchema,
  pronunciationEnrichmentBatchOutputSchema,
  qualityVerdictSchema,
} from "../lib/schemas";
import {
  listPendingBatches,
  QUEUE_DIR,
  writeBatch,
  type BatchFile,
} from "../lib/queue";
import {
  AGENT_REVIEW_MODEL,
  AGENT_REVIEW_PROVIDER,
  AGENT_WORKFLOW_VERSION,
  agentStageSchema,
  agentSubmissionSchema,
  packetManifestSchema,
  type AgentCheckpoint,
  type AgentStage,
  type AgentSubmission,
  type PacketManifest,
} from "./contracts";
import {
  agentWorkDir,
  batchInputHash,
  inputSnapshot,
  listCheckpoints,
  readCheckpoint,
  sha256,
  stableJson,
  writeCheckpoint,
} from "./evidence";

interface StageDefinition {
  role: "generator" | "reviewer";
  promptFile: string;
  schemaVersion: string;
  outputSchema: z.ZodType<unknown>;
  apply: (batchIds?: ReadonlySet<string>) => Promise<{ applied: number; rejected: number; pending: number }>;
  toQueueOutput: (output: unknown, submission: AgentSubmission) => unknown;
}

const qualityAgentOutputSchema = z.object({ verdicts: z.array(qualityVerdictSchema).min(1) });

const STAGES: Record<AgentStage, StageDefinition> = {
  dedup: {
    role: "reviewer",
    promptFile: "dedup.md",
    schemaVersion: "dedup.output.v1",
    outputSchema: dedupBatchOutputSchema,
    apply: dedupPairsApply,
    toQueueOutput: (output) => output,
  },
  content_enrichment: {
    role: "generator",
    promptFile: "content_enrichment.md",
    schemaVersion: "content-enrichment.output.v1",
    outputSchema: contentEnrichmentBatchOutputSchema,
    apply: contentEnrichmentApply,
    toQueueOutput: (output) => output,
  },
  pronunciation_enrichment: {
    role: "generator",
    promptFile: "pronunciation_enrichment.md",
    schemaVersion: "pronunciation-enrichment.output.v1",
    outputSchema: pronunciationEnrichmentBatchOutputSchema,
    apply: pronunciationEnrichmentApply,
    toQueueOutput: (output) => output,
  },
  quality_review: {
    role: "reviewer",
    promptFile: "quality_review.md",
    schemaVersion: "quality-review.output.v3",
    outputSchema: qualityAgentOutputSchema,
    apply: qualityApply,
    toQueueOutput: (output, submission) => ({
      reviewer: {
        role: "independent_reviewer",
        provider: AGENT_REVIEW_PROVIDER,
        model: AGENT_REVIEW_MODEL,
        runId: submission.runId,
      },
      verdicts: (output as z.infer<typeof qualityAgentOutputSchema>).verdicts,
    }),
  },
};

function promptPath(definition: StageDefinition): string {
  return path.resolve(process.cwd(), "pipeline/prompts", definition.promptFile);
}

function packetDir(stage: AgentStage, batchId: string): string {
  return path.join(agentWorkDir(), "packets", stage, batchId);
}

function queueFile(stage: AgentStage, bucket: "pending" | "done" | "rejected", batchId: string): string {
  return path.join(QUEUE_DIR, stage, bucket, `${batchId}.json`);
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function unitKeysOf(batch: BatchFile<unknown, unknown>): string[] {
  const keys = batch.inputs.map((input, index) => {
    if (!input || typeof input !== "object" || !("unitKey" in input)) {
      throw new Error(`${batch.batchId} inputs[${index}] 缺少 unitKey`);
    }
    const key = (input as { unitKey?: unknown }).unitKey;
    if (typeof key !== "string" || !key.trim()) throw new Error(`${batch.batchId} inputs[${index}].unitKey 无效`);
    return key;
  });
  return [...new Set(keys)];
}

function upstreamFor(unitKeys: string[]): PacketManifest["upstreamEvidence"] {
  const wanted = new Set(unitKeys);
  return listCheckpoints()
    .filter((checkpoint) => checkpoint.status === "applied" && checkpoint.role === "generator")
    .filter((checkpoint) => checkpoint.unitKeys.some((key) => wanted.has(key)))
    .map((checkpoint) => ({
      runId: checkpoint.runId,
      stage: checkpoint.stage,
      role: checkpoint.role,
      executorSessionId: checkpoint.executorSessionId,
      outputSha256: checkpoint.outputSha256,
      unitKeys: checkpoint.unitKeys.filter((key) => wanted.has(key)),
    }));
}

export function prepareAgentPackets(options: {
  stage: AgentStage;
  limit?: number;
  batchId?: string;
}): { prepared: string[]; skipped: string[] } {
  const stage = agentStageSchema.parse(options.stage);
  const definition = STAGES[stage];
  const prompt = fs.readFileSync(promptPath(definition), "utf8");
  const pending = listPendingBatches<unknown, unknown>(stage)
    .filter((batch) => batch.output == null)
    .filter((batch) => !options.batchId || batch.batchId === options.batchId)
    .slice(0, options.limit ?? 20);
  if (options.batchId && pending.length === 0) {
    throw new Error(`找不到未填的 pending 批次：${stage}/${options.batchId}`);
  }

  const prepared: string[] = [];
  const skipped: string[] = [];
  for (const batch of pending) {
    const dir = packetDir(stage, batch.batchId);
    const manifestFile = path.join(dir, "manifest.json");
    const snapshot = inputSnapshot(batch);
    const unitKeys = unitKeysOf(batch);
    const manifest: PacketManifest = {
      workflowVersion: AGENT_WORKFLOW_VERSION,
      batchId: batch.batchId,
      stage,
      role: definition.role,
      promptVersion: batch.promptVersion,
      schemaVersion: definition.schemaVersion,
      inputSha256: batchInputHash(batch),
      promptSha256: sha256(prompt),
      preparedAt: new Date().toISOString(),
      unitKeys,
      upstreamEvidence: upstreamFor(unitKeys),
    };

    if (fs.existsSync(manifestFile)) {
      const existing = packetManifestSchema.parse(readJson(manifestFile));
      if (existing.inputSha256 !== manifest.inputSha256 || existing.promptSha256 !== manifest.promptSha256) {
        throw new Error(`${stage}/${batch.batchId} 已准备过，但输入或 Prompt 已变化；请先保留旧包再显式清理`);
      }
      skipped.push(batch.batchId);
      continue;
    }

    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "input.snapshot.json"), `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    fs.writeFileSync(path.join(dir, "prompt.snapshot.md"), prompt, "utf8");
    fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    fs.writeFileSync(path.join(dir, "submission.template.json"), `${JSON.stringify({
      workflowVersion: AGENT_WORKFLOW_VERSION,
      batchId: batch.batchId,
      stage,
      role: definition.role,
      runId: "agent_run_REPLACE_ME",
      executor: { kind: "codex_agent", sessionId: "REPLACE_WITH_INDEPENDENT_AGENT_SESSION" },
      inputSha256: manifest.inputSha256,
      promptVersion: manifest.promptVersion,
      promptSha256: manifest.promptSha256,
      schemaVersion: manifest.schemaVersion,
      attestation: {
        noExternalRuntimeApi: true,
        independentContext: definition.role === "reviewer",
      },
      createdAt: new Date().toISOString(),
      output: {},
    }, null, 2)}\n`, "utf8");
    prepared.push(batch.batchId);
  }
  return { prepared, skipped };
}

export interface ValidatedSubmission {
  submission: AgentSubmission;
  manifest: PacketManifest;
  queueOutput: unknown;
  outputSha256: string;
  submissionFile: string;
}

export function validateAgentSubmission(submissionFile: string): ValidatedSubmission {
  const absolute = path.resolve(submissionFile);
  const submission = agentSubmissionSchema.parse(readJson(absolute));
  const definition = STAGES[submission.stage];
  const dir = path.dirname(absolute);
  const manifest = packetManifestSchema.parse(readJson(path.join(dir, "manifest.json")));
  const snapshot = readJson(path.join(dir, "input.snapshot.json")) as BatchFile<unknown, unknown>;
  const prompt = fs.readFileSync(path.join(dir, "prompt.snapshot.md"), "utf8");

  const comparisons: Array<[boolean, string]> = [
    [submission.batchId === manifest.batchId, "batchId 与 manifest 不一致"],
    [submission.stage === manifest.stage, "stage 与 manifest 不一致"],
    [submission.role === manifest.role && submission.role === definition.role, "role 与 stage 不一致"],
    [submission.inputSha256 === manifest.inputSha256, "inputSha256 与 manifest 不一致"],
    [batchInputHash(snapshot) === manifest.inputSha256, "input.snapshot.json 已被修改"],
    [submission.promptVersion === manifest.promptVersion, "promptVersion 与 manifest 不一致"],
    [submission.promptSha256 === manifest.promptSha256, "promptSha256 与 manifest 不一致"],
    [sha256(prompt) === manifest.promptSha256, "prompt.snapshot.md 已被修改"],
    [submission.schemaVersion === manifest.schemaVersion, "schemaVersion 与 manifest 不一致"],
    [manifest.schemaVersion === definition.schemaVersion, 'schemaVersion 已过期或未知'],
  ];
  for (const [ok, message] of comparisons) if (!ok) throw new Error(message);

  if (submission.stage === "quality_review") {
    if (!submission.attestation.independentContext) {
      throw new Error("quality_review 必须声明 independentContext=true");
    }
    const reused = manifest.upstreamEvidence.find(
      (evidence) => evidence.executorSessionId === submission.executor.sessionId,
    );
    if (reused) throw new Error(`Reviewer 与 Generator 复用了同一 Agent session：${reused.runId}`);
  }

  const parsedOutput = definition.outputSchema.safeParse(submission.output);
  if (!parsedOutput.success) {
    throw new Error(`output Schema 校验失败：${parsedOutput.error.issues
      .slice(0, 8)
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ")}`);
  }

  return {
    submission,
    manifest,
    queueOutput: definition.toQueueOutput(parsedOutput.data, submission),
    outputSha256: sha256(stableJson(parsedOutput.data)),
    submissionFile: absolute,
  };
}

function findBatch(stage: AgentStage, batchId: string): { batch: BatchFile<unknown, unknown>; bucket: "pending" | "done" | "rejected" } | null {
  for (const bucket of ["pending", "done", "rejected"] as const) {
    const file = queueFile(stage, bucket, batchId);
    if (fs.existsSync(file)) return { batch: readJson(file) as BatchFile<unknown, unknown>, bucket };
  }
  return null;
}

function checkpointFrom(validated: ValidatedSubmission, status: AgentCheckpoint["status"], reason = ""): AgentCheckpoint {
  const now = new Date().toISOString();
  return {
    workflowVersion: AGENT_WORKFLOW_VERSION,
    runId: validated.submission.runId,
    batchId: validated.submission.batchId,
    stage: validated.submission.stage,
    role: validated.submission.role,
    executorSessionId: validated.submission.executor.sessionId,
    inputSha256: validated.manifest.inputSha256,
    outputSha256: validated.outputSha256,
    promptVersion: validated.manifest.promptVersion,
    promptSha256: validated.manifest.promptSha256,
    schemaVersion: validated.manifest.schemaVersion,
    unitKeys: validated.manifest.unitKeys,
    upstreamRunIds: validated.manifest.upstreamEvidence.map((evidence) => evidence.runId),
    status,
    reason,
    createdAt: validated.submission.createdAt,
    updatedAt: now,
  };
}

export async function importAgentSubmission(submissionFile: string): Promise<AgentCheckpoint> {
  const validated = validateAgentSubmission(submissionFile);
  const existingCheckpoint = readCheckpoint(validated.submission.runId);
  if (existingCheckpoint) {
    if (
      existingCheckpoint.inputSha256 !== validated.manifest.inputSha256
      || existingCheckpoint.outputSha256 !== validated.outputSha256
      || existingCheckpoint.batchId !== validated.submission.batchId
    ) {
      throw new Error(`runId ${validated.submission.runId} 已用于不同产物，拒绝覆盖`);
    }
    if (existingCheckpoint.status === "applied") return existingCheckpoint;
  }

  const located = findBatch(validated.submission.stage, validated.submission.batchId);
  if (!located) throw new Error(`队列中找不到批次 ${validated.submission.stage}/${validated.submission.batchId}`);
  if (batchInputHash(located.batch) !== validated.manifest.inputSha256) {
    throw new Error("当前队列批次与 Agent 输入快照不一致，拒绝导入过期产物");
  }
  if (located.bucket === "done") {
    const doneHash = sha256(stableJson(located.batch.output));
    if (doneHash !== sha256(stableJson(validated.queueOutput))) {
      throw new Error("批次已完成，但队列 output 与本次提交不同");
    }
    const checkpoint = checkpointFrom(validated, "applied");
    writeCheckpoint(checkpoint);
    return checkpoint;
  }
  if (located.bucket === "rejected") throw new Error("批次已被拒绝，需由流水线生成新批次后再处理");
  if (located.batch.output != null && stableJson(located.batch.output) !== stableJson(validated.queueOutput)) {
    throw new Error("pending 批次已有不同 output，拒绝静默覆盖");
  }

  const validatedCheckpoint = checkpointFrom(validated, "validated");
  // 固定证据文件名，调用者的 submission 文件名不参与后续发布审计。
  fs.writeFileSync(path.join(path.dirname(validated.submissionFile), 'submission.accepted.json'), `${JSON.stringify(validated.submission, null, 2)}\n`, 'utf8');
  writeCheckpoint(validatedCheckpoint);
  writeBatch({ ...located.batch, output: validated.queueOutput, attempts: (located.batch.attempts ?? 0) + 1 });

  const result = await STAGES[validated.submission.stage].apply(new Set([validated.submission.batchId]));
  const after = findBatch(validated.submission.stage, validated.submission.batchId);
  if (result.applied === 1 && after?.bucket === "done") {
    const checkpoint = checkpointFrom(validated, "applied");
    writeCheckpoint(checkpoint);
    fs.writeFileSync(
      path.join(path.dirname(validated.submissionFile), "import.result.json"),
      `${JSON.stringify(checkpoint, null, 2)}\n`,
      "utf8",
    );
    return checkpoint;
  }

  const reasonFile = queueFile(validated.submission.stage, "rejected", validated.submission.batchId)
    .replace(/\.json$/, ".reason.txt");
  const reason = fs.existsSync(reasonFile)
    ? fs.readFileSync(reasonFile, "utf8").trim()
    : `确定性导入未完成（applied=${result.applied}, rejected=${result.rejected}）`;
  const rejected = checkpointFrom(validated, "rejected", reason);
  writeCheckpoint(rejected);
  throw new Error(reason);
}

export function agentWorkflowStatus() {
  const checkpoints = listCheckpoints();
  const byStatus = { validated: 0, applied: 0, rejected: 0 };
  for (const checkpoint of checkpoints) byStatus[checkpoint.status] += 1;
  return {
    workDir: agentWorkDir(),
    packets: (["dedup", "content_enrichment", "pronunciation_enrichment", "quality_review"] as AgentStage[])
      .map((stage) => ({ stage, pending: listPendingBatches(stage).filter((batch) => batch.output == null).length })),
    checkpoints: byStatus,
  };
}

export async function runAgentCoverageAudit() {
  const checkpoints = listCheckpoints();
  const appliedByRun = new Map(checkpoints.filter((item) => item.status === "applied").map((item) => [item.runId, item]));
  const reviewerCheckpoints = checkpoints.filter(
    (item) => item.status === "applied" && item.stage === "quality_review" && item.role === "reviewer",
  );
  const chainViolations: string[] = [];
  for (const reviewer of reviewerCheckpoints) {
    for (const upstreamRunId of reviewer.upstreamRunIds) {
      const generator = appliedByRun.get(upstreamRunId);
      if (!generator || generator.role !== "generator") {
        chainViolations.push(`${reviewer.runId} 的上游 ${upstreamRunId} 不是已应用 Generator`);
      } else if (generator.executorSessionId === reviewer.executorSessionId) {
        chainViolations.push(`${reviewer.runId} 与 Generator ${upstreamRunId} 复用了 Agent session`);
      }
    }
  }
  const coverage = await runAudit();
  const report = {
    workflowVersion: AGENT_WORKFLOW_VERSION,
    auditor: "deterministic_coverage_auditor",
    networkCalls: 0,
    checkedAt: new Date().toISOString(),
    evidence: {
      appliedGenerators: checkpoints.filter((item) => item.status === "applied" && item.role === "generator").length,
      appliedReviewers: reviewerCheckpoints.length,
      chainViolations,
    },
    publicationAudit: coverage,
    ok: chainViolations.length === 0 && coverage.ok,
  };
  const reportFile = process.env.ROASTDUCK_AGENT_AUDIT_REPORT
    ? path.resolve(process.env.ROASTDUCK_AGENT_AUDIT_REPORT)
    : path.resolve(process.cwd(), "pipeline/reports/agent-content-audit-latest.json");
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}
