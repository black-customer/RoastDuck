import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { QUEUE_DIR, type BatchFile } from "../lib/queue";
import {
  AGENT_REVIEW_MODEL,
  AGENT_REVIEW_PROVIDER,
  agentCheckpointSchema,
  agentSubmissionSchema,
  packetManifestSchema,
  type AgentCheckpoint,
} from "./contracts";

export function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/**
 * 去掉 output 后的输入快照。放在 evidence 而非 workflow，
 * 是为了让编译器（quality_review）能引用哈希而不产生 compiler↔workflow 循环依赖。
 */
export function inputSnapshot(batch: BatchFile<unknown, unknown>): BatchFile<unknown, unknown> {
  return { ...batch, output: null, attempts: 0 };
}

export function batchInputHash(batch: BatchFile<unknown, unknown>): string {
  return sha256(stableJson(inputSnapshot(batch)));
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

export function agentWorkDir(): string {
  return process.env.ROASTDUCK_AGENT_WORK_DIR
    ? path.resolve(process.env.ROASTDUCK_AGENT_WORK_DIR)
    : path.resolve(process.cwd(), "pipeline/agent-work");
}

export function checkpointPath(runId: string): string {
  if (!/^agent_run_[A-Za-z0-9._-]{4,120}$/.test(runId)) throw new Error('非法 Agent runId');
  return path.join(agentWorkDir(), "checkpoints", `${runId}.json`);
}

export function writeCheckpoint(checkpoint: AgentCheckpoint): void {
  const parsed = agentCheckpointSchema.parse(checkpoint);
  const file = checkpointPath(parsed.runId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
}

export function readCheckpoint(runId: string): AgentCheckpoint | null {
  const file = checkpointPath(runId);
  if (!fs.existsSync(file)) return null;
  return agentCheckpointSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
}

export function listCheckpoints(): AgentCheckpoint[] {
  const dir = path.join(agentWorkDir(), "checkpoints");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => agentCheckpointSchema.parse(JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"))))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * quality_review 的离线 Agent 证据验证。这里不冒充 DeepSeek ai_runs：
 * Runtime Provider 与开发期 Codex Agent 是两种明确分开的来源。
 */
export function verifyAgentReviewerEvidence(input: {
  runId: string;
  batchId: string;
  inputSha256: string;
  provider: string;
  model: string;
}): string | null {
  if (input.provider !== AGENT_REVIEW_PROVIDER || input.model !== AGENT_REVIEW_MODEL) {
    return "离线 Reviewer 的 provider/model 标识不正确";
  }
  let checkpoint: AgentCheckpoint | null;
  try { checkpoint = verifyArtifact(input.runId); }
  catch (error) { return `Reviewer 证据失效：${error instanceof Error ? error.message : '无法读取'}`; }
  if (!checkpoint) return `找不到离线 Reviewer checkpoint：${input.runId}`;
  if (checkpoint.status !== "validated" && checkpoint.status !== "applied") {
    return `离线 Reviewer checkpoint 状态无效：${checkpoint.status}`;
  }
  if (checkpoint.role !== "reviewer" || checkpoint.stage !== "quality_review") {
    return `runId ${input.runId} 不是 quality_review Reviewer 证据`;
  }
  if (checkpoint.batchId !== input.batchId || checkpoint.inputSha256 !== input.inputSha256) {
    return `runId ${input.runId} 与当前 Reviewer 输入快照不一致`;
  }
  return null;
}

/** 校验原件而非只信任 checkpoint 的自报身份；已知规则脚本产物永久失去批准资格。 */
export function verifyArtifact(runId: string, visiting = new Set<string>()): AgentCheckpoint {
  if (visiting.has(runId)) throw new Error('证据链循环');
  visiting.add(runId);
  const cp = readCheckpoint(runId);
  if (!cp || !['validated', 'applied'].includes(cp.status)) throw new Error(`缺少有效 checkpoint：${runId}`);
  if (!/^[A-Za-z0-9._-]+$/.test(cp.batchId)) throw new Error('非法 batchId');
  const dir = path.join(agentWorkDir(), 'packets', cp.stage, cp.batchId);
  const json = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));
  const manifest = packetManifestSchema.parse(json(path.join(dir, 'manifest.json')));
  const snapshot = json(path.join(dir, 'input.snapshot.json')) as BatchFile<unknown, unknown>;
  const accepted = path.join(dir, 'submission.accepted.json');
  const submission = agentSubmissionSchema.parse(json(fs.existsSync(accepted) ? accepted : path.join(dir, 'submission.json')));
  const queueFile = ['done', 'pending'].map((bucket) => path.join(QUEUE_DIR, cp.stage, bucket, `${cp.batchId}.json`)).find((file) => fs.existsSync(file));
  if (!queueFile) throw new Error('队列证据缺失');
  const batch = json(queueFile) as BatchFile<unknown, Record<string, unknown>>;
  for (const item of [manifest, submission]) {
    if (item.batchId !== cp.batchId || item.stage !== cp.stage || item.role !== cp.role
      || item.inputSha256 !== cp.inputSha256 || item.promptVersion !== cp.promptVersion
      || item.promptSha256 !== cp.promptSha256 || item.schemaVersion !== cp.schemaVersion) throw new Error('证据身份/版本不一致');
  }
  if (batchInputHash(snapshot) !== cp.inputSha256 || batchInputHash(batch) !== cp.inputSha256
    || sha256(fs.readFileSync(path.join(dir, 'prompt.snapshot.md'))) !== cp.promptSha256
    || submission.runId !== cp.runId || submission.executor.sessionId !== cp.executorSessionId
    || sha256(stableJson(submission.output)) !== cp.outputSha256) throw new Error('证据哈希/执行身份不一致');
  // validated checkpoint 写入后，导入器尚未填队列时允许原始空 output；apply 必须有 output。
  if (batch.output != null) {
    const output = cp.stage === 'quality_review' ? { verdicts: batch.output.verdicts } : batch.output;
    if (sha256(stableJson(output)) !== cp.outputSha256) throw new Error('队列 output 与审核原件不一致');
  } else if (cp.status === 'applied') throw new Error('已应用批次缺少 output');
  if (cp.role === 'reviewer') {
    if (!submission.attestation.independentContext) throw new Error('Reviewer 缺少独立上下文');
    if (/^agent_session_independent_reviewer_batch_/.test(cp.executorSessionId)) throw new Error('已撤销：旧规则脚本伪造的 Reviewer 身份');
    if (stableJson(cp.upstreamRunIds.slice().sort()) !== stableJson(manifest.upstreamEvidence.map((item) => item.runId).sort())) throw new Error('上游清单不一致');
    for (const upstream of manifest.upstreamEvidence) {
      const generator = verifyArtifact(upstream.runId, visiting);
      if (generator.status !== 'applied' || generator.role !== 'generator'
        || generator.executorSessionId === cp.executorSessionId
        || generator.executorSessionId !== upstream.executorSessionId
        || generator.outputSha256 !== upstream.outputSha256) throw new Error('Generator 证据失效或上下文不独立');
    }
  }
  visiting.delete(runId);
  return cp;
}
