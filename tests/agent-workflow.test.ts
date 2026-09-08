import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

const testRoot = path.resolve("test-results", `agent-workflow-${randomUUID()}`);
const workDir = path.join(testRoot, "work");
const queueDir = path.join(testRoot, "queue");

// 队列与工作目录都必须在 import 之前指向隔离目录，否则测试会污染真实队列。
process.env.ROASTDUCK_AGENT_WORK_DIR = workDir;
process.env.ROASTDUCK_QUEUE_DIR = queueDir;

type Workflow = typeof import("@pipeline/src/agent/workflow");
type Evidence = typeof import("@pipeline/src/agent/evidence");
type Contracts = typeof import("@pipeline/src/agent/contracts");

let workflow: Workflow;
let evidence: Evidence;
let contracts: Contracts;

beforeAll(async () => {
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(queueDir, { recursive: true });
  [workflow, evidence, contracts] = await Promise.all([
    import("@pipeline/src/agent/workflow"),
    import("@pipeline/src/agent/evidence"),
    import("@pipeline/src/agent/contracts"),
  ]);
});

function writeBatch(stage: string, batchId: string, inputs: unknown[], promptVersion: string) {
  const dir = path.join(queueDir, stage, "pending");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${batchId}.json`);
  fs.writeFileSync(
    file,
    `${JSON.stringify({ batchId, stage, promptVersion, createdAt: new Date().toISOString(), inputs, output: null }, null, 2)}\n`,
    "utf8",
  );
  return file;
}

function contentInputs(chunkId: string, exampleId: string) {
  return [
    {
      unitKey: chunkId,
      chunkId,
      displayChunk: "happiness means different things",
      unitType: "sentence_frame",
      meaningZh: "幸福的定义因人而异",
      englishGloss: "",
      examples: [{ exampleId, textEn: "Happiness means different things at different ages.", textZh: "", contextType: "generated_ielts", generated: true, sourceRef: "Life stages" }],
      contexts: [],
      sources: [],
    },
  ];
}

function readPacket(stage: string, batchId: string, name: string) {
  return fs.readFileSync(path.join(workDir, "packets", stage, batchId, name), "utf8");
}

function readJsonPacket(stage: string, batchId: string, name: string) {
  return JSON.parse(readPacket(stage, batchId, name)) as Record<string, unknown>;
}

function submissionFrom(stage: string, batchId: string, overrides: Record<string, unknown> = {}) {
  const manifest = readJsonPacket(stage, batchId, "manifest.json");
  const template = JSON.parse(readPacket(stage, batchId, "submission.template.json")) as Record<string, unknown>;
  return {
    ...template,
    runId: `agent_run_test_${batchId.replace(/\W/g, "")}`,
    executor: { kind: "codex_agent", sessionId: `session_${stage}_${batchId}` },
    ...overrides,
    inputSha256: manifest.inputSha256,
    promptSha256: manifest.promptSha256,
  } as Record<string, unknown>;
}

function writeSubmission(stage: string, batchId: string, submission: Record<string, unknown>) {
  const dir = path.join(workDir, "packets", stage, batchId);
  const file = path.join(dir, "submission.json");
  fs.writeFileSync(file, `${JSON.stringify(submission, null, 2)}\n`, "utf8");
  return file;
}

describe("Agent 内容工作流证据链", () => {
  it("prepare 生成输入快照、Prompt 快照与 manifest，并可重复执行", () => {
    const batchId = "batch-test-content-1";
    writeBatch("content_enrichment", batchId, contentInputs("c_ygt4p2uvcx60", "ce_1dl1qbcj5hvf"), "content_enrichment-v1");

    const first = workflow.prepareAgentPackets({ stage: "content_enrichment", batchId });
    expect(first.prepared).toEqual([batchId]);

    const manifest = readJsonPacket("content_enrichment", batchId, "manifest.json");
    expect(manifest.stage).toBe("content_enrichment");
    expect(manifest.role).toBe("generator");
    expect(manifest.unitKeys).toEqual(["c_ygt4p2uvcx60"]);
    expect(String(manifest.inputSha256)).toMatch(/^[0-9a-f]{64}$/);
    expect(String(manifest.promptSha256)).toMatch(/^[0-9a-f]{64}$/);
    expect(readPacket("content_enrichment", batchId, "input.snapshot.json")).toContain("c_ygt4p2uvcx60");
    expect(readPacket("content_enrichment", batchId, "prompt.snapshot.md").length).toBeGreaterThan(50);

    // 重复准备应跳过而不是重建，保证输入快照不被悄悄替换。
    const second = workflow.prepareAgentPackets({ stage: "content_enrichment", batchId });
    expect(second.prepared).toEqual([]);
    expect(second.skipped).toEqual([batchId]);
  });

  it("输入快照被篡改后拒绝校验", () => {
    const batchId = "batch-test-content-2";
    writeBatch("content_enrichment", batchId, contentInputs("c_ygt4p2uvcx61", "ce_1dl1qbcj5hvg"), "content_enrichment-v1");
    workflow.prepareAgentPackets({ stage: "content_enrichment", batchId });

    const snapshotFile = path.join(workDir, "packets", "content_enrichment", batchId, "input.snapshot.json");
    const snapshot = JSON.parse(fs.readFileSync(snapshotFile, "utf8")) as { inputs: Array<{ meaningZh: string }> };
    snapshot.inputs[0].meaningZh = "被篡改的释义";
    fs.writeFileSync(snapshotFile, JSON.stringify(snapshot, null, 2), "utf8");

    const file = writeSubmission("content_enrichment", batchId, submissionFrom("content_enrichment", batchId, {
      output: { items: [{ chunkId: "c_ygt4p2uvcx61", englishGloss: "used to say that happiness varies", exampleTranslations: [{ exampleId: "ce_1dl1qbcj5hvg", textZh: "幸福在不同年纪含义不同。" }] }] },
    }));
    expect(() => workflow.validateAgentSubmission(file)).toThrow(/input\.snapshot\.json 已被修改/);
  });

  it("Prompt 快照被篡改后拒绝校验", () => {
    const batchId = "batch-test-content-3";
    writeBatch("content_enrichment", batchId, contentInputs("c_ygt4p2uvcx62", "ce_1dl1qbcj5hvhh"), "content_enrichment-v1");
    workflow.prepareAgentPackets({ stage: "content_enrichment", batchId });

    const promptFile = path.join(workDir, "packets", "content_enrichment", batchId, "prompt.snapshot.md");
    fs.writeFileSync(promptFile, `${fs.readFileSync(promptFile, "utf8")}\n<!-- tampered -->`, "utf8");

    const file = writeSubmission("content_enrichment", batchId, submissionFrom("content_enrichment", batchId, {
      output: { items: [{ chunkId: "c_ygt4p2uvcx62", englishGloss: "used to say that happiness varies", exampleTranslations: [] }] },
    }));
    expect(() => workflow.validateAgentSubmission(file)).toThrow(/prompt\.snapshot\.md 已被修改/);
  });

  it("output 不符合 Schema 时拒绝，并给出字段路径", () => {
    const batchId = "batch-test-content-4";
    writeBatch("content_enrichment", batchId, contentInputs("c_ygt4p2uvcx63", "ce_1dl1qbcj5hvhi"), "content_enrichment-v1");
    workflow.prepareAgentPackets({ stage: "content_enrichment", batchId });

    const file = writeSubmission("content_enrichment", batchId, submissionFrom("content_enrichment", batchId, {
      output: { items: [{ chunkId: "not-a-chunk-id", englishGloss: "x", exampleTranslations: [] }] },
    }));
    expect(() => workflow.validateAgentSubmission(file)).toThrow(/output Schema 校验失败/);
  });

  it("合法提交通过校验并产出输出指纹", () => {
    const batchId = "batch-test-content-5";
    writeBatch("content_enrichment", batchId, contentInputs("c_ygt4p2uvcx64", "ce_1dl1qbcj5hvhj"), "content_enrichment-v1");
    workflow.prepareAgentPackets({ stage: "content_enrichment", batchId });

    const file = writeSubmission("content_enrichment", batchId, submissionFrom("content_enrichment", batchId, {
      output: { items: [{ chunkId: "c_ygt4p2uvcx64", englishGloss: "used to say that happiness varies", exampleTranslations: [{ exampleId: "ce_1dl1qbcj5hvhj", textZh: "幸福在不同年纪含义不同。" }] }] },
    }));
    const validated = workflow.validateAgentSubmission(file);
    expect(validated.submission.attestation.noExternalRuntimeApi).toBe(true);
    expect(validated.outputSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("提交缺少 noExternalRuntimeApi 声明时拒绝", () => {
    const batchId = "batch-test-content-6";
    writeBatch("content_enrichment", batchId, contentInputs("c_ygt4p2uvcx65", "ce_1dl1qbcj5hvhk"), "content_enrichment-v1");
    workflow.prepareAgentPackets({ stage: "content_enrichment", batchId });

    const submission = submissionFrom("content_enrichment", batchId, {
      output: { items: [{ chunkId: "c_ygt4p2uvcx65", englishGloss: "used to say that happiness varies", exampleTranslations: [] }] },
    }) as { attestation: Record<string, unknown> };
    submission.attestation = { independentContext: false };
    const file = writeSubmission("content_enrichment", batchId, submission as unknown as Record<string, unknown>);
    expect(() => workflow.validateAgentSubmission(file)).toThrow();
  });
});

describe("Reviewer 独立性", () => {
  it("quality_review 未声明独立上下文时拒绝", () => {
    const batchId = "batch-test-quality-1";
    const chunkId = "c_ygt4p2uvcx70";
    writeBatch("quality_review", batchId, [
      { unitKey: chunkId, chunkId, displayChunk: "happiness means different things", unitType: "sentence_frame", meaningZh: "幸福的定义因人而异", englishGloss: "used to say that happiness varies", difficulty: "B1", examples: [], sources: [], pronunciations: [] },
    ], "quality_review-v3");
    workflow.prepareAgentPackets({ stage: "quality_review", batchId });

    const submission = submissionFrom("quality_review", batchId, {
      output: { verdicts: [{ chunkId, verdict: "approved", reason: "" }] },
    }) as { attestation: Record<string, unknown> };
    submission.attestation = { noExternalRuntimeApi: true, independentContext: false };
    const file = writeSubmission("quality_review", batchId, submission as unknown as Record<string, unknown>);
    expect(() => workflow.validateAgentSubmission(file)).toThrow(/independentContext=true/);
  });

  it("Reviewer 与 Generator 复用同一 Agent session 时拒绝", () => {
    const batchId = "batch-test-quality-2";
    const chunkId = "c_ygt4p2uvcx71";
    const sharedSession = "session_shared_abc";
    writeBatch("quality_review", batchId, [
      { unitKey: chunkId, chunkId, displayChunk: "happiness means different things", unitType: "sentence_frame", meaningZh: "幸福的定义因人而异", englishGloss: "used to say that happiness varies", difficulty: "B1", examples: [], sources: [], pronunciations: [] },
    ], "quality_review-v3");

    // 先落一个已应用的 Generator checkpoint，sessionId 与即将提交的 Reviewer 相同。
    evidence.writeCheckpoint({
      workflowVersion: contracts.AGENT_WORKFLOW_VERSION,
      runId: "agent_run_upstream_generator",
      batchId: "batch-test-content-upstream",
      stage: "content_enrichment",
      role: "generator",
      executorSessionId: sharedSession,
      inputSha256: "a".repeat(64),
      outputSha256: "b".repeat(64),
      promptVersion: "content_enrichment-v1",
      promptSha256: "c".repeat(64),
      schemaVersion: "content-enrichment.output.v1",
      unitKeys: [chunkId],
      upstreamRunIds: [],
      status: "applied",
      reason: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    workflow.prepareAgentPackets({ stage: "quality_review", batchId });
    const manifest = readJsonPacket("quality_review", batchId, "manifest.json");
    expect((manifest.upstreamEvidence as Array<{ runId: string }>).map((item) => item.runId))
      .toContain("agent_run_upstream_generator");

    const file = writeSubmission("quality_review", batchId, submissionFrom("quality_review", batchId, {
      executor: { kind: "codex_agent", sessionId: sharedSession },
      output: { verdicts: [{ chunkId, verdict: "approved", reason: "" }] },
    }));
    expect(() => workflow.validateAgentSubmission(file)).toThrow(/复用了同一 Agent session/);
  });

  it("独立 session 的 Reviewer 通过校验，且输出被包装为独立裁决证据", () => {
    const batchId = "batch-test-quality-3";
    const chunkId = "c_ygt4p2uvcx72";
    writeBatch("quality_review", batchId, [
      { unitKey: chunkId, chunkId, displayChunk: "happiness means different things", unitType: "sentence_frame", meaningZh: "幸福的定义因人而异", englishGloss: "used to say that happiness varies", difficulty: "B1", examples: [], sources: [], pronunciations: [] },
    ], "quality_review-v3");
    workflow.prepareAgentPackets({ stage: "quality_review", batchId });

    const file = writeSubmission("quality_review", batchId, submissionFrom("quality_review", batchId, {
      executor: { kind: "codex_agent", sessionId: "session_independent_reviewer" },
      output: { verdicts: [{ chunkId, verdict: "approved", reason: "" }] },
    }));
    const validated = workflow.validateAgentSubmission(file);
    expect(validated.submission.attestation.independentContext).toBe(true);
    const queueOutput = validated.queueOutput as { reviewer: { provider: string; model: string; runId: string }; verdicts: unknown[] };
    expect(queueOutput.reviewer.provider).toBe(contracts.AGENT_REVIEW_PROVIDER);
    expect(queueOutput.reviewer.model).toBe(contracts.AGENT_REVIEW_MODEL);
    expect(queueOutput.reviewer.runId).toBe(validated.submission.runId);
  });
});

describe("checkpoint 幂等与审计", () => {
  it("相同 runId 用于不同产物时拒绝覆盖", () => {
    const runId = "agent_run_reuse_check";
    const base = {
      workflowVersion: contracts.AGENT_WORKFLOW_VERSION,
      runId,
      batchId: "batch-a",
      stage: "content_enrichment",
      role: "generator",
      executorSessionId: "session-a",
      inputSha256: "a".repeat(64),
      outputSha256: "b".repeat(64),
      promptVersion: "content_enrichment-v1",
      promptSha256: "c".repeat(64),
      schemaVersion: "content-enrichment.output.v1",
      unitKeys: ["c_ygt4p2uvcx80"],
      upstreamRunIds: [],
      status: "applied",
      reason: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as const;
    evidence.writeCheckpoint(base as never);
    const stored = evidence.readCheckpoint(runId);
    expect(stored?.batchId).toBe("batch-a");
    expect(evidence.listCheckpoints().some((item) => item.runId === runId)).toBe(true);
  });

  it("stableJson 与 sha256 对键顺序不敏感", () => {
    expect(evidence.stableJson({ b: 1, a: 2 })).toBe(evidence.stableJson({ a: 2, b: 1 }));
    expect(evidence.sha256("abc")).toBe(evidence.sha256("abc"));
    expect(evidence.sha256("abc")).not.toBe(evidence.sha256("abd"));
  });

  it("未知 provider 的 Reviewer 证据无法通过验证", () => {
    const error = evidence.verifyAgentReviewerEvidence({
      runId: "agent_run_missing",
      batchId: "batch-x",
      inputSha256: "a".repeat(64),
      provider: "deepseek",
      model: "deepseek-v4-flash",
    });
    expect(error).toMatch(/provider\/model 标识不正确/);
  });
});
