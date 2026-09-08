import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { AiProvider, AiRole, StructuredAiRequest } from "../../../src/lib/ai/contracts";
import { AiProviderError, safeErrorSummary } from "../../../src/lib/ai/errors";
import { enqueueAiJob, runSingleAiJob } from "../../../src/lib/ai/job-service";
import {
  blueprintBatchOutputSchema,
  chunkCandidateBatchOutputSchema,
  contentEnrichmentBatchOutputSchema,
  dedupBatchOutputSchema,
  pronunciationEnrichmentBatchOutputSchema,
  qualityVerdictSchema,
  topicDomainsBatchOutputSchema,
} from "../lib/schemas";
import { listPendingBatches, writeBatch, type BatchFile, type StageName } from "../lib/queue";
import { blueprintApply, blueprintCreate } from "../compiler/blueprint";
import { topicDomainsApply, topicDomainsCreate } from "../compiler/topic_domains";
import { chunkCandidateApply, chunkCandidateCreate } from "../compiler/chunk_candidate";
import { dedupPairsApply, dedupPairsCreate } from "../compiler/dedup";
import { contentEnrichmentApply, contentEnrichmentCreate } from "../compiler/content_enrichment";
import { pronunciationEnrichmentApply, pronunciationEnrichmentCreate } from "../compiler/pronunciation_enrichment";
import { qualityApply, qualityCreate } from "../compiler/quality_review";

export const DRAIN_STAGE_ORDER: StageName[] = [
  "blueprint",
  "topic_domains",
  "chunk_candidate",
  "dedup",
  "content_enrichment",
  "pronunciation_enrichment",
  "quality_review",
];

interface StageDefinition {
  role: AiRole;
  promptFile: string;
  schema: z.ZodType<unknown>;
  schemaVersion: string;
  schemaName: string;
  maxOutputTokens: number;
  postprocess: (data: unknown, evidence: { provider: string; model: string; runId: string }) => unknown;
  apply: () => Promise<{ applied: number; rejected: number; pending: number }>;
  refill: () => Promise<number>;
}

const passthrough = (data: unknown) => data;
const QUALITY_MODEL_SCHEMA = z.object({ verdicts: z.array(qualityVerdictSchema).min(1) });

export const STAGE_DEFINITIONS: Record<StageName, StageDefinition> = {
  blueprint: {
    role: "generator",
    promptFile: "blueprint.md",
    schema: blueprintBatchOutputSchema,
    schemaVersion: "blueprint.output.v1",
    schemaName: "blueprint_batch_v1",
    maxOutputTokens: 6144,
    postprocess: passthrough,
    apply: blueprintApply,
    refill: () => blueprintCreate(40),
  },
  topic_domains: {
    role: "generator",
    promptFile: "topic_domains.md",
    schema: topicDomainsBatchOutputSchema,
    schemaVersion: "topic-domains.output.v1",
    schemaName: "topic_domains_batch_v1",
    maxOutputTokens: 6144,
    postprocess: passthrough,
    apply: topicDomainsApply,
    refill: () => topicDomainsCreate(30),
  },
  chunk_candidate: {
    role: "generator",
    promptFile: "chunk_candidate.md",
    schema: chunkCandidateBatchOutputSchema,
    schemaVersion: "chunk-candidate.output.v2",
    schemaName: "chunk_candidate_batch_v2",
    maxOutputTokens: 12_000,
    postprocess: passthrough,
    apply: chunkCandidateApply,
    refill: async () => {
      const [questions, topics, sentences] = await Promise.all([
        chunkCandidateCreate({ questions: true, maxBatches: 20 }),
        chunkCandidateCreate({ topics: true, maxBatches: 20 }),
        chunkCandidateCreate({ sentences: true, maxBatches: 15 }),
      ]);
      return questions + topics + sentences;
    },
  },
  dedup: {
    role: "reviewer",
    promptFile: "dedup.md",
    schema: dedupBatchOutputSchema,
    schemaVersion: "dedup.output.v1",
    schemaName: "dedup_batch_v1",
    maxOutputTokens: 4096,
    postprocess: passthrough,
    apply: dedupPairsApply,
    refill: () => dedupPairsCreate(15),
  },
  content_enrichment: {
    role: "generator",
    promptFile: "content_enrichment.md",
    schema: contentEnrichmentBatchOutputSchema,
    schemaVersion: "content-enrichment.output.v1",
    schemaName: "content_enrichment_batch_v1",
    maxOutputTokens: 6144,
    postprocess: passthrough,
    apply: contentEnrichmentApply,
    refill: () => contentEnrichmentCreate(30),
  },
  pronunciation_enrichment: {
    role: "generator",
    promptFile: "pronunciation_enrichment.md",
    schema: pronunciationEnrichmentBatchOutputSchema,
    schemaVersion: "pronunciation-enrichment.output.v1",
    schemaName: "pronunciation_enrichment_batch_v1",
    maxOutputTokens: 4096,
    postprocess: passthrough,
    apply: pronunciationEnrichmentApply,
    refill: () => pronunciationEnrichmentCreate(20),
  },
  quality_review: {
    role: "reviewer",
    promptFile: "quality_review.md",
    schema: QUALITY_MODEL_SCHEMA,
    schemaVersion: "quality-review.output.v3",
    schemaName: "quality_review_batch_v3",
    maxOutputTokens: 8192,
    postprocess: (data, evidence) => ({
      reviewer: {
        role: "independent_reviewer",
        provider: evidence.provider,
        model: evidence.model,
        runId: evidence.runId,
      },
      verdicts: (data as z.infer<typeof QUALITY_MODEL_SCHEMA>).verdicts,
    }),
    apply: qualityApply,
    refill: () => qualityCreate(50),
  },
};

export interface DrainPricing {
  inputMissUsdPerMillion: number;
  inputCacheUsdPerMillion: number;
  outputUsdPerMillion: number;
}

/** 采用官方峰时价格作保守预算；可在调用方显式覆盖。 */
export const CONSERVATIVE_FLASH_PRICING: DrainPricing = {
  inputMissUsdPerMillion: 0.44,
  inputCacheUsdPerMillion: 0.014,
  outputUsdPerMillion: 1.32,
};

export function estimateTextTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}

export function calculateUsageCost(usage: {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}, pricing: DrainPricing = CONSERVATIVE_FLASH_PRICING): number {
  const cached = Math.min(usage.inputTokens, usage.cachedTokens);
  const uncached = Math.max(0, usage.inputTokens - cached);
  return (
    uncached * pricing.inputMissUsdPerMillion
    + cached * pricing.inputCacheUsdPerMillion
    + usage.outputTokens * pricing.outputUsdPerMillion
  ) / 1_000_000;
}

export interface DrainOptions {
  stages?: StageName[];
  maxBatches: number;
  maxCostUsd: number;
  concurrency: number;
  apply: boolean;
  dryRun: boolean;
  pricing?: DrainPricing;
}

interface BatchSuccess {
  stage: StageName;
  batchId: string;
  runId: string;
  responseId: string;
  usage: { inputTokens: number; outputTokens: number; cachedTokens: number; reasoningTokens: number };
  costUsd: number;
}

interface BatchFailure {
  stage: StageName;
  batchId: string;
  code: string;
  summary: string;
}

export interface DrainReport {
  startedAt: string;
  finishedAt: string;
  model: string;
  provider: string;
  options: Omit<DrainOptions, "pricing">;
  planned: Array<{ stage: StageName; batchId: string; inputCount: number; estimatedCostUsd: number }>;
  completed: BatchSuccess[];
  failed: BatchFailure[];
  applied: Record<string, { applied: number; rejected: number; pending: number }>;
  totalCostUsd: number;
  stoppedReason: string;
}

const ROOT = path.resolve(process.cwd());
const PROMPTS = path.join(ROOT, "pipeline/prompts");
const REPORT_FILE = process.env.ROASTDUCK_AI_DRAIN_REPORT
  ? path.resolve(process.env.ROASTDUCK_AI_DRAIN_REPORT)
  : path.join(ROOT, "pipeline/reports/ai-drain-latest.json");

function loadPrompt(definition: StageDefinition): string {
  return fs.readFileSync(path.join(PROMPTS, definition.promptFile), "utf8");
}

function requestForBatch(
  definition: StageDefinition,
  batch: BatchFile<unknown, unknown>,
  idempotencyKey: string,
): StructuredAiRequest<unknown> {
  const runtimeInstruction = definition.role === "reviewer"
    ? "\n\n运行时约束：这是独立 Reviewer 请求，不包含 Generator 上下文。只依据当前输入与规范裁决。"
    : "\n\n运行时约束：这是 Generator 请求，不拥有 approved 权限。";
  const qualityOverride = batch.stage === "quality_review"
    ? "\n质量审计元数据由运行器注入；你只输出 JSON 对象 {\"verdicts\":[...]}，不要输出 reviewer 字段。"
    : "";
  return {
    role: definition.role,
    instructions: `${loadPrompt(definition)}${runtimeInstruction}${qualityOverride}`,
    input: JSON.stringify({
      batchId: batch.batchId,
      stage: batch.stage,
      promptVersion: batch.promptVersion,
      inputs: batch.inputs,
    }),
    schema: definition.schema,
    schemaName: definition.schemaName,
    promptVersion: `${batch.promptVersion}.${definition.role}`,
    schemaVersion: definition.schemaVersion,
    idempotencyKey,
    maxOutputTokens: definition.maxOutputTokens,
  };
}

function estimatedBatchCost(definition: StageDefinition, batch: BatchFile<unknown, unknown>, pricing: DrainPricing) {
  const input = JSON.stringify(batch.inputs);
  return calculateUsageCost({
    inputTokens: estimateTextTokens(input) + 800,
    outputTokens: definition.maxOutputTokens,
    cachedTokens: 0,
  }, pricing);
}

async function processBatch(
  provider: AiProvider,
  stage: StageName,
  batch: BatchFile<unknown, unknown>,
  pricing: DrainPricing,
): Promise<BatchSuccess> {
  const definition = STAGE_DEFINITIONS[stage];
  const job = await enqueueAiJob({
    kind: `pipeline_${stage}`,
    targetType: "pipeline_batch",
    targetId: batch.batchId,
    payload: { stage, batchId: batch.batchId, inputCount: batch.inputs.length },
    promptVersion: `${batch.promptVersion}.${definition.role}`,
    schemaVersion: definition.schemaVersion,
  });
  if (job.status === "completed") {
    throw new AiProviderError("AI Job 已完成但批次仍无 output，请检查文件一致性", "invalid_output", false);
  }
  if (job.status === "needs_attention" || job.status === "terminal_failure") {
    throw new AiProviderError(`AI Job 当前为 ${job.status}，需先处理后才能续跑`, "invalid_output", false);
  }
  const request = requestForBatch(definition, batch, job.idempotencyKey);
  const result = await runSingleAiJob({
    jobId: job.id,
    provider,
    request,
    apply: async (data, evidence) => {
      batch.output = definition.postprocess(data, {
        provider: provider.providerName,
        model: provider.model,
        runId: evidence.runId,
      });
      batch.attempts = (batch.attempts ?? 0) + evidence.attempts;
      writeBatch(batch);
    },
  });
  return {
    stage,
    batchId: batch.batchId,
    runId: result.runId,
    responseId: result.responseId,
    usage: result.usage,
    costUsd: calculateUsageCost(result.usage, pricing),
  };
}

function hardStopCode(code: string): boolean {
  return ["invalid_configuration", "authentication_failed", "insufficient_balance", "wrong_model"].includes(code);
}

export async function runAiDrain(provider: AiProvider, options: DrainOptions): Promise<DrainReport> {
  if (provider.providerName !== 'mock' || process.env.NODE_ENV !== 'test'
    || !process.env.ROASTDUCK_DB?.replaceAll('\\', '/').includes('/test-results/')
    || !process.env.ROASTDUCK_QUEUE_DIR?.replaceAll('\\', '/').includes('/test-results/')) {
    throw new Error('公共内容 Runtime drain 已禁用；仅允许隔离临时库中的 mock 回归测试');
  }
  const pricing = options.pricing ?? CONSERVATIVE_FLASH_PRICING;
  const stages = options.stages?.length ? options.stages : DRAIN_STAGE_ORDER;
  const startedAt = new Date().toISOString();
  const completed: BatchSuccess[] = [];
  const failed: BatchFailure[] = [];
  const planned: DrainReport["planned"] = [];
  const applied: DrainReport["applied"] = {};
  const seen = new Set<string>();
  let totalCostUsd = 0;
  let stoppedReason = "queue_empty";
  let shouldStop = false;

  for (const stage of stages) {
    if (shouldStop) break;
    const definition = STAGE_DEFINITIONS[stage];
    if (options.apply && !options.dryRun) {
      const result = await definition.apply();
      applied[stage] = result;
      await definition.refill();
    }

    while (completed.length + failed.length < options.maxBatches) {
      const pending = listPendingBatches<unknown, unknown>(stage)
        .filter((batch) => batch.output == null && !seen.has(batch.batchId));
      if (!pending.length) break;

      const group: Array<{ batch: BatchFile<unknown, unknown>; estimate: number }> = [];
      let reserved = 0;
      for (const batch of pending) {
        if (group.length >= Math.max(1, options.concurrency)) break;
        const estimate = estimatedBatchCost(definition, batch, pricing);
        if (totalCostUsd + reserved + estimate > options.maxCostUsd) {
          stoppedReason = "budget_preflight";
          shouldStop = true;
          break;
        }
        seen.add(batch.batchId);
        group.push({ batch, estimate });
        planned.push({ stage, batchId: batch.batchId, inputCount: batch.inputs.length, estimatedCostUsd: estimate });
        reserved += estimate;
      }
      if (!group.length) break;
      if (options.dryRun) {
        stoppedReason = "dry_run";
        shouldStop = true;
        break;
      }

      const results = await Promise.allSettled(
        group.map(({ batch }) => processBatch(provider, stage, batch, pricing)),
      );
      for (let index = 0; index < results.length; index += 1) {
        const result = results[index];
        const batch = group[index].batch;
        if (result.status === "fulfilled") {
          completed.push(result.value);
          totalCostUsd += result.value.costUsd;
        } else {
          const error = result.reason instanceof AiProviderError ? result.reason : null;
          const code = error?.code ?? "unknown_error";
          failed.push({ stage, batchId: batch.batchId, code, summary: safeErrorSummary(result.reason) });
          if (hardStopCode(code)) {
            stoppedReason = code;
            shouldStop = true;
          }
        }
      }
      if (options.apply) {
        const result = await definition.apply();
        applied[stage] = result;
        await definition.refill();
      }
      if (shouldStop) break;
    }
  }

  if (completed.length + failed.length >= options.maxBatches) stoppedReason = "max_batches";
  const report: DrainReport = {
    startedAt,
    finishedAt: new Date().toISOString(),
    provider: provider.providerName,
    model: provider.model,
    options: {
      stages: options.stages,
      maxBatches: options.maxBatches,
      maxCostUsd: options.maxCostUsd,
      concurrency: options.concurrency,
      apply: options.apply,
      dryRun: options.dryRun,
    },
    planned,
    completed,
    failed,
    applied,
    totalCostUsd,
    stoppedReason,
  };
  fs.mkdirSync(path.dirname(REPORT_FILE), { recursive: true });
  fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2), "utf8");
  return report;
}
