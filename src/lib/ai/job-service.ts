import { createHash, randomUUID } from "node:crypto";
import path from 'node:path';
import { and, eq, sql } from "drizzle-orm";
import { DB_URL, getDbReady, withDbTransaction } from "@db/client";
import { aiJobs, aiRuns } from "@db/schema";
import { AI_ROLE_CONFIG, type AiProvider, type AiRole, type StructuredAiRequest, type StructuredAiResult } from "./contracts";
import { AiProviderError, normalizeAiError, safeErrorSummary } from "./errors";

export const AI_JOB_STATUSES = [
  "queued",
  "generating",
  "reviewing",
  "applying",
  "completed",
  "needs_attention",
  "retryable_failure",
  "terminal_failure",
] as const;
export type AiJobStatus = (typeof AI_JOB_STATUSES)[number];

const transitions: Record<AiJobStatus, readonly AiJobStatus[]> = {
  queued: ["generating", "reviewing", "terminal_failure"],
  generating: ["reviewing", "applying", "needs_attention", "retryable_failure", "terminal_failure"],
  reviewing: ["applying", "needs_attention", "retryable_failure", "terminal_failure"],
  applying: ["completed", "retryable_failure", "terminal_failure"],
  completed: [],
  needs_attention: ["queued"],
  retryable_failure: ["queued", "generating", "reviewing"],
  terminal_failure: [],
};

function normalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, normalizeJson(item)]),
    );
  }
  if (typeof value === "string") return value.normalize("NFKC").trim().replace(/\s+/g, " ");
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export interface EnqueueAiJobInput {
  kind: string;
  targetType: string;
  targetId: string;
  payload: unknown;
  promptVersion: string;
  schemaVersion: string;
}

export async function enqueueAiJob(input: EnqueueAiJobInput) {
  if (input.targetType === 'pipeline_batch') assertPipelineMockSandbox();
  const db = await getDbReady();
  const normalized = JSON.stringify(normalizeJson({
    kind: input.kind,
    targetType: input.targetType,
    targetId: input.targetId,
    payload: input.payload,
    promptVersion: input.promptVersion,
    schemaVersion: input.schemaVersion,
  }));
  const jobId = `job_${sha256(normalized).slice(0, 24)}`;
  const idempotencyKey = sha256(`${normalized}|${jobId}`);
  await db.insert(aiJobs).values({
    id: jobId,
    kind: input.kind,
    status: "queued",
    targetType: input.targetType,
    targetId: input.targetId,
    idempotencyKey,
    promptVersion: input.promptVersion,
    schemaVersion: input.schemaVersion,
    payloadJson: JSON.stringify(input.payload),
  }).onConflictDoNothing();
  const [job] = await db.select().from(aiJobs).where(eq(aiJobs.idempotencyKey, idempotencyKey)).limit(1);
  if (!job) throw new Error("AI Job 创建失败");
  return job;
}

export async function transitionAiJob(jobId: string, nextStatus: AiJobStatus, lastErrorCode?: string | null) {
  const db = await getDbReady();
  const [job] = await db.select().from(aiJobs).where(eq(aiJobs.id, jobId)).limit(1);
  if (!job) throw new Error(`AI Job 不存在：${jobId}`);
  const current = job.status as AiJobStatus;
  if (current === nextStatus) return job;
  if (!AI_JOB_STATUSES.includes(current) || !transitions[current].includes(nextStatus)) {
    throw new Error(`非法 AI Job 状态转换：${current} → ${nextStatus}`);
  }
  await db.update(aiJobs).set({
    status: nextStatus,
    lastErrorCode: lastErrorCode ?? (nextStatus === "completed" ? null : job.lastErrorCode),
    updatedAt: new Date().toISOString(),
  }).where(and(eq(aiJobs.id, jobId), eq(aiJobs.status, current)));
  const [updated] = await db.select().from(aiJobs).where(eq(aiJobs.id, jobId)).limit(1);
  return updated;
}

export interface AuditedCallOptions {
  maxAttempts?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
}

export type AuditedAiResult<T> = StructuredAiResult<T> & { runId: string; attempts: number };

export async function executeAuditedAiCall<T>(
  provider: AiProvider,
  jobId: string | null,
  request: StructuredAiRequest<T>,
  options: AuditedCallOptions = {},
): Promise<AuditedAiResult<T>> {
  const db = await getDbReady();
  if (jobId) {
    const [job] = await db.select({ targetType: aiJobs.targetType }).from(aiJobs).where(eq(aiJobs.id, jobId)).limit(1);
    if (job?.targetType === 'pipeline_batch') assertPipelineMockSandbox(provider.providerName);
  }
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const random = options.random ?? Math.random;
  const inputHash = sha256(request.input.normalize("NFKC"));
  let finalError: AiProviderError | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const runId = randomUUID();
    const startedAt = Date.now();
    if (jobId) {
      await withDbTransaction(async () => (await getDbReady()).update(aiJobs).set({
        attempts: sql`${aiJobs.attempts} + 1`,
        updatedAt: new Date().toISOString(),
      }).where(eq(aiJobs.id, jobId)));
    }
    try {
      const result = await provider.generate(request);
      await withDbTransaction(async () => (await getDbReady()).insert(aiRuns).values({
        runId,
        jobId,
        role: request.role,
        provider: provider.providerName,
        model: provider.model,
        promptVersion: request.promptVersion,
        schemaVersion: request.schemaVersion,
        thinkingMode: AI_ROLE_CONFIG[request.role].thinking,
        inputHash,
        responseId: result.responseId,
        latencyMs: result.latencyMs,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        reasoningTokens: result.usage.reasoningTokens,
        cachedTokens: result.usage.cachedTokens,
        status: "completed",
      }));
      return { ...result, runId, attempts: attempt };
    } catch (reason) {
      const error = normalizeAiError(reason);
      finalError = error;
      await withDbTransaction(async () => (await getDbReady()).insert(aiRuns).values({
        runId,
        jobId,
        role: request.role,
        provider: provider.providerName,
        model: provider.model,
        promptVersion: request.promptVersion,
        schemaVersion: request.schemaVersion,
        thinkingMode: AI_ROLE_CONFIG[request.role].thinking,
        inputHash,
        latencyMs: Date.now() - startedAt,
        status: "failed",
        errorCode: error.code,
        errorSummary: safeErrorSummary(error),
      }));
      if (!error.retryable || attempt >= maxAttempts) break;
      const delay = Math.min(30_000, 500 * (2 ** (attempt - 1)) + Math.floor(random() * 250));
      await sleep(delay);
    }
  }
  throw finalError ?? new AiProviderError("AI 调用失败", "network_error", true);
}

function assertPipelineMockSandbox(providerName?: string) {
  const relative = DB_URL.startsWith('file:') ? path.relative(path.resolve('test-results'), path.resolve(DB_URL.slice(5))) : '..';
  if (process.env.NODE_ENV !== 'test' || relative.startsWith('..') || path.isAbsolute(relative)
    || (providerName !== undefined && providerName !== 'mock')) {
    throw new AiProviderError('公共内容不得通过 Runtime 服务执行；请使用离线 Agent', 'invalid_configuration', false);
  }
}

async function failJob(jobId: string, reason: unknown) {
  const error = reason instanceof AiProviderError ? reason : normalizeAiError(reason);
  const status: AiJobStatus = error.code === "invalid_output" || error.code === "incomplete_output"
    ? "needs_attention"
    : error.retryable
      ? "retryable_failure"
      : "terminal_failure";
  await transitionAiJob(jobId, status, error.code);
}

export async function runSingleAiJob<T>(options: {
  jobId: string;
  provider: AiProvider;
  request: StructuredAiRequest<T>;
  apply?: (data: T, result: AuditedAiResult<T>) => Promise<void>;
  callOptions?: AuditedCallOptions;
}) {
  const startStatus = (["reviewer", "variant_reviewer"] as AiRole[]).includes(options.request.role)
    ? "reviewing"
    : "generating";
  await transitionAiJob(options.jobId, startStatus);
  try {
    const result = await executeAuditedAiCall(options.provider, options.jobId, options.request, options.callOptions);
    await transitionAiJob(options.jobId, "applying");
    await options.apply?.(result.data, result);
    await transitionAiJob(options.jobId, "completed");
    return result;
  } catch (reason) {
    await failJob(options.jobId, reason);
    throw reason;
  }
}

export async function runReviewedAiJob<G, R>(options: {
  jobId: string;
  provider: AiProvider;
  generator: StructuredAiRequest<G>;
  reviewer: (generated: G) => StructuredAiRequest<R>;
  isRejected: (review: R) => boolean;
  apply: (generated: G, review: R, audit: { generatorRunId: string; reviewerRunId: string }) => Promise<void>;
  generatorRole?: AiRole;
  reviewerRole?: AiRole;
  callOptions?: AuditedCallOptions;
}) {
  const generatorRole = options.generatorRole ?? "generator";
  const reviewerRole = options.reviewerRole ?? "reviewer";
  if (options.generator.role !== generatorRole) throw new Error(`Generator 请求角色必须为 ${generatorRole}`);
  await transitionAiJob(options.jobId, "generating");
  try {
    const generated = await executeAuditedAiCall(
      options.provider,
      options.jobId,
      options.generator,
      options.callOptions,
    );
    const reviewerRequest = options.reviewer(generated.data);
    if (reviewerRequest.role !== reviewerRole) throw new Error(`Reviewer 请求角色必须为 ${reviewerRole}`);
    if (
      reviewerRequest.instructions === options.generator.instructions
      || reviewerRequest.promptVersion === options.generator.promptVersion
    ) {
      throw new AiProviderError("Generator 与 Reviewer 必须使用独立 Prompt", "invalid_configuration", false);
    }
    await transitionAiJob(options.jobId, "reviewing");
    const reviewed = await executeAuditedAiCall(
      options.provider,
      options.jobId,
      reviewerRequest,
      options.callOptions,
    );
    if (options.isRejected(reviewed.data)) {
      await transitionAiJob(options.jobId, "needs_attention");
      return { generated, reviewed, applied: false as const };
    }
    await transitionAiJob(options.jobId, "applying");
    await options.apply(generated.data, reviewed.data, {
      generatorRunId: generated.runId,
      reviewerRunId: reviewed.runId,
    });
    await transitionAiJob(options.jobId, "completed");
    return { generated, reviewed, applied: true as const };
  } catch (reason) {
    await failJob(options.jobId, reason);
    throw reason;
  }
}
