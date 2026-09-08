import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getDbReady, withDbTransaction } from "@db/client";
import {
  companionMemories,
  aiJobs,
  expressionVariants,
  learningEvents,
  learningSessions,
  retrievalAttempts,
} from "@db/schema";
import { enqueueAiJob, runSingleAiJob } from "@/lib/ai/job-service";
import { createAiProvider } from "@/lib/ai/provider-factory";
import { safeErrorSummary } from "@/lib/ai/errors";
import { runtimeAnswerMockResolver } from "@/lib/answers/runtime-mock";
import { applyLearningOutcome, type LearningOutcomeMetrics } from "./progress";
import {
  expressionVariantReviewOutputSchema,
  normalizeRetrievalExpression,
  RETRIEVAL_JUDGE_PROMPT_VERSION,
  retrievalJudgeOutputSchema,
  type RetrievalJudgeOutput,
  VARIANT_REVIEW_PROMPT_VERSION,
} from "./retrieval-contracts";
import { loadRetrievalLearningContent, type RetrievalLearningContent, type RetrievalScene } from "./retrieval-content";
import { LearningSessionError } from "./errors";
import { refreshGapOutputMastery } from "./gap-mastery";
import type { LearningEvent, LearningSessionView, LearningStep, RetrievalVerdict, SessionMeta } from "./types";

type SessionRow = typeof learningSessions.$inferSelect;
type RetrievalStepName =
  | "retrieval_prompt"
  | "retrieval_judgement"
  | "comparison"
  | "adaptive_instruction"
  | "active_recall"
  | "transfer_recall"
  | "review_prompt"
  | "review_judgement"
  | "repair_instruction"
  | "repair_recall"
  | "transfer_retry"
  | "outcome"
  | "scheduled";

interface StoredJudgement {
  attemptId: string;
  phase: "initial" | "active_recall" | "transfer" | "review" | "repair_recall" | "transfer_retry";
  status: "judging" | "completed" | "failed";
  userExpression: string;
  normalizedInput: string;
  route: "pending" | "exact" | "approved_variant" | "cache" | "ai" | "unknown";
  verdict: RetrievalVerdict;
  explanationZh: string;
  registerDifference: string;
  frequencyDifference: string;
  proposedVariant: { expression: string; contextConstraintZh: string } | null;
  error: string;
  aiJobId: string | null;
  aiRunId: string | null;
}

interface RetrievalState {
  judgement: StoredJudgement | null;
  initialVerdict: RetrievalVerdict | null;
  initialFailed: boolean;
  transferFailed: boolean;
  activeRecallPassed: boolean;
  transferPassed: boolean;
  assistanceLevel: number;
  feedbackZh: string | null;
  outcomeRating: "again" | "hard" | "good" | "easy" | null;
  independent: boolean;
}

const storedJudgementSchema = z.object({
  attemptId: z.string(),
  phase: z.enum(["initial", "active_recall", "transfer", "review", "repair_recall", "transfer_retry"]),
  status: z.enum(["judging", "completed", "failed"]),
  userExpression: z.string(),
  normalizedInput: z.string(),
  route: z.enum(["pending", "exact", "approved_variant", "cache", "ai", "unknown"]),
  verdict: z.enum(["natural_equivalent", "context_difference", "incorrect", "uncertain", "unknown"]),
  explanationZh: z.string(),
  registerDifference: z.string(),
  frequencyDifference: z.string(),
  proposedVariant: z.object({ expression: z.string(), contextConstraintZh: z.string() }).nullable(),
  error: z.string(),
  aiJobId: z.string().nullable(),
  aiRunId: z.string().nullable(),
});

const retrievalStateSchema = z.object({
  judgement: storedJudgementSchema.nullable().default(null),
  initialVerdict: z.enum(["natural_equivalent", "context_difference", "incorrect", "uncertain", "unknown"]).nullable().default(null),
  initialFailed: z.boolean().default(false),
  transferFailed: z.boolean().default(false),
  activeRecallPassed: z.boolean().default(false),
  transferPassed: z.boolean().default(false),
  assistanceLevel: z.number().int().min(0).max(4).default(0),
  feedbackZh: z.string().nullable().default(null),
  outcomeRating: z.enum(["again", "hard", "good", "easy"]).nullable().default(null),
  independent: z.boolean().default(false),
});

function emptyRetrievalState(): RetrievalState {
  return retrievalStateSchema.parse({});
}

function parseState(value: string): RetrievalState {
  return retrievalStateSchema.parse(JSON.parse(value || "{}"));
}

function readPrompt(filename: string) {
  return fs.readFileSync(path.join(process.cwd(), "pipeline", "prompts", filename), "utf8");
}

function stableId(prefix: string, ...parts: string[]) {
  return `${prefix}_${createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 24)}`;
}

function todayInShanghai(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function queueOf(row: SessionRow) {
  return z.array(z.string()).parse(JSON.parse(row.queueJson));
}

function meta(row: SessionRow): SessionMeta {
  const queue = queueOf(row);
  return {
    sessionId: row.id,
    stepVersion: row.stepVersion,
    current: Math.min(row.currentIndex + 1, queue.length),
    total: queue.length,
    remaining: Math.max(0, queue.length - row.currentIndex - 1),
  };
}

function scenePrompt(scene: RetrievalScene, content: RetrievalLearningContent) {
  return {
    id: scene.id,
    settingZh: scene.settingZh,
    relationshipZh: scene.relationshipZh,
    purposeZh: scene.purposeZh,
    promptZh: scene.promptZh,
    intentZh: content.gap.intentZh,
  };
}

function inputHint() {
  return "Windows 可按 Win + H；手机可用输入法麦克风。应用不会请求录音权限。" as const;
}

function assistText(level: number, content: RetrievalLearningContent): string | null {
  if (level <= 0) return null;
  if (level === 1) return `用途提示：${content.gap.intentZh}`;
  if (level === 2) return content.base.chunk.pattern
    ? `结构槽位：${content.base.chunk.pattern}`
    : `结构提示：先想核心动作，再补充对象或情境。`;
  const words = content.gap.recommendedExpression.split(/\s+/).filter(Boolean);
  if (level === 3) return `部分表达：${words.slice(0, Math.max(1, Math.ceil(words.length / 2))).join(" ")} …`;
  return `完整答案：${content.gap.recommendedExpression}`;
}

function isPassing(verdict: RetrievalVerdict) {
  return verdict === "natural_equivalent";
}

function instructionNext(row: SessionRow, state: RetrievalState): "active_recall" | "transfer_recall" | "repair_recall" {
  if (row.mode === "review") return "repair_recall";
  return isPassing(state.initialVerdict ?? "unknown") ? "transfer_recall" : "active_recall";
}

export async function buildRetrievalStep(row: SessionRow): Promise<LearningStep> {
  const queue = queueOf(row);
  if (row.status === "completed" || row.currentIndex >= queue.length) {
    return { type: "complete", sessionId: row.id, total: queue.length, completed: Math.min(row.currentIndex, queue.length), message: "这一组 Gap 已完成。" };
  }
  const content = await loadRetrievalLearningContent(queue[row.currentIndex], row.scopeId);
  if (!content) throw new LearningSessionError("这个实验学习项缺少已审核的 Gap 或双语境", 409, "retrieval_content_unavailable");
  const state = parseState(row.stateJson);
  const common: SessionMeta = {
    ...meta(row),
    gapId: content.gap.id,
    chunkId: content.base.chunk.id,
    questionId: content.question.id,
  };

  if (row.step === "retrieval_prompt" || row.step === "review_prompt") {
    return { ...common, type: row.step, scene: scenePrompt(content.originalScene, content), inputHint: inputHint(), allowUnknown: true };
  }
  if (row.step === "retrieval_judgement" || row.step === "review_judgement") {
    const judgement = state.judgement;
    if (!judgement) throw new LearningSessionError("提取判定状态缺失", 500, "corrupt_session");
    return {
      ...common,
      type: row.step,
      status: judgement.status === "failed" ? "failed" : "judging",
      userExpression: judgement.userExpression,
      message: judgement.status === "failed" ? judgement.error : "Chloe 正在判断意思、自然度和场景是否匹配…",
      canRetry: judgement.status === "failed",
      canViewInstruction: judgement.status === "failed",
    };
  }
  if (row.step === "comparison") {
    const judgement = state.judgement;
    if (!judgement || judgement.status !== "completed") throw new LearningSessionError("表达对照缺少判定结果", 500, "corrupt_session");
    return {
      ...common,
      type: "comparison",
      verdict: judgement.verdict,
      userExpression: judgement.userExpression || null,
      recommendedExpression: content.gap.recommendedExpression,
      explanationZh: judgement.explanationZh,
      registerDifference: judgement.registerDifference,
      frequencyDifference: judgement.frequencyDifference,
      detailCollapsed: isPassing(judgement.verdict),
      accent: "en-US",
    };
  }
  if (row.step === "adaptive_instruction" || row.step === "repair_instruction") {
    const next = instructionNext(row, state);
    return {
      ...common,
      type: row.step,
      detailMode: isPassing(state.initialVerdict ?? "unknown") ? "compact" : "expanded",
      chunk: {
        id: content.base.chunk.id,
        display: content.base.chunk.display,
        meaningZh: content.base.chunk.meaningZh,
        ipa: content.base.chunk.ipa,
        accent: content.base.chunk.accent,
        pattern: content.base.chunk.pattern,
      },
      keyExplanationZh: content.gap.explanationZh,
      commonMistake: content.gap.evidenceText,
      originalScene: { ...scenePrompt(content.originalScene, content), targetTextEn: content.originalScene.targetTextEn, targetTextZh: content.originalScene.targetTextZh },
      transferScene: { ...scenePrompt(content.transferScene, content), targetTextEn: content.transferScene.targetTextEn, targetTextZh: content.transferScene.targetTextZh },
      shadowingOptional: true,
      next,
    };
  }
  if (["active_recall", "transfer_recall", "repair_recall", "transfer_retry"].includes(row.step)) {
    const transfer = row.step === "transfer_recall" || row.step === "transfer_retry";
    return {
      ...common,
      type: row.step as "active_recall" | "transfer_recall" | "repair_recall" | "transfer_retry",
      scene: scenePrompt(transfer ? content.transferScene : content.originalScene, content),
      assistLevel: state.assistanceLevel as 0 | 1 | 2 | 3 | 4,
      assistText: assistText(state.assistanceLevel, content),
      feedbackZh: state.feedbackZh,
      allowUnknown: true,
      inputHint: inputHint(),
    };
  }
  if (row.step === "outcome") {
    if (!state.outcomeRating) throw new LearningSessionError("提取结果尚未结算", 500, "corrupt_session");
    const labels = {
      again: ["需要尽快再提取", "这次是在看过教学或经历错误后说对；系统会尽快让它再次出现。"],
      hard: ["已经提取出来", "这轮使用了提示；系统会安排较近的复习。"],
      good: ["这次能独立表达", "原场景和迁移场景都能独立提取，已经进入复习调度。"],
      easy: ["到期复习快速通过", "没有先看答案，也没有使用提示；这次复习已快速结算。"],
    } as const;
    const copy = labels[state.outcomeRating];
    return {
      ...common,
      type: "outcome",
      result: {
        rating: state.outcomeRating,
        label: copy[0],
        message: copy[1],
        errors: Number(state.initialFailed) + Number(state.transferFailed),
        assists: state.assistanceLevel,
        shadowingAttempts: 0,
        retrievalSummary: {
          initialVerdict: state.initialVerdict ?? "unknown",
          transferPassed: state.transferPassed,
          assistanceLevel: state.assistanceLevel,
          independent: state.independent,
        },
      },
    };
  }
  if (row.step === "scheduled") {
    if (!state.outcomeRating) throw new LearningSessionError("复习安排缺少结算结果", 500, "corrupt_session");
    return {
      ...common,
      type: "scheduled",
      result: {
        rating: state.outcomeRating,
        label: "已安排下一次提取",
        message: "FSRS 决定何时再见；本轮提取证据决定下次是快速测试还是先修复。",
        errors: Number(state.initialFailed) + Number(state.transferFailed),
        assists: state.assistanceLevel,
        shadowingAttempts: 0,
      },
      nextAction: row.currentIndex + 1 < queue.length ? "next_item" : "complete_session",
    };
  }
  throw new LearningSessionError(`未知 V3 学习步骤：${row.step}`, 500, "corrupt_session");
}

export async function toRetrievalView(row: SessionRow): Promise<LearningSessionView> {
  return {
    id: row.id,
    status: row.status === "completed" ? "completed" : "active",
    mode: row.mode === "review" ? "review" : "learn",
    experienceVersion: "gap_retrieval_v3",
    step: await buildRetrievalStep(row),
  };
}

async function loadRow(sessionId: string): Promise<SessionRow> {
  const db = await getDbReady();
  const [row] = await db.select().from(learningSessions).where(eq(learningSessions.id, sessionId)).limit(1);
  if (!row) throw new LearningSessionError("学习会话不存在", 404, "session_not_found");
  if (row.experienceVersion !== "gap_retrieval_v3") throw new LearningSessionError("会话不是 V3 提取实验", 409, "experience_mismatch");
  return row;
}

async function persistStep(row: SessionRow, step: RetrievalStepName, state: RetrievalState, options: { currentIndex?: number; status?: string } = {}) {
  const db = await getDbReady();
  const now = new Date().toISOString();
  const updated = await db.update(learningSessions).set({
    step,
    stepVersion: row.stepVersion + 1,
    stateJson: JSON.stringify(state),
    currentIndex: options.currentIndex ?? row.currentIndex,
    status: options.status ?? row.status,
    lastEventAt: now,
    updatedAt: now,
  }).where(and(eq(learningSessions.id, row.id), eq(learningSessions.stepVersion, row.stepVersion), eq(learningSessions.status, row.status))).returning({ id: learningSessions.id });
  if (!updated.length) throw new LearningSessionError("学习状态已经变化，请刷新后继续", 409, "event_conflict");
}

function phaseForStep(step: string): StoredJudgement["phase"] {
  if (step === "active_recall") return "active_recall";
  if (step === "transfer_recall") return "transfer";
  if (step === "review_prompt") return "review";
  if (step === "repair_recall") return "repair_recall";
  if (step === "transfer_retry") return "transfer_retry";
  return "initial";
}

function judgementStep(row: SessionRow) {
  return row.mode === "review" ? "review_judgement" as const : "retrieval_judgement" as const;
}

async function approvedVariants(content: RetrievalLearningContent): Promise<string[]> {
  const db = await getDbReady();
  const rows = await db.select({ expression: expressionVariants.expression }).from(expressionVariants).where(and(
    eq(expressionVariants.scopeKey, `gap:${content.gap.id}`),
    eq(expressionVariants.reviewDecision, "approved"),
    eq(expressionVariants.active, true),
  ));
  return rows.map((row) => row.expression);
}

function localOutput(content: RetrievalLearningContent, explanationZh: string): RetrievalJudgeOutput {
  return {
    verdict: "natural_equivalent",
    meaningPreserved: true,
    naturalness: "natural",
    registerDifference: "",
    frequencyDifference: "",
    explanationZh,
    recommendedExpression: content.gap.recommendedExpression,
    proposedVariant: null,
    glossary: [],
  };
}

async function evaluateExpression(content: RetrievalLearningContent, judgement: StoredJudgement) {
  const normalizedTarget = normalizeRetrievalExpression(content.gap.recommendedExpression);
  const normalizedChunk = normalizeRetrievalExpression(content.base.chunk.display);
  if ([normalizedTarget, normalizedChunk].includes(judgement.normalizedInput)) {
    return { output: localOutput(content, "你已经准确、自然地表达了这个意思。"), route: "exact" as const, aiJobId: null, aiRunId: null };
  }
  const variants = await approvedVariants(content);
  if (variants.some((item) => normalizeRetrievalExpression(item) === judgement.normalizedInput)) {
    return { output: localOutput(content, "这是已经审核通过、适合当前场景的个人表达变体。"), route: "approved_variant" as const, aiJobId: null, aiRunId: null };
  }
  const db = await getDbReady();
  const cached = await db.select().from(retrievalAttempts).where(and(
    eq(retrievalAttempts.chunkId, content.base.chunk.id),
    eq(retrievalAttempts.gapId, content.gap.id),
    eq(retrievalAttempts.cueHash, judgement.phase.includes("transfer") ? content.transferScene.id : content.originalScene.id),
    eq(retrievalAttempts.normalizedInput, judgement.normalizedInput),
    eq(retrievalAttempts.judgePromptVersion, RETRIEVAL_JUDGE_PROMPT_VERSION),
    sql`${retrievalAttempts.verdict} IN ('natural_equivalent','context_difference','incorrect','uncertain')`,
  )).orderBy(desc(retrievalAttempts.createdAt)).limit(1);
  if (cached[0] && cached[0].id !== judgement.attemptId) {
    const parsed = retrievalJudgeOutputSchema.safeParse(JSON.parse(cached[0].feedbackJson || "{}"));
    if (parsed.success) return { output: parsed.data, route: "cache" as const, aiJobId: cached[0].aiJobId, aiRunId: cached[0].aiRunId };
  }

  const payload = {
    intentZh: content.gap.intentZh,
    relationshipZh: judgement.phase.includes("transfer") ? content.transferScene.relationshipZh : content.originalScene.relationshipZh,
    settingZh: judgement.phase.includes("transfer") ? content.transferScene.settingZh : content.originalScene.settingZh,
    purposeZh: judgement.phase.includes("transfer") ? content.transferScene.purposeZh : content.originalScene.purposeZh,
    recommendedExpression: content.gap.recommendedExpression,
    applicability: { register: "natural spoken English", accent: "en-US" },
    userInput: judgement.userExpression,
    approvedVariants: variants,
  };
  const job = await enqueueAiJob({
    kind: "gap_retrieval_judgement",
    targetType: "retrieval_attempt",
    targetId: judgement.attemptId,
    payload,
    promptVersion: RETRIEVAL_JUDGE_PROMPT_VERSION,
    schemaVersion: "gap-retrieval-judge-v1",
  });
  const result = await runSingleAiJob({
    jobId: job.id,
    provider: createAiProvider({ mockResolver: runtimeAnswerMockResolver }),
    request: {
      role: "retrieval_judge",
      instructions: readPrompt("gap_retrieval.judge.v1.md"),
      input: JSON.stringify(payload),
      schema: retrievalJudgeOutputSchema,
      schemaName: "gap_retrieval_judge_v1",
      promptVersion: RETRIEVAL_JUDGE_PROMPT_VERSION,
      schemaVersion: "gap-retrieval-judge-v1",
      idempotencyKey: job.idempotencyKey,
    },
  });
  return { output: result.data, route: "ai" as const, aiJobId: job.id, aiRunId: result.runId };
}

async function reviewProposedVariant(content: RetrievalLearningContent, attemptId: string, candidate: { expression: string; contextConstraintZh: string }) {
  const normalized = normalizeRetrievalExpression(candidate.expression);
  if (!normalized) return;
  const db = await getDbReady();
  const variantId = stableId("variant", content.gap.id, normalized);
  await db.insert(expressionVariants).values({
    id: variantId,
    scopeKey: `gap:${content.gap.id}`,
    chunkId: content.base.chunk.id,
    gapClusterId: content.gap.clusterId,
    expression: candidate.expression,
    normalizedExpression: normalized,
    contextConstraintsJson: JSON.stringify({ candidate: candidate.contextConstraintZh }),
    sourceAttemptId: attemptId,
  }).onConflictDoNothing();
  const payload = {
    intentZh: content.gap.intentZh,
    scene: {
      settingZh: content.originalScene.settingZh,
      relationshipZh: content.originalScene.relationshipZh,
      purposeZh: content.originalScene.purposeZh,
    },
    recommendedExpression: content.gap.recommendedExpression,
    candidateExpression: candidate.expression,
    candidateContextConstraintZh: candidate.contextConstraintZh,
  };
  const job = await enqueueAiJob({
    kind: "expression_variant_review",
    targetType: "expression_variant",
    targetId: variantId,
    payload,
    promptVersion: VARIANT_REVIEW_PROMPT_VERSION,
    schemaVersion: "expression-variant-reviewer-v1",
  });
  try {
    const result = await runSingleAiJob({
      jobId: job.id,
      provider: createAiProvider({ mockResolver: runtimeAnswerMockResolver }),
      request: {
        role: "variant_reviewer",
        instructions: readPrompt("expression_variant.reviewer.v1.md"),
        input: JSON.stringify(payload),
        schema: expressionVariantReviewOutputSchema,
        schemaName: "expression_variant_reviewer_v1",
        promptVersion: VARIANT_REVIEW_PROMPT_VERSION,
        schemaVersion: "expression-variant-reviewer-v1",
        idempotencyKey: job.idempotencyKey,
      },
    });
    await db.update(expressionVariants).set({
      expression: result.data.expression,
      normalizedExpression: normalizeRetrievalExpression(result.data.expression),
      relation: result.data.relation,
      register: result.data.register,
      frequencyRelation: result.data.frequencyRelation,
      contextConstraintsJson: JSON.stringify({ zh: result.data.contextConstraintZh }),
      reviewDecision: result.data.verdict === "approved" && result.data.canUseForLocalMatch ? "approved" : result.data.verdict,
      reviewReason: result.data.reasonZh,
      reviewerRunId: result.runId,
      active: result.data.canUseForLocalMatch,
      updatedAt: new Date().toISOString(),
    }).where(eq(expressionVariants.id, variantId));
  } catch (error) {
    await db.update(expressionVariants).set({
      reviewReason: `Reviewer 暂未完成：${safeErrorSummary(error)}`,
      updatedAt: new Date().toISOString(),
    }).where(eq(expressionVariants.id, variantId));
  }
}

async function settle(row: SessionRow, content: RetrievalLearningContent, state: RetrievalState) {
  let rating: "again" | "hard" | "good" | "easy";
  if (row.mode === "review" && state.independent && !state.initialFailed && state.assistanceLevel === 0) rating = "easy";
  else if (state.initialFailed || state.transferFailed || state.initialVerdict === "unknown" || state.initialVerdict === "incorrect") rating = "again";
  else if (state.assistanceLevel > 0 || state.initialVerdict === "context_difference" || state.initialVerdict === "uncertain") rating = "hard";
  else rating = "good";
  state.outcomeRating = rating;
  const storedAttempts = await (await getDbReady()).select().from(retrievalAttempts).where(eq(retrievalAttempts.sessionId, row.id));
  // 当前 Judge 结果会在结算后持久化；这里先覆盖内存中的 pending 行，避免漏算本轮最后一次正确提取。
  const attempts = storedAttempts.map((attempt) => attempt.id === state.judgement?.attemptId
    ? { ...attempt, verdict: state.judgement.verdict, judgementRoute: state.judgement.route }
    : attempt);
  const metrics: LearningOutcomeMetrics = {
    sessionId: row.id,
    comprehension: state.initialFailed ? "not_understood" : state.assistanceLevel ? "unsure" : "understood",
    errors: attempts.filter((attempt) => ["incorrect", "context_difference", "unknown"].includes(attempt.verdict)).length,
    assists: state.assistanceLevel,
    shadowingAttempts: 0,
    microphoneMode: "recorded",
    skills: {
      retrieval: {
        attempts: attempts.length,
        correct: attempts.filter((attempt) => attempt.verdict === "natural_equivalent").length,
        assists: state.assistanceLevel,
      },
      transfer: {
        attempts: attempts.filter((attempt) => attempt.phase.includes("transfer")).length,
        correct: attempts.filter((attempt) => attempt.phase.includes("transfer") && attempt.verdict === "natural_equivalent").length,
        assists: state.assistanceLevel,
      },
    },
  };
  await applyLearningOutcome(content.base.chunk.id, rating, metrics);
  const source = attempts.at(-1);
  if (source) {
    const db = await getDbReady();
    await db.insert(companionMemories).values({
      id: stableId("memory", "learning", row.id, content.base.chunk.id),
      category: "learning",
      summary: `正在学习“${content.base.chunk.display}”；最近提取结果为 ${rating}。`,
      detailJson: JSON.stringify({ chunkId: content.base.chunk.id, gapId: content.gap.id, rating, assistanceLevel: state.assistanceLevel }),
      scopeType: "gap",
      scopeId: content.gap.id,
      confidence: 1,
      sourceType: "retrieval_attempt",
      sourceId: source.id,
      evidenceJson: JSON.stringify(attempts.map((attempt) => attempt.id)),
    }).onConflictDoNothing();
    await db.run(sql`UPDATE answer_gaps SET status='learning',updated_at=${new Date().toISOString()} WHERE id=${content.gap.id} AND status='open'`);
  }
}

async function finishJudgement(sessionId: string, judgement: StoredJudgement, evaluated: Awaited<ReturnType<typeof evaluateExpression>>) {
  const row = await loadRow(sessionId);
  const state = parseState(row.stateJson);
  if (state.judgement?.attemptId !== judgement.attemptId || state.judgement.status !== "judging") return;
  state.judgement = {
    ...judgement,
    status: "completed",
    route: evaluated.route,
    verdict: evaluated.output.verdict,
    explanationZh: evaluated.output.explanationZh,
    registerDifference: evaluated.output.registerDifference,
    frequencyDifference: evaluated.output.frequencyDifference,
    proposedVariant: evaluated.output.proposedVariant,
    aiJobId: evaluated.aiJobId,
    aiRunId: evaluated.aiRunId,
  };
  if (judgement.phase === "initial" || judgement.phase === "review") {
    state.initialVerdict = evaluated.output.verdict;
    state.initialFailed = !isPassing(evaluated.output.verdict);
  }
  const passing = isPassing(evaluated.output.verdict);
  let next: RetrievalStepName = "comparison";
  let settledGapId: string | null = null;
  if (judgement.phase === "review") {
    if (passing) {
      state.independent = true;
      state.transferPassed = true;
      const content = await loadRetrievalLearningContent(queueOf(row)[row.currentIndex], row.scopeId);
      if (!content) throw new LearningSessionError("复习材料不可用", 409, "retrieval_content_unavailable");
      await settle(row, content, state);
      settledGapId = content.gap.id;
      next = "outcome";
    } else next = "repair_instruction";
  } else if (judgement.phase === "active_recall") {
    if (passing) {
      state.activeRecallPassed = true;
      state.feedbackZh = null;
      next = "transfer_recall";
    } else {
      state.initialFailed = true;
      state.feedbackZh = evaluated.output.explanationZh;
      next = "active_recall";
    }
  } else if (judgement.phase === "repair_recall") {
    if (passing) {
      state.activeRecallPassed = true;
      state.feedbackZh = null;
      next = "transfer_retry";
    } else {
      state.feedbackZh = evaluated.output.explanationZh;
      next = "repair_recall";
    }
  } else if (judgement.phase === "transfer" || judgement.phase === "transfer_retry") {
    if (passing) {
      state.transferPassed = true;
      state.feedbackZh = null;
      const content = await loadRetrievalLearningContent(queueOf(row)[row.currentIndex], row.scopeId);
      if (!content) throw new LearningSessionError("迁移材料不可用", 409, "retrieval_content_unavailable");
      state.independent = !state.initialFailed && !state.transferFailed && state.assistanceLevel === 0;
      await settle(row, content, state);
      settledGapId = content.gap.id;
      next = "outcome";
    } else {
      state.transferFailed = true;
      state.feedbackZh = evaluated.output.explanationZh;
      next = judgement.phase === "transfer_retry" ? "transfer_retry" : "transfer_recall";
    }
  }
  const db = await getDbReady();
  await db.update(retrievalAttempts).set({
    judgementRoute: evaluated.route,
    verdict: evaluated.output.verdict,
    feedbackJson: JSON.stringify(evaluated.output),
    aiJobId: evaluated.aiJobId,
    aiRunId: evaluated.aiRunId,
  }).where(eq(retrievalAttempts.id, judgement.attemptId));
  await persistStep(row, next, state);
  if (settledGapId) await refreshGapOutputMastery(settledGapId);
  const content = await loadRetrievalLearningContent(queueOf(row)[row.currentIndex], row.scopeId);
  if (content && evaluated.output.proposedVariant && evaluated.output.verdict === "natural_equivalent") {
    await reviewProposedVariant(content, judgement.attemptId, evaluated.output.proposedVariant);
  }
}

async function failJudgement(sessionId: string, judgement: StoredJudgement, error: unknown) {
  const row = await loadRow(sessionId);
  const state = parseState(row.stateJson);
  if (state.judgement?.attemptId !== judgement.attemptId || state.judgement.status !== "judging") return;
  const message = `判定服务暂时不可用：${safeErrorSummary(error)}。这次不会被判错。`;
  const db = await getDbReady();
  const [job] = await db.select({ id: aiJobs.id }).from(aiJobs).where(and(
    eq(aiJobs.targetType, "retrieval_attempt"),
    eq(aiJobs.targetId, judgement.attemptId),
  )).orderBy(desc(aiJobs.updatedAt)).limit(1);
  state.judgement = { ...state.judgement, status: "failed", verdict: "uncertain", error: message, aiJobId: job?.id ?? null };
  await db.update(retrievalAttempts).set({ judgementRoute: "ai", verdict: "unjudged", feedbackJson: JSON.stringify({ error: message }), aiJobId: job?.id ?? null }).where(eq(retrievalAttempts.id, judgement.attemptId));
  await persistStep(row, judgementStep(row), state);
}

async function beginJudgement(row: SessionRow, event: Extract<LearningEvent, { type: "submit_retrieval" | "submit_transfer" }>) {
  const phase = phaseForStep(row.step);
  const userExpression = event.input.trim();
  const normalizedInput = normalizeRetrievalExpression(userExpression);
  const queue = queueOf(row);
  const content = await loadRetrievalLearningContent(queue[row.currentIndex], row.scopeId);
  if (!content) throw new LearningSessionError("当前提取材料不可用", 409, "retrieval_content_unavailable");
  const transfer = phase === "transfer" || phase === "transfer_retry";
  const attemptId = stableId("retrieval", row.id, event.clientEventId);
  const judgement: StoredJudgement = {
    attemptId,
    phase,
    status: "judging",
    userExpression,
    normalizedInput,
    route: "pending",
    verdict: "uncertain",
    explanationZh: "",
    registerDifference: "",
    frequencyDifference: "",
    proposedVariant: null,
    error: "",
    aiJobId: null,
    aiRunId: null,
  };
  await withDbTransaction(async () => {
    const db = await getDbReady();
    const state = parseState(row.stateJson);
    state.judgement = judgement;
    await db.insert(retrievalAttempts).values({
      id: attemptId,
      sessionId: row.id,
      learningUnitId: content.learningUnitId,
      gapId: content.gap.id,
      chunkId: content.base.chunk.id,
      questionId: content.question.id,
      phase,
      cueId: transfer ? content.transferScene.id : content.originalScene.id,
      cueHash: transfer ? content.transferScene.id : content.originalScene.id,
      rawInput: userExpression,
      normalizedInput,
      judgementRoute: "pending",
      verdict: "pending",
      assistanceLevel: state.assistanceLevel,
      clientEventId: event.clientEventId,
      localDate: todayInShanghai(),
    });
    await db.insert(learningEvents).values({ id: randomUUID(), clientEventId: event.clientEventId, sessionId: row.id, eventType: event.type, payloadJson: JSON.stringify(event) });
    await persistStep(row, judgementStep(row), state);
  });
  try {
    await finishJudgement(row.id, judgement, await evaluateExpression(content, judgement));
  } catch (error) {
    await failJudgement(row.id, judgement, error);
  }
}

async function markUnknown(row: SessionRow, event: Extract<LearningEvent, { type: "mark_unknown" }>) {
  const phase = phaseForStep(row.step);
  const content = await loadRetrievalLearningContent(queueOf(row)[row.currentIndex], row.scopeId);
  if (!content) throw new LearningSessionError("当前提取材料不可用", 409, "retrieval_content_unavailable");
  const state = parseState(row.stateJson);
  const attemptId = stableId("retrieval", row.id, event.clientEventId);
  const judgement: StoredJudgement = {
    attemptId,
    phase,
    status: "completed",
    userExpression: "",
    normalizedInput: "",
    route: "unknown",
    verdict: "unknown",
    explanationZh: "这次还无法从中文意图提取出英文；先看最小必要教学，再马上重新提取。",
    registerDifference: "",
    frequencyDifference: "",
    proposedVariant: null,
    error: "",
    aiJobId: null,
    aiRunId: null,
  };
  state.judgement = judgement;
  state.initialFailed = true;
  if (phase === "initial" || phase === "review") state.initialVerdict = "unknown";
  if (phase.includes("transfer")) state.transferFailed = true;
  state.feedbackZh = judgement.explanationZh;
  const next: RetrievalStepName = phase === "review" ? "repair_instruction"
    : phase === "initial" ? "comparison"
      : phase === "active_recall" ? "active_recall"
        : phase === "repair_recall" ? "repair_recall"
          : phase === "transfer_retry" ? "transfer_retry" : "transfer_recall";
  await withDbTransaction(async () => {
    const db = await getDbReady();
    await db.insert(retrievalAttempts).values({
      id: attemptId,
      sessionId: row.id,
      learningUnitId: content.learningUnitId,
      gapId: content.gap.id,
      chunkId: content.base.chunk.id,
      questionId: content.question.id,
      phase,
      cueId: phase.includes("transfer") ? content.transferScene.id : content.originalScene.id,
      cueHash: phase.includes("transfer") ? content.transferScene.id : content.originalScene.id,
      rawInput: "",
      normalizedInput: "",
      judgementRoute: "unknown",
      verdict: "unknown",
      assistanceLevel: state.assistanceLevel,
      feedbackJson: JSON.stringify({ explanationZh: judgement.explanationZh }),
      clientEventId: event.clientEventId,
      localDate: todayInShanghai(),
    });
    await db.insert(learningEvents).values({ id: randomUUID(), clientEventId: event.clientEventId, sessionId: row.id, eventType: event.type, payloadJson: JSON.stringify(event) });
    await persistStep(row, next, state);
  });
}

async function persistSimpleEvent(row: SessionRow, event: LearningEvent, next: RetrievalStepName, state: RetrievalState, options: { currentIndex?: number; status?: string } = {}) {
  await withDbTransaction(async () => {
    const db = await getDbReady();
    await db.insert(learningEvents).values({ id: randomUUID(), clientEventId: event.clientEventId, sessionId: row.id, eventType: event.type, payloadJson: JSON.stringify(event) });
    await persistStep(row, next, state, options);
  });
}

export async function applyRetrievalSessionEvent(sessionId: string, event: LearningEvent): Promise<LearningSessionView> {
  const db = await getDbReady();
  const duplicate = await db.select().from(learningEvents).where(eq(learningEvents.clientEventId, event.clientEventId)).limit(1);
  if (duplicate[0]) {
    if (duplicate[0].sessionId !== sessionId) throw new LearningSessionError("clientEventId 已被其他会话使用", 409, "event_conflict");
    return toRetrievalView(await loadRow(sessionId));
  }
  const row = await loadRow(sessionId);
  if (row.status !== "active") throw new LearningSessionError("会话已经结束", 409, "session_completed");
  if (event.stepVersion !== undefined && event.stepVersion !== row.stepVersion) return toRetrievalView(row);
  const state = parseState(row.stateJson);

  if (event.type === "submit_retrieval" || event.type === "submit_transfer") {
    const allowed = event.type === "submit_transfer" ? ["transfer_recall", "transfer_retry"] : ["retrieval_prompt", "review_prompt", "active_recall", "repair_recall"];
    if (!allowed.includes(row.step)) throw new LearningSessionError(`事件 ${event.type} 不能用于步骤 ${row.step}`, 409, "invalid_transition");
    await beginJudgement(row, event);
  } else if (event.type === "mark_unknown") {
    if (!["retrieval_prompt", "review_prompt", "active_recall", "repair_recall", "transfer_recall", "transfer_retry"].includes(row.step)) {
      throw new LearningSessionError(`事件 ${event.type} 不能用于步骤 ${row.step}`, 409, "invalid_transition");
    }
    await markUnknown(row, event);
  } else if (event.type === "retry_judgement") {
    if (!["retrieval_judgement", "review_judgement"].includes(row.step) || state.judgement?.status !== "failed") {
      throw new LearningSessionError("当前没有可重试的表达判定", 409, "invalid_transition");
    }
    const content = await loadRetrievalLearningContent(queueOf(row)[row.currentIndex], row.scopeId);
    if (!content) throw new LearningSessionError("当前提取材料不可用", 409, "retrieval_content_unavailable");
    state.judgement.status = "judging";
    state.judgement.error = "";
    await persistSimpleEvent(row, event, judgementStep(row), state);
    const pendingRow = await loadRow(sessionId);
    const pending = parseState(pendingRow.stateJson).judgement!;
    try { await finishJudgement(sessionId, pending, await evaluateExpression(content, pending)); }
    catch (error) { await failJudgement(sessionId, pending, error); }
  } else if (event.type === "continue_comparison") {
    if (row.step !== "comparison") throw new LearningSessionError("当前不能进入教学", 409, "invalid_transition");
    await persistSimpleEvent(row, event, "adaptive_instruction", state);
  } else if (event.type === "continue_instruction" || event.type === "continue_transfer") {
    if (["retrieval_judgement", "review_judgement"].includes(row.step) && state.judgement?.status === "failed") {
      state.initialVerdict = "uncertain";
      state.initialFailed = true;
      await persistSimpleEvent(row, event, row.mode === "review" ? "repair_instruction" : "adaptive_instruction", state);
    } else {
      if (!["adaptive_instruction", "repair_instruction"].includes(row.step)) throw new LearningSessionError("当前不能进入下一次提取", 409, "invalid_transition");
      state.feedbackZh = null;
      await persistSimpleEvent(row, event, instructionNext(row, state), state);
    }
  } else if (event.type === "request_assist") {
    if (!["active_recall", "repair_recall", "transfer_recall", "transfer_retry"].includes(row.step)) {
      throw new LearningSessionError("当前步骤不能请求提取提示", 409, "invalid_transition");
    }
    state.assistanceLevel = Math.min(4, state.assistanceLevel + 1);
    await persistSimpleEvent(row, event, row.step as RetrievalStepName, state);
  } else if (event.type === "continue_outcome") {
    if (row.step !== "outcome") throw new LearningSessionError("当前不能保存复习安排", 409, "invalid_transition");
    await persistSimpleEvent(row, event, "scheduled", state);
  } else if (event.type === "continue_scheduled") {
    if (row.step !== "scheduled") throw new LearningSessionError("当前不能进入下一个 Gap", 409, "invalid_transition");
    const queue = queueOf(row);
    const nextIndex = row.currentIndex + 1;
    const nextStep = row.mode === "review" ? "review_prompt" : "retrieval_prompt";
    await persistSimpleEvent(row, event, nextStep, emptyRetrievalState(), {
      currentIndex: nextIndex,
      status: nextIndex >= queue.length ? "completed" : "active",
    });
  } else {
    throw new LearningSessionError(`事件 ${event.type} 不属于 V3 提取流程`, 409, "invalid_transition");
  }
  return toRetrievalView(await loadRow(sessionId));
}

export async function createCompanionThreadForQuestion(questionId: string) {
  const db = await getDbReady();
  const id = `companion_question_${questionId}`;
  await db.run(sql`INSERT OR IGNORE INTO companion_threads (id,scope_key,scope_type,scope_id,title)
    VALUES (${id},${`question:${questionId}`},'question',${questionId},'雅思题目 · Chloe')`);
  return id;
}
