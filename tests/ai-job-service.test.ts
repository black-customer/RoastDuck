import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { assertInsideTestResults, prepareTestDatabase } from "./helpers/temp-db";
import { AiProviderError } from "@/lib/ai/errors";
import { MockAiProvider } from "@/lib/ai/mock-provider";

const testDatabase = prepareTestDatabase("ai-job-service");
assertInsideTestResults(testDatabase.file);
process.env.ROASTDUCK_DB = testDatabase.url;
process.env.ROASTDUCK_SKIP_DB_BACKUP = "1";

let jobs: typeof import("@/lib/ai/job-service");
let db: Awaited<ReturnType<typeof import("@db/client").getDbReady>>;
let schema: typeof import("@db/schema");

beforeAll(async () => {
  const client = await import("@db/client");
  schema = await import("@db/schema");
  jobs = await import("@/lib/ai/job-service");
  db = await client.getDbReady();
});

describe("AI Job 状态机与审计", () => {
  it("相同输入幂等入队，可重试错误写入独立 run 后完成", async () => {
    const input = {
      kind: "answer_translate",
      targetType: "answer",
      targetId: "answer_1",
      payload: { text: "我喜欢阅读" },
      promptVersion: "translator.v1",
      schemaVersion: "translation.v1",
    };
    const first = await jobs.enqueueAiJob(input);
    const duplicate = await jobs.enqueueAiJob(input);
    expect(duplicate.id).toBe(first.id);

    let calls = 0;
    const provider = new MockAiProvider(() => {
      calls += 1;
      if (calls === 1) throw new AiProviderError("temporary", "rate_limited", true, 429);
      return { translation: "I enjoy reading." };
    });
    const schemaOut = z.object({ translation: z.string() });
    const waits: number[] = [];
    const result = await jobs.runSingleAiJob({
      jobId: first.id,
      provider,
      request: {
        role: "translator",
        instructions: "translator prompt",
        input: "我喜欢阅读",
        schema: schemaOut,
        schemaName: "translation_v1",
        promptVersion: "translator.v1",
        schemaVersion: "translation.v1",
        idempotencyKey: first.idempotencyKey,
      },
      callOptions: { maxAttempts: 3, sleep: async (ms) => { waits.push(ms); }, random: () => 0 },
    });
    expect(result.data.translation).toBe("I enjoy reading.");
    expect(result.attempts).toBe(2);
    expect(waits).toEqual([500]);

    const [stored] = await db.select().from(schema.aiJobs).where((await import("drizzle-orm")).eq(schema.aiJobs.id, first.id));
    expect(stored.status).toBe("completed");
    expect(stored.attempts).toBe(2);
    const runs = (await db.select().from(schema.aiRuns)).filter((run) => run.jobId === first.id);
    expect(runs).toHaveLength(2);
    expect(runs.map((run) => run.status).sort()).toEqual(["completed", "failed"]);
    expect(runs.every((run) => run.model === "deepseek-flash")).toBe(true);
  });

  it("Generator 与 Reviewer 产生不同 runId，按 generating → reviewing → applying → completed 推进", async () => {
    const job = await jobs.enqueueAiJob({
      kind: "chunk_extract",
      targetType: "answer",
      targetId: "answer_2",
      payload: { text: "I make steady progress." },
      promptVersion: "personal-pipeline.v1",
      schemaVersion: "personal-chunk.v1",
    });
    const generatedSchema = z.object({ draft: z.string() });
    const reviewedSchema = z.object({ decision: z.enum(["approved", "rejected"]) });
    const provider = new MockAiProvider((request) => request.role === "generator"
      ? { draft: "make steady progress" }
      : { decision: "approved" });
    let applied = "";
    const result = await jobs.runReviewedAiJob({
      jobId: job.id,
      provider,
      generator: {
        role: "generator",
        instructions: "generator-only prompt",
        input: "I make steady progress.",
        schema: generatedSchema,
        schemaName: "personal_chunk_generator_v1",
        promptVersion: "personal.generator.v1",
        schemaVersion: "personal-chunk.v1",
        idempotencyKey: job.idempotencyKey,
      },
      reviewer: (generated) => ({
        role: "reviewer",
        instructions: "independent reviewer prompt",
        input: JSON.stringify(generated),
        schema: reviewedSchema,
        schemaName: "personal_chunk_reviewer_v1",
        promptVersion: "personal.reviewer.v1",
        schemaVersion: "personal-review.v1",
        idempotencyKey: `${job.idempotencyKey}_review`,
      }),
      isRejected: (review) => review.decision === "rejected",
      apply: async (generated) => { applied = generated.draft; },
      callOptions: { maxAttempts: 1 },
    });
    expect(result.applied).toBe(true);
    expect(applied).toBe("make steady progress");
    expect(result.generated.runId).not.toBe(result.reviewed.runId);

    const stored = (await db.select().from(schema.aiJobs)).find((item) => item.id === job.id);
    expect(stored?.status).toBe("completed");
    expect(stored?.attempts).toBe(2);
    const runs = (await db.select().from(schema.aiRuns)).filter((run) => run.jobId === job.id);
    expect(runs).toHaveLength(2);
    expect(new Set(runs.map((run) => run.runId)).size).toBe(2);
    expect(runs.map((run) => run.role).sort()).toEqual(["generator", "reviewer"]);
    await expect(jobs.transitionAiJob(job.id, "queued")).rejects.toThrow("非法 AI Job 状态转换");
  });

  it("Gap Generator 与 Gap Reviewer 使用专属角色但仍保持独立 run", async () => {
    const job = await jobs.enqueueAiJob({
      kind: "speaking_gap_pipeline",
      targetType: "answer",
      targetId: "answer_3",
      payload: { evidence: "I very like it." },
      promptVersion: "speaking-gap-pipeline.v1",
      schemaVersion: "speaking-gap.v1",
    });
    const generatedSchema = z.object({ evidence: z.string() });
    const reviewedSchema = z.object({ verdict: z.literal("approved") });
    const provider = new MockAiProvider((request) => request.role === "gap_generator"
      ? { evidence: "I very like it." }
      : { verdict: "approved" });
    const result = await jobs.runReviewedAiJob({
      jobId: job.id,
      provider,
      generatorRole: "gap_generator",
      reviewerRole: "gap_reviewer",
      generator: {
        role: "gap_generator",
        instructions: "gap generator prompt",
        input: "I very like it.",
        schema: generatedSchema,
        schemaName: "speaking_gap_generator_v1",
        promptVersion: "speaking-gap.generator.v1",
        schemaVersion: "speaking-gap.v1",
        idempotencyKey: job.idempotencyKey,
      },
      reviewer: (generated) => ({
        role: "gap_reviewer",
        instructions: "independent gap reviewer prompt",
        input: JSON.stringify(generated),
        schema: reviewedSchema,
        schemaName: "speaking_gap_reviewer_v1",
        promptVersion: "speaking-gap.reviewer.v1",
        schemaVersion: "speaking-gap-review.v1",
        idempotencyKey: `${job.idempotencyKey}_review`,
      }),
      isRejected: () => false,
      apply: async () => undefined,
      callOptions: { maxAttempts: 1 },
    });
    expect(result.generated.runId).not.toBe(result.reviewed.runId);
    const runs = (await db.select().from(schema.aiRuns)).filter((run) => run.jobId === job.id);
    expect(runs.map((run) => run.role).sort()).toEqual(["gap_generator", "gap_reviewer"]);
    expect(runs.every((run) => run.thinkingMode === "high")).toBe(true);
  });
});
