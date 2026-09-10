import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { getDbReady, withDbTransaction } from "@db/client";
import {
  aiJobs,
  answerVersions,
  companionMessages,
  personalAnswers,
  personalAnswerSentences,
  questionAttempts,
  questions,
  speakingAttempts,
  speakingEvents,
  speakingMessages,
  speakingSessions,
} from "@db/schema";
import { enqueueAiJob, runReviewedAiJob, runSingleAiJob } from "@/lib/ai/job-service";
import { createAiProvider } from "@/lib/ai/provider-factory";
import { normalizeAiError, safeErrorSummary } from "@/lib/ai/errors";
import { getPersonalAnswer } from "@/lib/answers/service";
import { createPersonalAnswer } from "@/lib/answers/service";
import { applyPersonalChunks } from "@/lib/answers/processor";
import { processPersonalAnswer } from "@/lib/answers/processor";
import { personalChunkGenerationSchema, personalChunkReviewSchema } from "@/lib/answers/ai-schemas";
import { runtimeAnswerMockResolver } from "@/lib/answers/runtime-mock";
import { buildInteractiveText } from "@/lib/learning/content";
import {
  speakingFeedbackOutputSchema,
  speakingHintOutputSchema,
  teacherMessageOutputSchema,
  speakingRetryOutputSchema,
  storedHintsSchema,
  storedSpeakingFeedbackSchema,
  type SpeakingEvent,
  type SpeakingFeedbackOutput,
  type CreateSpeakingMessage,
} from "./schemas";
import { annotateRuntimeEnglish, assertRuntimeGlossaryCoverage } from "./runtime-annotations";
import { runSpeakingGapPipeline } from "./gap-pipeline";
import { runSpeakingMaterialPipeline } from "./material-pipeline";
import {
  CompanionServiceError,
  createOrGetCompanionThread,
  extractCompanionMemoriesOnClose,
  sendCompanionMessage,
} from "@/lib/companion/service";

function stableId(prefix: string, ...parts: string[]) {
  return `${prefix}_${createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 24)}`;
}

function readPrompt(filename: string) {
  return fs.readFileSync(path.join(process.env.ROASTDUCK_PROMPT_ROOT||path.join(process.cwd(), "pipeline", "prompts"), filename), "utf8");
}

function parseJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

export class SpeakingServiceError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) { super(message); }
}

export const MESSAGE_LEASE_MS = 10 * 60 * 1000;
function messageLeaseExpired(metadata: Record<string, unknown>, createdAt: string): boolean {
  const deadline = typeof metadata.leaseExpiresAt === 'string' ? Date.parse(metadata.leaseExpiresAt) : Date.parse(createdAt) + MESSAGE_LEASE_MS;
  return !Number.isFinite(deadline) || deadline <= Date.now();
}

export async function getSpeakingSession(sessionId: string) {
  const db = await getDbReady();
  const rows = await db.all<Record<string, unknown>>(sql`
    SELECT ss.*, q.part, q.text AS questionEn, q.text_zh AS questionZh,
      COALESCE(t.name_zh, '') AS topicZh, COALESCE(t.name_en, '') AS topicEn
    FROM speaking_sessions ss JOIN questions q ON q.id = ss.question_id
    LEFT JOIN topics t ON t.id = q.topic_id
    WHERE ss.id = ${sessionId} LIMIT 1`);
  const row = rows[0];
  if (!row) return null;
  const [job] = await db.select({ id: aiJobs.id, kind: aiJobs.kind, status: aiJobs.status, lastErrorCode: aiJobs.lastErrorCode, updatedAt: aiJobs.updatedAt })
    .from(aiJobs).where(and(eq(aiJobs.targetType, "speaking_session"), eq(aiJobs.targetId, sessionId))).orderBy(desc(aiJobs.updatedAt)).limit(1);
  const attempts = await db.select().from(speakingAttempts).where(eq(speakingAttempts.sessionId, sessionId)).orderBy(speakingAttempts.createdAt);
  const unifiedThreadId = row.companion_thread_id == null ? null : String(row.companion_thread_id);
  const messageRows = unifiedThreadId && String(row.experience_version) === "teacher_chat_v2"
    ? await db.select().from(companionMessages).where(eq(companionMessages.threadId, unifiedThreadId)).orderBy(companionMessages.sequenceNo)
    : await db.select().from(speakingMessages).where(eq(speakingMessages.sessionId, sessionId)).orderBy(speakingMessages.sequenceNo);
  const gapComparisons = await db.all<Record<string, unknown>>(sql`
    SELECT l.message_id AS messageId, l.gap_id AS gapId, l.comparison,
      l.related_gap_id AS relatedGapId, l.reason, l.comparator_run_id AS comparatorRunId,
      g.gap_type AS gapType, g.evidence_text AS evidenceText,
      g.recommended_expression AS recommendedExpression
    FROM speaking_gap_links l
    LEFT JOIN speaking_messages m ON m.id = l.message_id
    LEFT JOIN companion_messages cm ON cm.id = l.message_id
    JOIN answer_gaps g ON g.id = l.gap_id
    WHERE m.session_id = ${sessionId} OR (cm.source_type = 'speaking_session' AND cm.source_id = ${sessionId})
    ORDER BY COALESCE(m.sequence_no,cm.sequence_no), l.gap_id`);
  const materialCounts = await db.all<{ total: number }>(sql`
    SELECT COUNT(DISTINCT u.id) AS total
    FROM question_learning_units u JOIN answer_gaps g ON g.id = u.gap_id
    WHERE g.answer_id = ${row.answer_id ?? ""} AND u.status = 'active' AND u.source = 'runtime_answer_gap'`);
  const parsedHints = storedHintsSchema.safeParse(parseJson(String(row.hints_json), {}));
  const hints = parsedHints.success ? parsedHints.data : { keywords: [], chunks: [], fullAnswer: "", glossary: [] };
  const parsedFeedback = String(row.feedback_json) === "{}" ? null : storedSpeakingFeedbackSchema.safeParse(parseJson(String(row.feedback_json), {}));
  const feedback = parsedFeedback?.success ? parsedFeedback.data : null;
  const interactiveKeywords = await Promise.all(hints.keywords.map((text, index) => buildInteractiveText("speaking_hint", `${sessionId}:keyword:${index}`, text)));
  const interactiveChunks = await Promise.all(hints.chunks.map((item, index) => buildInteractiveText("speaking_hint", `${sessionId}:chunk:${index}`, item.text)));
  const interactiveFullAnswer = await buildInteractiveText("speaking_hint", `${sessionId}:full`, hints.fullAnswer);
  const interactiveFeedback = feedback ? {
    ...feedback,
    interactiveCorrectedAnswer: await buildInteractiveText("speaking_feedback", `${sessionId}:corrected`, feedback.correctedAnswer),
    items: await Promise.all(feedback.items.map(async (item) => ({
      ...item,
      interactiveOriginal: await buildInteractiveText("speaking_feedback", `${sessionId}:${item.id}:original`, item.originalSentence),
      interactiveRecommended: await buildInteractiveText("speaking_feedback", `${sessionId}:${item.id}:recommended`, item.recommendedSentence),
      interactiveGap: await buildInteractiveText("speaking_feedback", `${sessionId}:${item.id}:gap`, item.gapExpression),
    }))),
  } : null;
  const messages = await Promise.all(messageRows.map(async (message) => ({
    id: message.id,
    sequenceNo: message.sequenceNo,
    role: message.role as "user" | "teacher" | "system",
    messageKind: message.messageKind as "text" | "voice",
    text: message.text,
    inputLanguage: message.inputLanguage as "zh" | "en" | "mixed" | null,
    status: message.status as "pending" | "sent" | "failed",
    clientMessageId: message.clientMessageId,
    metadata: parseJson<Record<string, unknown>>(message.metadataJson, {}),
    retryable: message.role === 'user' && (message.status === 'failed' || (message.status === 'pending' && messageLeaseExpired(parseJson(message.metadataJson, {}), message.createdAt))),
    interactiveText: await buildInteractiveText("speaking_message", message.id, message.text),
    createdAt: message.createdAt,
  })));
  return {
    id: String(row.id),
    questionId: String(row.question_id),
    answerId: row.answer_id == null ? null : String(row.answer_id),
    status: String(row.status),
    experienceVersion: String(row.experience_version),
    companionThreadId: unifiedThreadId,
    turnCount: Number(row.turn_count),
    lastError: row.last_error == null ? null : String(row.last_error),
    chineseIdea: String(row.chinese_idea),
    ideaSource: String(row.idea_source) as "user_history" | "ai_generated",
    hints: { ...hints, interactiveKeywords, interactiveChunks, interactiveFullAnswer },
    hintLevel: Number(row.hint_level),
    responseText: String(row.response_text),
    feedback: interactiveFeedback,
    activeRetryItemId: row.active_retry_item_id == null ? null : String(row.active_retry_item_id),
    question: { part: Number(row.part), textEn: String(row.questionEn), textZh: String(row.questionZh ?? ""), topicZh: String(row.topicZh), topicEn: String(row.topicEn) },
    job: job ?? null,
    attempts: attempts.map((attempt) => ({ id: attempt.id, type: attempt.attemptType, itemId: attempt.feedbackItemId, text: attempt.text, passed: attempt.passed, createdAt: attempt.createdAt })),
    messages,
    gapComparisons: gapComparisons.map((item) => ({
      messageId: String(item.messageId),
      gapId: String(item.gapId),
      comparison: String(item.comparison) as "improved" | "repeated" | "new" | "uncertain",
      relatedGapId: item.relatedGapId == null ? null : String(item.relatedGapId),
      reason: String(item.reason),
      comparatorRunId: String(item.comparatorRunId),
      gapType: String(item.gapType),
      evidenceText: String(item.evidenceText),
      recommendedExpression: String(item.recommendedExpression),
    })),
    learningMaterialCount: Number(materialCounts[0]?.total ?? 0),
    canContinue: !["completed", "failed"].includes(String(row.status)),
    defaultRoundLimit: 4,
  };
}

export type SpeakingSessionView = NonNullable<Awaited<ReturnType<typeof getSpeakingSession>>>;

function nextMessageSequence(messages: SpeakingSessionView["messages"]): number {
  return (messages.at(-1)?.sequenceNo ?? 0) + 1;
}

export async function createSpeakingSession(input: { clientRequestId: string; questionId: string; answerId: string | null }) {
  const db = await getDbReady();
  const [question] = await db.select().from(questions).where(eq(questions.id, input.questionId)).limit(1);
  if (!question) throw new SpeakingServiceError("题目不存在", 404, "question_not_found");
  const sessionId = `speaking_${input.clientRequestId.replaceAll("-", "")}`;
  const existing = await getSpeakingSession(sessionId);
  if (existing) return existing;
  const companion = await createOrGetCompanionThread({ scopeType: "question", scopeId: input.questionId, title: "雅思题目 · Chloe" });
  if (!companion) throw new SpeakingServiceError("Chloe 题目线程创建失败", 500, "companion_thread_failed");

  let historyAnswer = input.answerId ? await getPersonalAnswer(input.answerId) : null;
  if (historyAnswer?.status === "superseded") throw new SpeakingServiceError("此历史回答已修复，请从题目页选择新回答", 409, "answer_superseded");
  if (historyAnswer && historyAnswer.questionId !== input.questionId) throw new SpeakingServiceError("答案不属于当前题目", 409, "answer_question_mismatch");
  if (!historyAnswer) {
    const latest = await db.select({ id: personalAnswers.id }).from(personalAnswers).where(and(eq(personalAnswers.questionId, input.questionId), isNull(personalAnswers.supersededByRevisionId))).orderBy(desc(personalAnswers.createdAt), desc(personalAnswers.attemptOrder)).limit(1);
    historyAnswer = latest[0] ? await getPersonalAnswer(latest[0].id) : null;
  }
  const now = new Date().toISOString();
  const inserted = await db.insert(speakingSessions).values({ id: sessionId, questionId: input.questionId, answerId: historyAnswer?.id ?? null, status: "preparing", experienceVersion: "teacher_chat_v2", companionThreadId: companion.id, createdAt: now, updatedAt: now }).onConflictDoNothing({ target: speakingSessions.id }).returning({ id: speakingSessions.id });
  if (!inserted.length) return (await getSpeakingSession(sessionId))!;

  const latestVersion = historyAnswer?.versions[0] ?? null;
  const historyChinese = latestVersion?.textZh.trim() || (historyAnswer?.inputLanguage !== "en" ? historyAnswer?.rawText.trim() : "") || "";
  const historyEnglish = latestVersion?.textEn.trim() || (historyAnswer?.inputLanguage === "en" ? historyAnswer.rawText.trim() : "") || "";
  const hintJob = await enqueueAiJob({
    kind: "speaking_hint",
    targetType: "speaking_session",
    targetId: sessionId,
    payload: { sessionId, questionId: input.questionId },
    promptVersion: "speaking-hint-v1",
    schemaVersion: "speaking-hint-v1",
  });
  const provider = createAiProvider({ mockResolver: runtimeAnswerMockResolver });
  try {
    await runSingleAiJob({
      jobId: hintJob.id,
      provider,
      request: {
        role: "hint",
        instructions: readPrompt("speaking_hint.hint.v1.md"),
        input: JSON.stringify({ question: { part: question.part, textEn: question.text, textZh: question.textZh }, userHistory: historyEnglish ? { english: historyEnglish, chinese: historyChinese } : null }),
        schema: speakingHintOutputSchema,
        schemaName: "speaking_hint_v1",
        promptVersion: "speaking-hint-v1",
        schemaVersion: "speaking-hint-v1",
        idempotencyKey: hintJob.idempotencyKey,
      },
      apply: async (output) => {
        assertRuntimeGlossaryCoverage([
          ...output.keywords,
          ...output.chunks.map((item) => item.text),
          output.fullAnswer,
        ], output.glossary);
        await Promise.all([
          ...output.keywords.map((text, index) => annotateRuntimeEnglish({ contentType: "speaking_hint", contentId: `${sessionId}:keyword:${index}`, text, glossary: output.glossary })),
          ...output.chunks.map((item, index) => annotateRuntimeEnglish({ contentType: "speaking_hint", contentId: `${sessionId}:chunk:${index}`, text: item.text, glossary: output.glossary, phraseMeaningZh: item.meaningZh })),
          annotateRuntimeEnglish({ contentType: "speaking_hint", contentId: `${sessionId}:full`, text: output.fullAnswer, glossary: output.glossary }),
        ]);
        await db.update(speakingSessions).set({
          answerId: historyAnswer?.id ?? null,
          status: "ready",
          chineseIdea: historyChinese || output.aiChineseIdea,
          ideaSource: historyChinese ? "user_history" : "ai_generated",
          hintsJson: JSON.stringify({ keywords: output.keywords, chunks: output.chunks, fullAnswer: output.fullAnswer, glossary: output.glossary }),
          updatedAt: new Date().toISOString(),
        }).where(eq(speakingSessions.id, sessionId));
      },
    });
  } catch (reason) {
    await db.update(speakingSessions).set({ status: "failed", updatedAt: new Date().toISOString() }).where(eq(speakingSessions.id, sessionId));
    throw reason;
  }
  return (await getSpeakingSession(sessionId))!;
}

async function sendUnifiedSpeakingMessage(session: SpeakingSessionView, input: CreateSpeakingMessage) {
  if (!session.companionThreadId) throw new SpeakingServiceError("Chloe 题目线程缺失", 500, "companion_thread_missing");
  const existing = session.messages.find((message) => message.role === "user" && message.clientMessageId === input.clientMessageId);
  const replied = session.messages.some((message) => message.role === "teacher" && message.metadata.parentClientMessageId === input.clientMessageId);
  if (replied) return session;
  if (!existing && !["ready", "conversing"].includes(session.status)) {
    throw new SpeakingServiceError("当前会话不能发送新消息", 409, "invalid_state");
  }
  if (existing && !input.retry) throw new SpeakingServiceError("这条消息已保留，请显式重试", 409, "message_retry_required");
  const db = await getDbReady();
  await db.update(speakingSessions).set({ status: "teacher_responding", lastError: null, updatedAt: new Date().toISOString() })
    .where(eq(speakingSessions.id, session.id));
  try {
    const delivered = await sendCompanionMessage(session.companionThreadId, input, {
      sourceType: "speaking_session",
      sourceId: session.id,
      metadata: { speakingSessionId: session.id, questionId: session.questionId },
    });
    await db.update(speakingSessions).set({
      status: "conversing",
      turnCount: sql`${speakingSessions.turnCount} + 1`,
      lastError: null,
      updatedAt: new Date().toISOString(),
    }).where(eq(speakingSessions.id, session.id));
    return { ...(await getSpeakingSession(session.id))!, newMemories: delivered.newMemories };
  } catch (reason) {
    const staleOrInProgress = reason instanceof CompanionServiceError && ["message_in_progress", "message_lease_lost"].includes(reason.code);
    if (!staleOrInProgress) {
      await db.update(speakingSessions).set({ status: "ai_failed", lastError: safeErrorSummary(reason), updatedAt: new Date().toISOString() })
        .where(eq(speakingSessions.id, session.id));
    }
    if (reason instanceof CompanionServiceError) throw new SpeakingServiceError(reason.message, reason.status, reason.code);
    throw normalizeAiError(reason);
  }
}

export async function sendSpeakingMessage(sessionId: string, input: CreateSpeakingMessage) {
  let session = await getSpeakingSession(sessionId);
  if (!session) throw new SpeakingServiceError("输出会话不存在", 404, "session_not_found");
  if (session.experienceVersion === "teacher_chat_v2") return sendUnifiedSpeakingMessage(session, input);
  if (session.experienceVersion !== "teacher_chat_v1") {
    throw new SpeakingServiceError("旧版纠错会话不能写入老师消息", 409, "legacy_session");
  }

  const existing = session.messages.find((message) => message.clientMessageId === input.clientMessageId && message.role === "user");
  const completedReply = session.messages.some((message) => message.role === "teacher" && message.metadata.parentClientMessageId === input.clientMessageId);
  if (completedReply) return session;
  if (existing && existing.text !== input.text) {
    throw new SpeakingServiceError("相同消息 ID 不能改写原文", 409, "idempotency_conflict");
  }
  if (existing?.status === "failed" && !input.retry) {
    throw new SpeakingServiceError("这条消息已保留，请显式重试", 409, "message_retry_required");
  }
  if (existing?.status === "pending" && !messageLeaseExpired(existing.metadata, existing.createdAt)) {
    throw new SpeakingServiceError("老师正在回复这条消息", 409, "message_in_progress");
  }
  if (!existing && !["ready", "conversing"].includes(session.status)) {
    throw new SpeakingServiceError("当前会话不能发送新消息", 409, "invalid_state");
  }
  if (existing && !input.retry) throw new SpeakingServiceError('这条消息已保留，请显式重试', 409, 'message_retry_required');
  if (existing && session.status !== "ai_failed" && !(existing.status === 'pending' && session.status === 'teacher_responding')) {
    throw new SpeakingServiceError("当前消息不能重试", 409, "invalid_state");
  }

  const messageId = existing?.id ?? stableId("speaking_message", sessionId, input.clientMessageId);
  const previousAttempt = existing ? Number(existing.metadata.deliveryAttempt ?? 1) : 0;
  const deliveryAttempt = previousAttempt + 1;
  const now = new Date().toISOString();
  const leaseId = randomUUID();
  const leaseExpiresAt = new Date(Date.now() + MESSAGE_LEASE_MS).toISOString();
  await withDbTransaction(async () => {
    const tx = await getDbReady();
    // 重新检查持久状态，多个进程/并发 retry 只能领取同一个 deliveryAttempt 一次。
    const [current] = await tx.select().from(speakingMessages).where(eq(speakingMessages.id, messageId)).limit(1);
    if ((existing && (!current || current.status === 'sent' || Number(parseJson<Record<string, unknown>>(current.metadataJson, {}).deliveryAttempt ?? 1) !== previousAttempt))
      || (!existing && current)) throw new SpeakingServiceError('消息已被其他请求处理，请刷新', 409, 'message_in_progress');
    const claimed = await tx.update(speakingSessions).set({ status: 'teacher_responding', lastError: null, updatedAt: now })
      .where(and(eq(speakingSessions.id, sessionId), eq(speakingSessions.status, session!.status))).returning({ id: speakingSessions.id });
    if (!claimed.length) throw new SpeakingServiceError('会话已被其他请求处理，请刷新', 409, 'message_in_progress');
    if (existing) {
      await tx.update(speakingMessages).set({
        status: "pending",
        metadataJson: JSON.stringify({ ...existing.metadata, deliveryAttempt, leaseId, leaseExpiresAt }),
      }).where(eq(speakingMessages.id, messageId));
    } else {
      await tx.insert(speakingMessages).values({
        id: messageId,
        sessionId,
        sequenceNo: nextMessageSequence(session!.messages),
        role: "user",
        messageKind: input.messageKind,
        text: input.text,
        inputLanguage: input.inputLanguage,
        status: "pending",
        clientMessageId: input.clientMessageId,
        metadataJson: JSON.stringify({ deliveryAttempt, leaseId, leaseExpiresAt }),
        createdAt: now,
      });
    }
    await tx.update(speakingSessions).set({
      status: "teacher_responding",
      lastError: null,
      updatedAt: now,
    }).where(eq(speakingSessions.id, sessionId));
  });

  session = (await getSpeakingSession(sessionId))!;
  try {
    const job = await enqueueAiJob({
      kind: "speaking_teacher_response",
      targetType: "speaking_message",
      targetId: messageId,
      payload: { sessionId, clientMessageId: input.clientMessageId, deliveryAttempt },
      promptVersion: "speaking-teacher-v1",
      schemaVersion: "speaking-teacher-v1",
    });
    const provider = createAiProvider({ mockResolver: runtimeAnswerMockResolver });
    await runSingleAiJob({
      jobId: job.id,
      provider,
      request: {
        role: "teacher_response",
        instructions: readPrompt("speaking_teacher.teacher.v1.md"),
        input: JSON.stringify({
          question: session.question,
          chineseIdea: session.chineseIdea,
          learnedExpressions: session.hints.chunks,
          round: session.turnCount + 1,
          deliveryAttempt,
          recentMessages: session.messages.slice(-12).map((message) => ({ role: message.role, text: message.text })),
          latestUserMessage: { text: input.text, inputLanguage: input.inputLanguage, messageKind: input.messageKind },
        }),
        schema: teacherMessageOutputSchema,
        schemaName: "speaking_teacher_v1",
        promptVersion: "speaking-teacher-v1",
        schemaVersion: "speaking-teacher-v1",
        idempotencyKey: job.idempotencyKey,
      },
      apply: async (output, result) => {
        const teacherMessages = output.messages.map((message, index) => ({
          id: stableId("speaking_message", sessionId, input.clientMessageId, "teacher", String(index)),
          text: message.text,
          purpose: message.purpose,
          index,
        }));
        assertRuntimeGlossaryCoverage([input.text, ...teacherMessages.map((message) => message.text)], output.glossary);
        await withDbTransaction(async () => {
          const tx = await getDbReady();
          const [owner] = await tx.select().from(speakingMessages).where(eq(speakingMessages.id, messageId)).limit(1);
          if (!owner || owner.status !== 'pending' || parseJson<Record<string, unknown>>(owner.metadataJson, {}).leaseId !== leaseId) {
            throw new SpeakingServiceError('旧回复已被新重试取代', 409, 'message_lease_lost');
          }
          await Promise.all([
            annotateRuntimeEnglish({ contentType: "speaking_message", contentId: messageId, text: input.text, glossary: output.glossary }),
            ...teacherMessages.map((message) => annotateRuntimeEnglish({ contentType: "speaking_message", contentId: message.id, text: message.text, glossary: output.glossary })),
          ]);
          const current = (await getSpeakingSession(sessionId))!;
          const startSequence = nextMessageSequence(current.messages);
          await tx.update(speakingMessages).set({ status: "sent", aiRunId: result.runId }).where(eq(speakingMessages.id, messageId));
          for (const message of teacherMessages) {
            await tx.insert(speakingMessages).values({
              id: message.id,
              sessionId,
              sequenceNo: startSequence + message.index,
              role: "teacher",
              messageKind: "text",
              text: message.text,
              inputLanguage: "mixed",
              status: "sent",
              clientMessageId: `${input.clientMessageId}:teacher:${message.index}`,
              aiRunId: result.runId,
              metadataJson: JSON.stringify({
                parentClientMessageId: input.clientMessageId,
                purpose: message.purpose,
                retryRequested: output.retryRequested,
                conversationComplete: output.conversationComplete,
              }),
              createdAt: new Date().toISOString(),
            }).onConflictDoNothing({ target: [speakingMessages.sessionId, speakingMessages.clientMessageId] });
          }
          await tx.update(speakingSessions).set({
            status: "conversing",
            turnCount: sql`${speakingSessions.turnCount} + 1`,
            lastError: null,
            updatedAt: new Date().toISOString(),
          }).where(eq(speakingSessions.id, sessionId));
        });
      },
    });
  } catch (reason) {
    const message = safeErrorSummary(reason);
    await withDbTransaction(async () => {
      const tx = await getDbReady();
      const [owner] = await tx.select().from(speakingMessages).where(eq(speakingMessages.id, messageId)).limit(1);
      if (!owner || owner.status !== 'pending' || parseJson<Record<string, unknown>>(owner.metadataJson, {}).leaseId !== leaseId) return;
      await tx.update(speakingMessages).set({ status: "failed" }).where(eq(speakingMessages.id, messageId));
      await tx.update(speakingSessions).set({ status: "ai_failed", lastError: message, updatedAt: new Date().toISOString() }).where(eq(speakingSessions.id, sessionId));
    });
    throw normalizeAiError(reason);
  }
  return (await getSpeakingSession(sessionId))!;
}

async function ensureAnswerForSession(session: SpeakingSessionView, responseText: string) {
  if (session.answerId) return session.answerId;
  const db = await getDbReady();
  const answerId = stableId("answer", session.id, "spoken_response");
  const versionId = stableId("answer_version", answerId, "raw");
  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx.insert(personalAnswers).values({ id: answerId, questionId: session.questionId, inputLanguage: "en", rawText: responseText, status: "processing", currentVersionId: versionId, createdAt: now, updatedAt: now }).onConflictDoNothing({ target: personalAnswers.id });
    await tx.insert(answerVersions).values({ id: versionId, answerId, versionNo: 1, kind: "raw", textEn: responseText, createdAt: now }).onConflictDoNothing({ target: answerVersions.id });
    await tx.update(speakingSessions).set({ answerId, updatedAt: now }).where(eq(speakingSessions.id, session.id));
  });
  return answerId;
}

async function persistFeedback(session: SpeakingSessionView, answerId: string, jobId: string, output: SpeakingFeedbackOutput) {
  const db = await getDbReady();
  const versionId = stableId("answer_version", answerId, jobId, "speaking_feedback");
  const existing = await db.select({ versionNo: answerVersions.versionNo }).from(answerVersions).where(eq(answerVersions.id, versionId)).limit(1);
  const [{ latest }] = await db.select({ latest: sql<number>`COALESCE(MAX(${answerVersions.versionNo}), 0)` }).from(answerVersions).where(eq(answerVersions.answerId, answerId));
  const versionNo = existing[0]?.versionNo ?? Number(latest) + 1;
  const now = new Date().toISOString();
  const items = output.items.map((item, index) => ({ ...item, id: stableId("feedback_item", session.id, String(index), item.recommendedSentence), resolved: false, retryCount: 0, lastRetryFeedback: "" }));
  assertRuntimeGlossaryCoverage([
    output.correctedAnswer,
    ...output.correctedSentences.map((sentence) => sentence.textEn),
    ...items.flatMap((item) => [item.originalSentence, item.recommendedSentence, item.gapExpression]),
  ], output.glossary);
  await Promise.all([
    annotateRuntimeEnglish({ contentType: "speaking_feedback", contentId: `${session.id}:corrected`, text: output.correctedAnswer, glossary: output.glossary }),
    ...items.flatMap((item) => [
      annotateRuntimeEnglish({ contentType: "speaking_feedback", contentId: `${session.id}:${item.id}:original`, text: item.originalSentence, glossary: output.glossary }),
      annotateRuntimeEnglish({ contentType: "speaking_feedback", contentId: `${session.id}:${item.id}:recommended`, text: item.recommendedSentence, glossary: output.glossary }),
      annotateRuntimeEnglish({ contentType: "speaking_feedback", contentId: `${session.id}:${item.id}:gap`, text: item.gapExpression, glossary: output.glossary, phraseMeaningZh: item.gapMeaningZh }),
    ]),
  ]);
  const storedFeedback = { summaryZh: output.summaryZh, correctedAnswer: output.correctedAnswer, correctedTranslationZh: output.correctedTranslationZh, items, gapStatus: items.length ? "pending" as const : "completed" as const, gapError: "", glossary: output.glossary };
  await db.transaction(async (tx) => {
    await tx.insert(answerVersions).values({ id: versionId, answerId, versionNo, kind: "ai_revised", textEn: output.correctedAnswer, textZh: output.correctedTranslationZh, changeSummaryJson: JSON.stringify(items.map((item) => `${item.problemType}：${item.reasonZh}`)), sourceJobId: jobId, createdAt: now }).onConflictDoNothing({ target: answerVersions.id });
    for (const [index, sentence] of output.correctedSentences.entries()) {
      await tx.insert(personalAnswerSentences).values({ id: stableId("personal_sentence", versionId, String(index)), answerId, answerVersionId: versionId, questionId: session.questionId, sentenceIndex: index, textEn: sentence.textEn, textZh: sentence.textZh, createdAt: now }).onConflictDoNothing({ target: [personalAnswerSentences.answerVersionId, personalAnswerSentences.sentenceIndex] });
    }
    await tx.update(personalAnswers).set({ currentVersionId: versionId, status: items.length ? "processing" : "ready", updatedAt: now }).where(eq(personalAnswers.id, answerId));
    await tx.update(speakingSessions).set({ responseText: session.responseText, feedbackJson: JSON.stringify(storedFeedback), activeRetryItemId: items[0]?.id ?? null, status: items.length ? "retrying" : "completed", updatedAt: now }).where(eq(speakingSessions.id, session.id));
  });
  return { versionId, feedback: storedFeedback, sentences: output.correctedSentences };
}

async function runGapPipeline(session: SpeakingSessionView, answerId: string, versionId: string, feedbackJobRunId: string, feedback: ReturnType<typeof storedSpeakingFeedbackSchema.parse>, sentences: SpeakingFeedbackOutput["correctedSentences"]) {
  if (!feedback.items.length) return;
  const db = await getDbReady();
  const materialJob = await enqueueAiJob({ kind: "correction_gap_pipeline", targetType: "answer_version", targetId: versionId, payload: { sessionId: session.id, answerId, versionId, feedbackJobRunId }, promptVersion: "correction-gap-generator-v1", schemaVersion: "personal-chunk-v1" });
  const provider = createAiProvider({ mockResolver: runtimeAnswerMockResolver });
  const materialInput = { question: session.question, correctedSentences: sentences.map((sentence, index) => ({ index, ...sentence })), correctionItems: feedback.items.map((item) => ({ originalSentence: item.originalSentence, recommendedSentence: item.recommendedSentence, gapExpression: item.gapExpression })) };
  try {
    await runReviewedAiJob({
      jobId: materialJob.id,
      provider,
      generator: { role: "generator", instructions: readPrompt("correction_gap.generator.v1.md"), input: JSON.stringify(materialInput), schema: personalChunkGenerationSchema, schemaName: "correction_gap_generator_v1", promptVersion: "correction-gap-generator-v1", schemaVersion: "personal-chunk-v1", idempotencyKey: materialJob.idempotencyKey },
      reviewer: (generated) => ({ role: "reviewer", instructions: readPrompt("personal_chunk.reviewer.v1.md"), input: JSON.stringify({ ...materialInput, generatorCandidates: generated.candidates }), schema: personalChunkReviewSchema, schemaName: "correction_gap_reviewer_v1", promptVersion: "correction-gap-reviewer-v1", schemaVersion: "personal-chunk-review-v1", idempotencyKey: `${materialJob.idempotencyKey}_review` }),
      isRejected: () => false,
      apply: async (generated, review, audit) => { await applyPersonalChunks(answerId, versionId, generated, review, audit); },
    });
    const current = await getSpeakingSession(session.id);
    if (current?.feedback) await db.update(speakingSessions).set({ feedbackJson: JSON.stringify({ ...storedSpeakingFeedbackSchema.parse(current.feedback), gapStatus: "completed", gapError: "" }), updatedAt: new Date().toISOString() }).where(eq(speakingSessions.id, session.id));
  } catch (reason) {
    const current = await getSpeakingSession(session.id);
    if (current?.feedback) await db.update(speakingSessions).set({ feedbackJson: JSON.stringify({ ...storedSpeakingFeedbackSchema.parse(current.feedback), gapStatus: "failed", gapError: safeErrorSummary(reason) }), updatedAt: new Date().toISOString() }).where(eq(speakingSessions.id, session.id));
  } finally {
    await db.update(personalAnswers).set({ status: "ready", updatedAt: new Date().toISOString() }).where(eq(personalAnswers.id, answerId));
  }
}

async function handleResponse(session: SpeakingSessionView, event: Extract<SpeakingEvent, { type: "submit_response" }>) {
  if (session.status !== "ready") throw new SpeakingServiceError("当前会话不能提交正式回答", 409, "invalid_state");
  const db = await getDbReady();
  const answerId = await ensureAnswerForSession(session, event.text);
  const now = new Date().toISOString();
  await db.update(speakingSessions).set({ status: "evaluating", responseText: event.text, updatedAt: now }).where(eq(speakingSessions.id, session.id));
  const feedbackJob = await enqueueAiJob({ kind: "speaking_feedback", targetType: "speaking_session", targetId: session.id, payload: { sessionId: session.id, eventId: event.clientEventId }, promptVersion: "speaking-feedback-v1", schemaVersion: "speaking-feedback-v1" });
  const provider = createAiProvider({ mockResolver: runtimeAnswerMockResolver });
  try {
    const persistedHolder: { value: Awaited<ReturnType<typeof persistFeedback>> | null } = { value: null };
    const result = await runSingleAiJob({
      jobId: feedbackJob.id,
      provider,
      request: { role: "corrector", instructions: readPrompt("speaking_feedback.corrector.v1.md"), input: JSON.stringify({ question: session.question, userResponse: event.text, chineseIdea: session.chineseIdea }), schema: speakingFeedbackOutputSchema, schemaName: "speaking_feedback_v1", promptVersion: "speaking-feedback-v1", schemaVersion: "speaking-feedback-v1", idempotencyKey: feedbackJob.idempotencyKey },
      apply: async (output) => { persistedHolder.value = await persistFeedback({ ...session, responseText: event.text, answerId }, answerId, feedbackJob.id, output); },
    });
    const persisted = persistedHolder.value;
    if (!persisted) throw new Error("纠错结果未写入");
    await db.insert(speakingAttempts).values({ id: event.clientEventId, sessionId: session.id, attemptType: "response", text: event.text, passed: persisted.feedback.items.length === 0, aiJobId: feedbackJob.id, createdAt: now }).onConflictDoNothing({ target: speakingAttempts.id });
    await db.insert(speakingEvents).values({ id: event.clientEventId, sessionId: session.id, eventType: event.type, payloadJson: JSON.stringify({ length: event.text.length }), createdAt: now }).onConflictDoNothing({ target: speakingEvents.id });
    await runGapPipeline(session, answerId, persisted.versionId, result.runId, storedSpeakingFeedbackSchema.parse(persisted.feedback), persisted.sentences);
    if (!persisted.feedback.items.length) await db.insert(questionAttempts).values({ id: stableId("attempt", session.id, "completed"), questionId: session.questionId, status: "completed", origin: "answer", createdAt: now }).onConflictDoNothing();
    return (await getSpeakingSession(session.id))!;
  } catch (reason) {
    await db.update(speakingSessions).set({ status: "failed", updatedAt: new Date().toISOString() }).where(eq(speakingSessions.id, session.id));
    throw normalizeAiError(reason);
  }
}

async function handleRetry(session: SpeakingSessionView, event: Extract<SpeakingEvent, { type: "submit_retry" }>) {
  if (session.status !== "retrying" || !session.feedback) throw new SpeakingServiceError("当前没有需要重说的句子", 409, "invalid_state");
  const item = session.feedback.items.find((candidate) => candidate.id === event.itemId && !candidate.resolved);
  if (!item) throw new SpeakingServiceError("纠错项不存在或已经完成", 409, "retry_item_unavailable");
  const db = await getDbReady();
  const retryJob = await enqueueAiJob({ kind: "speaking_retry", targetType: "speaking_session", targetId: session.id, payload: { sessionId: session.id, itemId: item.id, eventId: event.clientEventId }, promptVersion: "speaking-retry-v1", schemaVersion: "speaking-retry-v1" });
  const provider = createAiProvider({ mockResolver: runtimeAnswerMockResolver });
  const outputHolder: { value: { passed: boolean; feedbackZh: string; acceptedSentence: string } | null } = { value: null };
  await runSingleAiJob({
    jobId: retryJob.id,
    provider,
    request: { role: "corrector", instructions: readPrompt("speaking_retry.corrector.v1.md"), input: JSON.stringify({ question: session.question, originalSentence: item.originalSentence, problem: item.reasonZh, recommendedSentence: item.recommendedSentence, retryText: event.text }), schema: speakingRetryOutputSchema, schemaName: "speaking_retry_v1", promptVersion: "speaking-retry-v1", schemaVersion: "speaking-retry-v1", idempotencyKey: retryJob.idempotencyKey },
    apply: async (output) => { outputHolder.value = output; },
  });
  const outputResult = outputHolder.value;
  if (!outputResult) throw new Error("重说判定未返回");
  const passed = outputResult.passed;
  const nextItems = session.feedback.items.map((candidate) => candidate.id === item.id ? { ...candidate, resolved: candidate.resolved || passed, retryCount: candidate.retryCount + 1, lastRetryFeedback: outputResult!.feedbackZh } : candidate);
  const nextActive = nextItems.find((candidate) => !candidate.resolved)?.id ?? null;
  const status = nextActive ? "retrying" : "completed";
  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx.update(speakingSessions).set({ feedbackJson: JSON.stringify({ ...storedSpeakingFeedbackSchema.parse(session.feedback!), items: nextItems }), activeRetryItemId: nextActive, status, updatedAt: now }).where(eq(speakingSessions.id, session.id));
    await tx.insert(speakingAttempts).values({ id: event.clientEventId, sessionId: session.id, attemptType: "retry", feedbackItemId: item.id, text: event.text, passed, aiJobId: retryJob.id, createdAt: now }).onConflictDoNothing({ target: speakingAttempts.id });
    await tx.insert(speakingEvents).values({ id: event.clientEventId, sessionId: session.id, eventType: event.type, payloadJson: JSON.stringify({ itemId: item.id, passed }), createdAt: now }).onConflictDoNothing({ target: speakingEvents.id });
    if (!nextActive) await tx.insert(questionAttempts).values({ id: stableId("attempt", session.id, "completed"), questionId: session.questionId, status: "completed", origin: "answer", createdAt: now }).onConflictDoNothing();
  });
  return (await getSpeakingSession(session.id))!;
}

async function completeConversation(session: SpeakingSessionView, event: Extract<SpeakingEvent, { type: "complete_conversation" }>) {
  if (!['teacher_chat_v1', 'teacher_chat_v2'].includes(session.experienceVersion) || !["ready", "conversing", "ai_failed"].includes(session.status)) {
    throw new SpeakingServiceError("当前会话不能结束", 409, "invalid_state");
  }
  const userMessages = session.messages.filter((message) => message.role === "user" && message.status === "sent"
    && (session.experienceVersion === "teacher_chat_v1" || message.metadata.speakingSessionId === session.id));
  if (!userMessages.length) throw new SpeakingServiceError("请至少回答一次再结束本轮", 409, "empty_conversation");
  const rawText = userMessages.map((message) => message.text).join("\n\n");
  const hasEnglish = /[A-Za-z]/.test(rawText);
  const hasChinese = /[\u3400-\u9fff]/.test(rawText);
  const inputLanguage = hasEnglish && hasChinese ? "mixed" as const : hasEnglish ? "en" as const : "zh" as const;
  const db = await getDbReady();
  try {
    await db.update(speakingSessions).set({ status: "evaluating", lastError: null, updatedAt: new Date().toISOString() }).where(eq(speakingSessions.id, session.id));
    const created = await createPersonalAnswer({
      clientRequestId: event.clientEventId,
      questionId: session.questionId,
      inputLanguage,
      rawText,
    });
    if (!created.answer) throw new Error("对话回答没有成功保存");
    const processed = await processPersonalAnswer(created.answer.id, event.clientEventId, true, { compilePersonalChunks: false });
    if (!processed) throw new Error("对话回答处理后无法读取");
    if (!processed.currentVersionId) throw new Error("对话回答缺少确认英文版本");
    await runSpeakingGapPipeline({
      sessionId: session.id,
      answerId: processed.id,
      answerVersionId: processed.currentVersionId,
      question: session.question,
      rawMessages: userMessages.map((message) => ({
        id: message.id,
        text: message.text,
        inputLanguage: message.inputLanguage,
        messageKind: message.messageKind,
      })),
      completionEventId: event.clientEventId,
    });
    await runSpeakingMaterialPipeline({
      answerId: processed.id,
      answerVersionId: processed.currentVersionId,
      questionId: session.questionId,
      question: session.question,
      completionEventId: event.clientEventId,
    });
    const now = new Date().toISOString();
    await db.transaction(async (tx) => {
      await tx.update(speakingSessions).set({
        answerId: created.answer!.id,
        sourceAttemptId: `attempt_${event.clientEventId.replaceAll("-", "")}`,
        responseText: rawText,
        status: "completed",
        lastError: null,
        updatedAt: now,
      }).where(eq(speakingSessions.id, session.id));
      await tx.insert(speakingEvents).values({
        id: event.clientEventId,
        sessionId: session.id,
        eventType: event.type,
        payloadJson: JSON.stringify({ messageCount: userMessages.length, answerId: created.answer!.id }),
        createdAt: now,
      }).onConflictDoNothing({ target: speakingEvents.id });
      if (session.experienceVersion === "teacher_chat_v2" && session.companionThreadId) {
        await tx.insert(companionMessages).values({
          id: stableId("companion_message", session.id, event.clientEventId, "complete"),
          threadId: session.companionThreadId,
          sequenceNo: nextMessageSequence(session.messages),
          role: "teacher",
          messageKind: "text",
          text: "这轮先到这里。你的原始表达和独立审核后的 Gap 已经保留；通过双语境审核的表达也已进入本题学习包。",
          inputLanguage: "zh",
          status: "sent",
          clientMessageId: `${session.id}:${event.clientEventId}:complete`,
          sourceType: "speaking_session",
          sourceId: session.id,
          metadataJson: JSON.stringify({ speakingSessionId: session.id, purpose: "completion", generated: false }),
          createdAt: now,
        }).onConflictDoNothing({ target: [companionMessages.threadId, companionMessages.clientMessageId] });
      } else {
        await tx.insert(speakingMessages).values({
          id: stableId("speaking_message", session.id, event.clientEventId, "complete"),
          sessionId: session.id,
          sequenceNo: nextMessageSequence(session.messages),
          role: "teacher",
          messageKind: "text",
          text: "这轮先到这里。你的原始表达和独立审核后的 Gap 已经保留；通过双语境审核的表达也已进入本题学习包。",
          inputLanguage: "zh",
          status: "sent",
          clientMessageId: `${event.clientEventId}:complete`,
          metadataJson: JSON.stringify({ purpose: "completion", generated: false }),
          createdAt: now,
        }).onConflictDoNothing({ target: [speakingMessages.sessionId, speakingMessages.clientMessageId] });
      }
    });
    if (session.experienceVersion === "teacher_chat_v2" && session.companionThreadId) {
      await extractCompanionMemoriesOnClose(session.companionThreadId).catch(() => []);
    }
    return (await getSpeakingSession(session.id))!;
  } catch (reason) {
    await db.update(speakingSessions).set({ status: "ai_failed", lastError: safeErrorSummary(reason), updatedAt: new Date().toISOString() }).where(eq(speakingSessions.id, session.id));
    throw normalizeAiError(reason);
  }
}

export async function applySpeakingEvent(sessionId: string, event: SpeakingEvent) {
  const db = await getDbReady();
  const [existing] = await db.select({ id: speakingEvents.id }).from(speakingEvents).where(eq(speakingEvents.id, event.clientEventId)).limit(1);
  if (existing) return getSpeakingSession(sessionId);
  const session = await getSpeakingSession(sessionId);
  if (!session) throw new SpeakingServiceError("输出会话不存在", 404, "session_not_found");
  if (event.type === "reveal_hint") {
    if (!['ready', 'retrying', 'conversing'].includes(session.status)) throw new SpeakingServiceError("当前不能展开提示", 409, "invalid_state");
    const now = new Date().toISOString();
    await db.transaction(async (tx) => {
      await tx.update(speakingSessions).set({ hintLevel: Math.max(session.hintLevel, event.level), updatedAt: now }).where(eq(speakingSessions.id, sessionId));
      await tx.insert(speakingEvents).values({ id: event.clientEventId, sessionId, eventType: event.type, payloadJson: JSON.stringify({ level: event.level }), createdAt: now });
    });
    return getSpeakingSession(sessionId);
  }
  if (event.type === "submit_response") return handleResponse(session, event);
  if (event.type === "submit_retry") return handleRetry(session, event);
  return completeConversation(session, event);
}
