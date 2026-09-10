import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { getDbReady } from "@db/client";
import { answerGaps, gapClusters, personalAnswers, speakingGapLinks } from "@db/schema";
import { enqueueAiJob, runReviewedAiJob, runSingleAiJob } from "@/lib/ai/job-service";
import { AiProviderError } from "@/lib/ai/errors";
import { createAiProvider } from "@/lib/ai/provider-factory";
import { runtimeAnswerMockResolver } from "@/lib/answers/runtime-mock";
import {
  reattemptComparisonSchema,
  speakingGapGenerationSchema,
  speakingGapReviewSchema,
  type SpeakingGapCandidate,
  type SpeakingGapGeneration,
  type SpeakingGapReview,
} from "./schemas";

function stableId(prefix: string, ...parts: string[]) {
  return `${prefix}_${createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 24)}`;
}

function normalized(value: string) {
  return value.normalize("NFKC").toLowerCase().replace(/[“”‘’]/g, "'").replace(/\s+/g, " ").trim();
}

function readPrompt(filename: string) {
  return fs.readFileSync(path.join(process.env.ROASTDUCK_PROMPT_ROOT||path.join(process.cwd(), "pipeline", "prompts"), filename), "utf8");
}

function validateIndependentReview(rawText: string, generated: SpeakingGapGeneration, review: SpeakingGapReview) {
  const generatedKeys = new Set(generated.candidates.map((item) => item.key));
  const reviewedKeys = new Set(review.items.map((item) => item.key));
  if (generatedKeys.size !== generated.candidates.length || reviewedKeys.size !== review.items.length) {
    throw new AiProviderError("Gap key 必须唯一", "invalid_output", false);
  }
  if (generatedKeys.size !== reviewedKeys.size || [...generatedKeys].some((key) => !reviewedKeys.has(key))) {
    throw new AiProviderError("Gap Reviewer 必须逐项裁决全部候选", "invalid_output", false);
  }
  const source = normalized(rawText);
  for (const item of review.items) {
    if (item.candidate.key !== item.key) throw new AiProviderError("Reviewer 返回了不一致的 Gap key", "invalid_output", false);
    if (item.verdict === "rejected") continue;
    if (!source.includes(normalized(item.candidate.evidenceText))) {
      throw new AiProviderError(`Gap 证据不在用户原文中：${item.key}`, "invalid_output", false);
    }
    if (item.candidate.gapType === "asr_uncertain" && item.candidate.learningFit) {
      throw new AiProviderError("ASR 不确定项不能进入学习队列", "invalid_output", false);
    }
    if (!["lexical_gap", "grammar_construction"].includes(item.candidate.gapType) && item.candidate.learningFit) {
      throw new AiProviderError("非表达/构式 Gap 不能伪装成学习 Chunk", "invalid_output", false);
    }
  }
}

function clusterKey(candidate: SpeakingGapCandidate) {
  const expression = normalized(candidate.recommendedExpression || candidate.evidenceText);
  return `${candidate.gapType}:${expression}`.slice(0, 500);
}

async function applyReviewedGaps(input: {
  answerId: string;
  answerVersionId: string | null;
  rawMessages: Array<{ id: string; text: string }>;
  generated: SpeakingGapGeneration;
  review: SpeakingGapReview;
  reviewerRunId: string;
}) {
  const db = await getDbReady();
  const rawText = input.rawMessages.map((message) => message.text).join("\n\n");
  validateIndependentReview(rawText, input.generated, input.review);
  const now = new Date().toISOString();
  const messageByGap = new Map<string, string>();
  const accepted = input.review.items.filter((item) => item.verdict !== "rejected").map((item) => {
    const candidate = item.candidate;
    const canonical = clusterKey(candidate);
    const clusterId = stableId("gap_cluster", canonical);
    const gapId = stableId("answer_gap", input.answerId, candidate.gapType, normalized(candidate.evidenceText), normalized(candidate.recommendedExpression));
    const evidenceMessage = input.rawMessages.find((message) => normalized(message.text).includes(normalized(candidate.evidenceText)));
    if (!evidenceMessage) throw new AiProviderError(`无法定位 Gap 消息：${item.key}`, "invalid_output", false);
    messageByGap.set(gapId, evidenceMessage.id);
    return { item, candidate, canonical, clusterId, gapId };
  });
  await db.transaction(async (tx) => {
    for (const { item, candidate, canonical, clusterId, gapId } of accepted) {
      await tx.insert(gapClusters).values({
        id: clusterId,
        canonicalKey: canonical,
        titleZh: (candidate.intentZh || candidate.explanationZh).slice(0, 200),
        gapType: candidate.gapType,
        createdAt: now,
        updatedAt: now,
      }).onConflictDoNothing({ target: gapClusters.canonicalKey });
      await tx.insert(answerGaps).values({
        id: gapId,
        answerId: input.answerId,
        answerVersionId: input.answerVersionId,
        clusterId,
        gapType: candidate.gapType,
        evidenceText: candidate.evidenceText,
        intentZh: candidate.intentZh,
        recommendedExpression: candidate.recommendedExpression,
        explanationZh: candidate.explanationZh,
        confidence: candidate.confidence,
        impactLevel: candidate.impactLevel,
        reviewerDecision: item.verdict,
        reviewerReason: item.reason,
        reviewerRunId: input.reviewerRunId,
        learningFit: candidate.learningFit,
        status: ["asr_uncertain", "pronunciation_unknown"].includes(candidate.gapType) ? "needs_attention" : "open",
        createdAt: now,
        updatedAt: now,
      }).onConflictDoUpdate({
        target: answerGaps.id,
        set: {
          answerVersionId: input.answerVersionId,
          clusterId,
          gapType: candidate.gapType,
          evidenceText: candidate.evidenceText,
          intentZh: candidate.intentZh,
          recommendedExpression: candidate.recommendedExpression,
          explanationZh: candidate.explanationZh,
          confidence: candidate.confidence,
          impactLevel: candidate.impactLevel,
          reviewerDecision: item.verdict,
          reviewerReason: item.reason,
          reviewerRunId: input.reviewerRunId,
          learningFit: candidate.learningFit,
          status: ["asr_uncertain", "pronunciation_unknown"].includes(candidate.gapType) ? "needs_attention" : "open",
          updatedAt: now,
        },
      });
    }
    await tx.run(sql`UPDATE gap_clusters SET occurrence_count = (
      SELECT COUNT(*) FROM answer_gaps
      WHERE answer_gaps.cluster_id = gap_clusters.id AND answer_gaps.reviewer_decision IN ('approved','edited')
    ), updated_at = ${now}`);
  });
  return messageByGap;
}

async function gapsForAnswer(answerId: string) {
  const db = await getDbReady();
  return db.select().from(answerGaps).where(and(eq(answerGaps.answerId, answerId), inArray(answerGaps.reviewerDecision, ["approved", "edited"]))).orderBy(answerGaps.createdAt);
}

async function previousQuestionGaps(questionId: string, answerId: string) {
  const db = await getDbReady();
  return db.select({
    id: answerGaps.id,
    gapType: answerGaps.gapType,
    evidenceText: answerGaps.evidenceText,
    recommendedExpression: answerGaps.recommendedExpression,
    explanationZh: answerGaps.explanationZh,
    clusterId: answerGaps.clusterId,
    status: answerGaps.status,
  }).from(answerGaps)
    .innerJoin(personalAnswers, eq(personalAnswers.id, answerGaps.answerId))
    .where(and(eq(personalAnswers.questionId, questionId), isNull(personalAnswers.supersededByRevisionId), ne(personalAnswers.id, answerId), inArray(answerGaps.reviewerDecision, ["approved", "edited"])))
    .orderBy(desc(answerGaps.createdAt)).limit(30);
}

export async function runSpeakingGapPipeline(input: {
  sessionId: string;
  answerId: string;
  answerVersionId: string | null;
  question: { part: number; textEn: string; textZh: string; topicZh: string; topicEn: string };
  rawMessages: Array<{ id: string; text: string; inputLanguage: string | null; messageKind: string }>;
  completionEventId: string;
}) {
  const db = await getDbReady();
  const rawText = input.rawMessages.map((message) => message.text).join("\n\n");
  const provider = createAiProvider({ mockResolver: runtimeAnswerMockResolver });
  const gapJob = await enqueueAiJob({
    kind: "speaking_gap_pipeline",
    targetType: "personal_answer",
    targetId: input.answerId,
    payload: { sessionId: input.sessionId, completionEventId: input.completionEventId },
    promptVersion: "speaking-gap-generator-v2+speaking-gap-reviewer-v2",
    schemaVersion: "speaking-gap-v2",
  });
  let messageByGap = new Map<string, string>();
  if (gapJob.status !== "completed") {
    await runReviewedAiJob({
      jobId: gapJob.id,
      provider,
      generatorRole: "gap_generator",
      reviewerRole: "gap_reviewer",
      generator: {
        role: "gap_generator",
        instructions: readPrompt("speaking_gap.generator.v2.md"),
        input: JSON.stringify({ question: input.question, rawMessages: input.rawMessages, answerVersionId: input.answerVersionId }),
        schema: speakingGapGenerationSchema,
        schemaName: "speaking_gap_generator_v2",
        promptVersion: "speaking-gap-generator-v2",
        schemaVersion: "speaking-gap-v2",
        idempotencyKey: gapJob.idempotencyKey,
      },
      reviewer: (generated) => ({
        role: "gap_reviewer",
        instructions: readPrompt("speaking_gap.reviewer.v2.md"),
        input: JSON.stringify({ question: input.question, rawMessages: input.rawMessages, answerVersionId: input.answerVersionId, candidates: generated.candidates }),
        schema: speakingGapReviewSchema,
        schemaName: "speaking_gap_reviewer_v2",
        promptVersion: "speaking-gap-reviewer-v2",
        schemaVersion: "speaking-gap-review-v2",
        idempotencyKey: `${gapJob.idempotencyKey}_review`,
      }),
      isRejected: () => false,
      apply: async (generated, review, audit) => {
        messageByGap = await applyReviewedGaps({
          answerId: input.answerId,
          answerVersionId: input.answerVersionId,
          rawMessages: input.rawMessages,
          generated,
          review,
          reviewerRunId: audit.reviewerRunId,
        });
      },
    });
  }

  const currentGaps = await gapsForAnswer(input.answerId);
  if (!messageByGap.size) {
    for (const gap of currentGaps) {
      const message = input.rawMessages.find((item) => normalized(item.text).includes(normalized(gap.evidenceText)));
      if (message) messageByGap.set(gap.id, message.id);
    }
  }
  const [answer] = await db.select({ questionId: personalAnswers.questionId }).from(personalAnswers).where(eq(personalAnswers.id, input.answerId)).limit(1);
  if (!answer) throw new Error("Gap 流水线找不到个人回答");
  const authoritativePreviousGaps = await previousQuestionGaps(answer.questionId, input.answerId);
  if (!currentGaps.length && !authoritativePreviousGaps.length) return { gaps: [], comparisons: [] };

  const comparatorJob = await enqueueAiJob({
    kind: "speaking_reattempt_comparator",
    targetType: "speaking_session",
    targetId: input.sessionId,
    payload: { answerId: input.answerId, completionEventId: input.completionEventId },
    promptVersion: "speaking-reattempt-comparator-v1",
    schemaVersion: "speaking-reattempt-comparison-v1",
  });
  if (comparatorJob.status !== "completed") {
    await runSingleAiJob({
      jobId: comparatorJob.id,
      provider,
      request: {
        role: "reattempt_comparator",
        instructions: readPrompt("speaking_reattempt.comparator.v1.md"),
        input: JSON.stringify({ question: input.question, rawText, currentGaps, previousGaps: authoritativePreviousGaps }),
        schema: reattemptComparisonSchema,
        schemaName: "speaking_reattempt_comparator_v1",
        promptVersion: "speaking-reattempt-comparator-v1",
        schemaVersion: "speaking-reattempt-comparison-v1",
        idempotencyKey: comparatorJob.idempotencyKey,
      },
      apply: async (output, result) => {
        const currentIds = new Set(currentGaps.map((gap) => gap.id));
        const previousIds = new Set(authoritativePreviousGaps.map((gap) => gap.id));
        const allowedIds = new Set([...currentIds, ...previousIds]);
        const seenCurrent = new Set<string>();
        for (const item of output.items) {
          if (!allowedIds.has(item.subjectGapId) || (item.relatedGapId && !allowedIds.has(item.relatedGapId))) {
            throw new AiProviderError("Comparator 引用了输入之外的 Gap", "invalid_output", false);
          }
          if (currentIds.has(item.subjectGapId)) {
            if (seenCurrent.has(item.subjectGapId)) throw new AiProviderError("当前 Gap 被重复比较", "invalid_output", false);
            seenCurrent.add(item.subjectGapId);
          }
          if (item.comparison === "repeated" && (!currentIds.has(item.subjectGapId) || !item.relatedGapId || !previousIds.has(item.relatedGapId))) {
            throw new AiProviderError("repeated 必须连接当前 Gap 与历史 Gap", "invalid_output", false);
          }
          if (item.comparison === "improved" && !previousIds.has(item.subjectGapId)) {
            throw new AiProviderError("improved 的主体必须是历史 Gap", "invalid_output", false);
          }
        }
        if ([...currentIds].some((id) => !seenCurrent.has(id))) {
          throw new AiProviderError("Comparator 必须覆盖每个当前 Gap", "invalid_output", false);
        }
        const fallbackMessageId = input.rawMessages.at(-1)?.id;
        if (!fallbackMessageId) throw new AiProviderError("重答没有用户消息", "invalid_output", false);
        for (const item of output.items) {
          const messageId = messageByGap.get(item.subjectGapId) ?? fallbackMessageId;
          await db.insert(speakingGapLinks).values({
            messageId,
            gapId: item.subjectGapId,
            comparison: item.comparison,
            relatedGapId: item.relatedGapId,
            reason: item.reason,
            comparatorRunId: result.runId,
          }).onConflictDoUpdate({
            target: [speakingGapLinks.messageId, speakingGapLinks.gapId],
            set: {
              comparison: item.comparison,
              relatedGapId: item.relatedGapId,
              reason: item.reason,
              comparatorRunId: result.runId,
            },
          });
        }
      },
    });
  }
  const comparisons = await db.all<Record<string, unknown>>(sql`
    SELECT l.message_id AS messageId, l.gap_id AS gapId, l.comparison, l.related_gap_id AS relatedGapId,
      l.reason, l.comparator_run_id AS comparatorRunId
    FROM speaking_gap_links l JOIN speaking_messages m ON m.id = l.message_id
    WHERE m.session_id = ${input.sessionId} ORDER BY m.sequence_no, l.gap_id`);
  return { gaps: currentGaps, comparisons };
}
