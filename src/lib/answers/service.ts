import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { getDbReady } from "@db/client";
import { aiJobs, answerVersions, personalAnswers, questionAttempts, questions } from "@db/schema";
import { enqueueAiJob } from "@/lib/ai/job-service";
import type { AnswerInputLanguage } from "./schemas";

export class AnswerServiceError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
  }
}

export interface AnswerVersionView {
  id: string;
  versionNo: number;
  kind: "raw" | "raw_transcript" | "normalized_transcript" | "ai_revised" | "user_edited";
  textEn: string;
  textZh: string;
  changes: string[];
  sourceJobId: string | null;
  createdAt: string;
}

export interface PersonalAnswerView {
  id: string;
  questionId: string;
  inputLanguage: AnswerInputLanguage;
  rawText: string;
  status: string;
  currentVersionId: string | null;
  createdAt: string;
  updatedAt: string;
  recovery?: { revisionId: string; replacements: Array<{ id: string; questionId: string }> } | null;
  question: {
    part: number;
    textEn: string;
    textZh: string;
    topicZh: string;
    topicEn: string;
  };
  versions: AnswerVersionView[];
  job: {
    id: string;
    status: string;
    attempts: number;
    lastErrorCode: string | null;
    updatedAt: string;
  } | null;
}

function parseChanges(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function initialVersionText(language: AnswerInputLanguage, rawText: string) {
  if (language === "en") return { textEn: rawText, textZh: "" };
  return { textEn: "", textZh: rawText };
}

export async function getPersonalAnswer(answerId: string): Promise<PersonalAnswerView | null> {
  const db = await getDbReady();
  const rows = await db.all<Record<string, unknown>>(sql`
    SELECT pa.id, pa.question_id AS questionId, pa.input_language AS inputLanguage,
      pa.raw_text AS rawText, pa.status, pa.current_version_id AS currentVersionId, pa.superseded_by_revision_id AS supersededByRevisionId,
      pa.created_at AS createdAt, pa.updated_at AS updatedAt,
      q.part, q.text AS questionEn, q.text_zh AS questionZh,
      COALESCE(t.name_zh, '') AS topicZh, COALESCE(t.name_en, '') AS topicEn
    FROM personal_answers pa
    JOIN questions q ON q.id = pa.question_id
    LEFT JOIN topics t ON t.id = q.topic_id
    WHERE pa.id = ${answerId} LIMIT 1`);
  const row = rows[0];
  if (!row) return null;
  const [versions, jobs] = await Promise.all([
    db.select().from(answerVersions).where(eq(answerVersions.answerId, answerId)).orderBy(desc(answerVersions.versionNo)),
    db.select().from(aiJobs).where(and(eq(aiJobs.targetType, "personal_answer"), eq(aiJobs.targetId, answerId))).orderBy(desc(aiJobs.updatedAt)).limit(1),
  ]);
  return {
    id: String(row.id),
    questionId: String(row.questionId),
    inputLanguage: String(row.inputLanguage) as AnswerInputLanguage,
    rawText: String(row.rawText),
    status: row.supersededByRevisionId ? "superseded" : String(row.status),
    recovery: row.supersededByRevisionId ? {
      revisionId: String(row.supersededByRevisionId),
      replacements: await db.all<{ id: string; questionId: string }>(sql`SELECT id,question_id AS questionId FROM personal_answers
        WHERE source_revision_id = ${String(row.supersededByRevisionId)} AND source_segment_id = (SELECT source_segment_id FROM personal_answers WHERE id = ${answerId}) ORDER BY source_order`),
    } : null,
    currentVersionId: row.currentVersionId == null ? null : String(row.currentVersionId),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
    question: {
      part: Number(row.part),
      textEn: String(row.questionEn),
      textZh: String(row.questionZh ?? ""),
      topicZh: String(row.topicZh),
      topicEn: String(row.topicEn),
    },
    versions: versions.map((version) => ({
      id: version.id,
      versionNo: version.versionNo,
      kind: version.kind as AnswerVersionView["kind"],
      textEn: version.textEn,
      textZh: version.textZh,
      changes: parseChanges(version.changeSummaryJson),
      sourceJobId: version.sourceJobId,
      createdAt: version.createdAt,
    })),
    job: jobs[0] ? {
      id: jobs[0].id,
      status: jobs[0].status,
      attempts: jobs[0].attempts,
      lastErrorCode: jobs[0].lastErrorCode,
      updatedAt: jobs[0].updatedAt,
    } : null,
  };
}

export async function createPersonalAnswer(input: {
  clientRequestId: string;
  questionId: string;
  inputLanguage: AnswerInputLanguage;
  rawText: string;
}) {
  const db = await getDbReady();
  const [question] = await db.select({ id: questions.id }).from(questions).where(eq(questions.id, input.questionId)).limit(1);
  if (!question) throw new AnswerServiceError("题目不存在", 404, "question_not_found");
  const stableSuffix = input.clientRequestId.replaceAll("-", "");
  const answerId = `answer_${stableSuffix}`;
  const versionId = `answer_version_${stableSuffix}_1`;
  const [existing] = await db.select().from(personalAnswers).where(eq(personalAnswers.id, answerId)).limit(1);
  if (existing && (existing.questionId !== input.questionId || existing.rawText !== input.rawText || existing.inputLanguage !== input.inputLanguage)) {
    throw new AnswerServiceError('此请求 ID 已用于另一份回答', 409, 'request_conflict');
  }
  if (existing && existing.status !== 'draft') return { answer: await getPersonalAnswer(answerId), jobWarning: null };
  const now = new Date().toISOString();
  const versionText = initialVersionText(input.inputLanguage, input.rawText);

  await db.transaction(async (tx) => {
    await tx.insert(personalAnswers).values({
      id: answerId,
      questionId: input.questionId,
      inputLanguage: input.inputLanguage,
      rawText: input.rawText,
      status: "draft",
      currentVersionId: versionId,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoNothing({ target: personalAnswers.id });
    await tx.insert(answerVersions).values({
      id: versionId,
      answerId,
      versionNo: 1,
      kind: "raw",
      ...versionText,
      changeSummaryJson: "[]",
      createdAt: now,
    }).onConflictDoNothing({ target: answerVersions.id });
  });

  let jobWarning: string | null = null;
  try {
    await enqueueAiJob({
      kind: "answer_transform",
      targetType: "personal_answer",
      targetId: answerId,
      payload: { answerId, requestId: input.clientRequestId },
      promptVersion: "answer-transform-v1",
      schemaVersion: "answer-transform-v1",
    });
    await db.update(personalAnswers).set({ status: "queued", updatedAt: now }).where(and(eq(personalAnswers.id, answerId), eq(personalAnswers.status, 'draft')));
  } catch {
    jobWarning = "原始回答已保存，但 AI 任务暂未创建；可在页面中重新处理。";
  }
  await db.insert(questionAttempts).values({
    id: `attempt_${stableSuffix}`,
    questionId: input.questionId,
    status: "started",
    origin: "answer",
    createdAt: now,
  }).onConflictDoNothing({ target: questionAttempts.id });
  return { answer: await getPersonalAnswer(answerId), jobWarning };
}

export async function appendUserAnswerVersion(answerId: string, textEn: string, baseVersionNo: number) {
  const db = await getDbReady();
  const [answer] = await db.select({ id: personalAnswers.id, superseded: personalAnswers.supersededByRevisionId }).from(personalAnswers).where(eq(personalAnswers.id, answerId)).limit(1);
  if (!answer) throw new AnswerServiceError("答案不存在", 404, "answer_not_found");
  if (answer.superseded) throw new AnswerServiceError("此回答已由切分修复后的记录取代，请打开新记录", 409, "answer_superseded");
  const [{ latest }] = await db.select({ latest: sql<number>`COALESCE(MAX(${answerVersions.versionNo}), 0)` })
    .from(answerVersions).where(eq(answerVersions.answerId, answerId));
  const latestVersion = Number(latest);
  if (latestVersion !== baseVersionNo) {
    throw new AnswerServiceError("答案已有更新，请刷新后再保存", 409, "version_conflict");
  }
  const versionNo = latestVersion + 1;
  const id = `answer_version_${randomUUID()}`;
  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx.insert(answerVersions).values({
      id,
      answerId,
      versionNo,
      kind: "user_edited",
      textEn,
      changeSummaryJson: JSON.stringify(["用户手动编辑"]),
      createdAt: now,
    });
    await tx.update(personalAnswers).set({ currentVersionId: id, status: "ready", updatedAt: now }).where(eq(personalAnswers.id, answerId));
  });
  return getPersonalAnswer(answerId);
}

export async function listQuestionAnswerHistory(questionId: string) {
  const db = await getDbReady();
  const rows = await db.select({
    id: personalAnswers.id,
    status: personalAnswers.status,
    inputLanguage: personalAnswers.inputLanguage,
    createdAt: personalAnswers.createdAt,
    updatedAt: personalAnswers.updatedAt,
  }).from(personalAnswers).where(and(eq(personalAnswers.questionId, questionId), isNull(personalAnswers.supersededByRevisionId))).orderBy(desc(personalAnswers.createdAt), desc(personalAnswers.attemptOrder));
  return rows;
}
