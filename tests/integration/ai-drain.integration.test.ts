import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { assertInsideTestResults, prepareTestDatabase } from "../helpers/temp-db";

const testDatabase = prepareTestDatabase("ai-drain.integration");
assertInsideTestResults(testDatabase.file);
const queueDirectory = path.join(testDatabase.directory, `ai-drain-queue.${process.pid}.${Date.now()}`);
const reportFile = path.join(testDatabase.directory, `ai-drain-report.${process.pid}.${Date.now()}.json`);
process.env.ROASTDUCK_DB = testDatabase.url;
process.env.ROASTDUCK_SKIP_DB_BACKUP = "1";
process.env.ROASTDUCK_QUEUE_DIR = queueDirectory;
process.env.ROASTDUCK_AI_DRAIN_REPORT = reportFile;

let drain: typeof import("@pipeline/src/ai/drain");
let MockAiProvider: typeof import("@/lib/ai/mock-provider").MockAiProvider;
let db: Awaited<ReturnType<typeof import("@db/client").getDbReady>>;
let schema: typeof import("@db/schema");

beforeAll(async () => {
  const pending = path.join(queueDirectory, "dedup", "pending");
  fs.mkdirSync(pending, { recursive: true });
  fs.writeFileSync(path.join(pending, "batch-drain-integration.json"), JSON.stringify({
    batchId: "batch-drain-integration",
    stage: "dedup",
    promptVersion: "dedup-v1",
    createdAt: new Date().toISOString(),
    attempts: 0,
    inputs: [{
      unitKey: "pair-integration",
      pairKey: "pair-integration",
      a: { id: "c_abcdef", canonical: "make progress", meaningZh: "取得进步" },
      b: { id: "c_ghijkl", canonical: "make steady progress", meaningZh: "取得稳定进步" },
    }],
    output: null,
  }, null, 2));

  const [drainModule, mockModule, client, schemaModule] = await Promise.all([
    import("@pipeline/src/ai/drain"),
    import("@/lib/ai/mock-provider"),
    import("@db/client"),
    import("@db/schema"),
  ]);
  drain = drainModule;
  MockAiProvider = mockModule.MockAiProvider;
  schema = schemaModule;
  db = await client.getDbReady();
});

describe("AI Drain 隔离端到端", () => {
  it("Mock 也经过真实队列、Job、Zod、审计和 output 写回", async () => {
    const provider = new MockAiProvider(() => ({
      verdicts: [{ pairKey: "pair-integration", verdict: "separate", reason: "语义精度不同，应分别学习" }],
    }));
    const report = await drain.runAiDrain(provider, {
      stages: ["dedup"],
      maxBatches: 1,
      maxCostUsd: 1,
      concurrency: 1,
      apply: false,
      dryRun: false,
    });
    expect(report.completed).toHaveLength(1);
    expect(report.failed).toHaveLength(0);
    expect(report.stoppedReason).toBe("max_batches");
    expect(report.model).toBe("deepseek-flash");
    expect(fs.existsSync(reportFile)).toBe(true);

    const batch = JSON.parse(fs.readFileSync(
      path.join(queueDirectory, "dedup", "pending", "batch-drain-integration.json"),
      "utf8",
    ));
    expect(batch.output.verdicts[0].verdict).toBe("separate");
    expect(batch.attempts).toBe(1);

    const [job] = await db.select().from(schema.aiJobs);
    expect(job.status).toBe("completed");
    const [run] = await db.select().from(schema.aiRuns);
    expect(run.provider).toBe("mock");
    expect(run.model).toBe("deepseek-flash");
    expect(run.role).toBe("reviewer");
    expect(run.status).toBe("completed");
  });

  it("并发上限会按批次组生效，且每批保留独立审计", async () => {
    const pending = path.join(queueDirectory, "dedup", "pending");
    for (const suffix of ["a", "b"]) {
      fs.writeFileSync(path.join(pending, `batch-drain-concurrent-${suffix}.json`), JSON.stringify({
        batchId: `batch-drain-concurrent-${suffix}`,
        stage: "dedup",
        promptVersion: "dedup-v1",
        createdAt: new Date().toISOString(),
        attempts: 0,
        inputs: [{
          unitKey: `pair-${suffix}`,
          pairKey: `pair-${suffix}`,
          a: { id: "c_abcdef", canonical: "make progress", meaningZh: "取得进步" },
          b: { id: "c_ghijkl", canonical: "make steady progress", meaningZh: "取得稳定进步" },
        }],
        output: null,
      }, null, 2));
    }

    let inFlight = 0;
    let maxInFlight = 0;
    const provider = new MockAiProvider(async (request) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 15));
      inFlight -= 1;
      const payload = JSON.parse(request.input) as { inputs: Array<{ pairKey: string }> };
      return {
        verdicts: [{ pairKey: payload.inputs[0].pairKey, verdict: "separate", reason: "并发隔离测试裁决" }],
      };
    });
    const report = await drain.runAiDrain(provider, {
      stages: ["dedup"],
      maxBatches: 2,
      maxCostUsd: 1,
      concurrency: 2,
      apply: false,
      dryRun: false,
    });
    expect(report.completed).toHaveLength(2);
    expect(maxInFlight).toBe(2);
    expect(new Set(report.completed.map((item) => item.runId)).size).toBe(2);
  });
});
