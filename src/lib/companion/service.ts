import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { and, desc, eq, like, or, sql } from "drizzle-orm";
import { getDbReady, withDbTransaction } from "@db/client";
import { answerGaps, companionMemories, companionMessages, companionThreads, questions } from "@db/schema";
import { enqueueAiJob, runSingleAiJob } from "@/lib/ai/job-service";
import { normalizeAiError, safeErrorSummary } from "@/lib/ai/errors";
import { createAiProvider } from "@/lib/ai/provider-factory";
import { runtimeAnswerMockResolver } from "@/lib/answers/runtime-mock";
import { buildInteractiveText } from "@/lib/learning/content";
import { annotateRuntimeEnglish, assertRuntimeGlossaryCoverage } from "@/lib/speaking/runtime-annotations";
import {
  companionResponseSchema,
  type CreateCompanionMessage,
  type CreateCompanionThread,
} from "./schemas";

const COMPANION_PROMPT_VERSION = "companion-response-chloe-v1";
export const COMPANION_MESSAGE_LEASE_MS = 10 * 60 * 1000;

function stableId(prefix: string, ...parts: string[]) {
  return `${prefix}_${createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 24)}`;
}


function readPrompt(filename: string) {
  return fs.readFileSync(path.join(process.cwd(), "pipeline", "prompts", filename), "utf8");
}

function parseJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function leaseExpired(metadata: Record<string, unknown>, createdAt: string) {
  const deadline = typeof metadata.leaseExpiresAt === "string"
    ? Date.parse(metadata.leaseExpiresAt)
    : Date.parse(createdAt) + COMPANION_MESSAGE_LEASE_MS;
  return !Number.isFinite(deadline) || deadline <= Date.now();
}

export class CompanionServiceError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) { super(message); }
}

function scopeKey(input: CreateCompanionThread) {
  return input.scopeType === "general" ? "general:default" : `${input.scopeType}:${input.scopeId}`;
}

function defaultTitle(input: CreateCompanionThread) {
  if (input.scopeType === "gap") return "这个表达 · Chloe";
  if (input.scopeType === "question") return "雅思题目 · Chloe";
  return "和 Chloe 聊学习";
}

export async function createOrGetCompanionThread(input: CreateCompanionThread) {
  const db = await getDbReady();
  const key = scopeKey(input);
  const id = stableId("companion", key);
  await db.insert(companionThreads).values({
    id,
    scopeKey: key,
    scopeType: input.scopeType,
    scopeId: input.scopeType === "general" ? null : input.scopeId,
    title: input.title ?? defaultTitle(input),
  }).onConflictDoNothing({ target: companionThreads.scopeKey });
  const [thread] = await db.select().from(companionThreads).where(eq(companionThreads.scopeKey, key)).limit(1);
  if (!thread) throw new CompanionServiceError("Chloe 线程创建失败", 500, "thread_create_failed");
  const openingId = stableId("companion_message", thread.id, "opening-v1");
  await db.insert(companionMessages).values({
    id: openingId,
    threadId: thread.id,
    sequenceNo: 1,
    role: "teacher",
    messageKind: "text",
    text: input.scopeType === "gap"
      ? "我是 Chloe。这个表达哪里不确定都可以直接问我；我会结合当前场景回答，不影响你的学习判定。"
      : input.scopeType === "question"
        ? "我是 Chloe。你可以放心用中文、英文或中英混合回答；我会像学习搭子一样和你来回聊，需要纠错时再切换成教练。"
        : "我是 Chloe，你的美式英语学习搭子。想整理目标、复盘学习，或者问一个表达，都可以从这里开始。",
    inputLanguage: "zh",
    status: "sent",
    clientMessageId: "chloe-opening-v1",
    sourceType: "companion",
    metadataJson: JSON.stringify({ generated: false, persona: "chloe-v1" }),
  }).onConflictDoNothing({ target: [companionMessages.threadId, companionMessages.clientMessageId] });
  return getCompanionThread(thread.id);
}

async function relevantMemories(scopeType: string, scopeId: string | null) {
  const db = await getDbReady();
  return db.select().from(companionMemories).where(and(
    eq(companionMemories.status, "active"),
    or(
      eq(companionMemories.scopeType, "global"),
      and(eq(companionMemories.scopeType, scopeType), scopeId ? eq(companionMemories.scopeId, scopeId) : sql`${companionMemories.scopeId} IS NULL`),
    ),
  )).orderBy(desc(companionMemories.updatedAt)).limit(8);
}

async function dueExpressions(scopeType: string) {
  const limit = scopeType === "question" ? 2 : 1;
  const db = await getDbReady();
  return db.all<{ chunkId: string; expression: string; meaningZh: string }>(sql`
    SELECT DISTINCT c.id AS chunkId,c.display_chunk AS expression,c.meaning_zh AS meaningZh
    FROM learning_progress lp
    JOIN chunks c ON c.id=lp.chunk_id
    JOIN learning_experiment_assignments a ON a.chunk_id=c.id
    WHERE a.experiment_id='gap_retrieval_v3' AND a.status='active' AND lp.intro_done=1
      AND julianday(json_extract(lp.fsrs_json,'$.due')) <= julianday('now')
    ORDER BY json_extract(lp.fsrs_json,'$.due'),c.id LIMIT ${limit}`);
}

async function getScopeContext(scopeType: string, scopeId: string | null) {
  if (!scopeId) return null;
  const db = await getDbReady();
  if (scopeType === "gap") {
    const [gap] = await db.select({ intentZh: answerGaps.intentZh, recommendedExpression: answerGaps.recommendedExpression, explanationZh: answerGaps.explanationZh })
      .from(answerGaps).where(eq(answerGaps.id, scopeId)).limit(1);
    return gap ? { kind: "gap", ...gap } : null;
  }
  if (scopeType === "question") {
    const [question] = await db.select({ text: questions.text, textZh: questions.textZh, part: questions.part })
      .from(questions).where(eq(questions.id, scopeId)).limit(1);
    return question ? { kind: "question", ...question } : null;
  }
  return null;
}

export async function getCompanionThread(threadId: string) {
  const db = await getDbReady();
  const [thread] = await db.select().from(companionThreads).where(eq(companionThreads.id, threadId)).limit(1);
  if (!thread || thread.status === "deleted") return null;
  const [messages, memories] = await Promise.all([
    db.select().from(companionMessages).where(eq(companionMessages.threadId, threadId)).orderBy(companionMessages.sequenceNo),
    relevantMemories(thread.scopeType, thread.scopeId),
  ]);
  return {
    id: thread.id,
    scopeType: thread.scopeType as "gap" | "question" | "general",
    scopeId: thread.scopeId,
    title: thread.title,
    status: thread.status,
    memories: memories.map((memory) => ({ id: memory.id, category: memory.category, summary: memory.summary, confidence: memory.confidence, createdAt: memory.createdAt })),
    messages: await Promise.all(messages.map(async (message) => ({
      id: message.id,
      sequenceNo: message.sequenceNo,
      role: message.role as "user" | "teacher" | "system",
      messageKind: message.messageKind as "text" | "voice",
      text: message.text,
      inputLanguage: message.inputLanguage as "zh" | "en" | "mixed" | null,
      status: message.status as "pending" | "sent" | "failed",
      clientMessageId: message.clientMessageId,
      metadata: parseJson<Record<string, unknown>>(message.metadataJson, {}),
      interactiveText: await buildInteractiveText("speaking_message", message.id, message.text),
      createdAt: message.createdAt,
    }))),
  };
}

export type CompanionThreadView = NonNullable<Awaited<ReturnType<typeof getCompanionThread>>>;

async function extractMemoriesIfDue(thread: CompanionThreadView, force = false) {
  const {webCompanion}=await import('@/lib/app-services/web');
  return (await webCompanion().memory.extract(thread.id,{},force)).map(m=>({id:m.id,category:m.category,summary:m.summary}));
}

export async function sendCompanionMessage(
  threadId: string,
  input: CreateCompanionMessage,
  source: { sourceType?: string; sourceId?: string; metadata?: Record<string, unknown> } = {},
) {
  let thread = await getCompanionThread(threadId);
  if (!thread) throw new CompanionServiceError("Chloe 线程不存在", 404, "thread_not_found");
  const existing = thread.messages.find((message) => message.role === "user" && message.clientMessageId === input.clientMessageId);
  const replied = thread.messages.some((message) => message.role === "teacher" && message.metadata.parentClientMessageId === input.clientMessageId);
  if (replied) return { thread, newMemories: [] };
  if (existing && existing.text !== input.text) throw new CompanionServiceError("相同消息 ID 不能改写原文", 409, "idempotency_conflict");
  if (existing?.status === "sent") throw new CompanionServiceError("这条消息已完成但缺少关联回复", 409, "message_inconsistent");
  if (existing?.status === "pending" && !leaseExpired(existing.metadata, existing.createdAt)) {
    throw new CompanionServiceError("Chloe 正在回复这条消息", 409, "message_in_progress");
  }
  if (existing && !input.retry) throw new CompanionServiceError("这条消息已保留，请显式重试", 409, "message_retry_required");

  const db = await getDbReady();
  const messageId = existing?.id ?? stableId("companion_message", threadId, input.clientMessageId);
  const deliveryAttempt = Number(existing?.metadata.deliveryAttempt ?? 0) + 1;
  const leaseId = randomUUID();
  const leaseExpiresAt = new Date(Date.now() + COMPANION_MESSAGE_LEASE_MS).toISOString();
  await withDbTransaction(async () => {
    const tx = await getDbReady();
    const [current] = await tx.select().from(companionMessages).where(eq(companionMessages.id, messageId)).limit(1);
    if (existing) {
      const currentMeta = current ? parseJson<Record<string, unknown>>(current.metadataJson, {}) : {};
      if (!current || current.status === "sent" || Number(currentMeta.deliveryAttempt ?? 0) !== Number(existing.metadata.deliveryAttempt ?? 0)) {
        throw new CompanionServiceError("消息已被其他请求处理，请刷新", 409, "message_in_progress");
      }
    } else if (current) {
      throw new CompanionServiceError("消息已被其他请求处理，请刷新", 409, "message_in_progress");
    }
    if (existing) {
      await tx.update(companionMessages).set({ status: "pending", metadataJson: JSON.stringify({ ...existing.metadata, ...source.metadata, deliveryAttempt, leaseId, leaseExpiresAt }) }).where(eq(companionMessages.id, messageId));
    } else {
      await tx.insert(companionMessages).values({
        id: messageId,
        threadId,
        sequenceNo: (thread!.messages.at(-1)?.sequenceNo ?? 0) + 1,
        role: "user",
        messageKind: input.messageKind,
        text: input.text,
        inputLanguage: input.inputLanguage,
        status: "pending",
        clientMessageId: input.clientMessageId,
        sourceType: source.sourceType ?? "companion",
        sourceId: source.sourceId,
        metadataJson: JSON.stringify({ ...source.metadata, deliveryAttempt, leaseId, leaseExpiresAt }),
      });
    }
    await tx.update(companionThreads).set({ updatedAt: new Date().toISOString() }).where(eq(companionThreads.id, threadId));
  });
  thread = (await getCompanionThread(threadId))!;

  const [memories, due, scopeContext] = await Promise.all([
    relevantMemories(thread.scopeType, thread.scopeId),
    dueExpressions(thread.scopeType),
    getScopeContext(thread.scopeType, thread.scopeId),
  ]);
  const payload = {
    persona: { name: "Chloe", identity: "AI American English learning partner", accent: "en-US" },
    scope: { type: thread.scopeType, id: thread.scopeId, title: thread.title },
    scopeContext,
    recentMessages: thread.messages.slice(-12).map((message) => ({ role: message.role, text: message.text })),
    latestUserMessage: { text: input.text, inputLanguage: input.inputLanguage, messageKind: input.messageKind },
    relevantMemories: memories.map((memory) => ({ id: memory.id, category: memory.category, summary: memory.summary, sourceType: memory.sourceType, sourceId: memory.sourceId })),
    dueExpressions: due,
  };
  const job = await enqueueAiJob({
    kind: "companion_response",
    targetType: "companion_message",
    targetId: `${messageId}:${deliveryAttempt}`,
    payload,
    promptVersion: COMPANION_PROMPT_VERSION,
    schemaVersion: "companion-response-chloe-v1",
  });
  try {
    await runSingleAiJob({
      jobId: job.id,
      provider: createAiProvider({ mockResolver: runtimeAnswerMockResolver }),
      request: {
        role: "companion_response",
        instructions: readPrompt("companion_response.chloe.v1.md"),
        input: JSON.stringify(payload),
        schema: companionResponseSchema,
        schemaName: "companion_response_chloe_v1",
        promptVersion: COMPANION_PROMPT_VERSION,
        schemaVersion: "companion-response-chloe-v1",
        idempotencyKey: job.idempotencyKey,
      },
      apply: async (output, result) => {
        const teacherMessages = output.messages.map((message, index) => ({
          id: stableId("companion_message", threadId, input.clientMessageId, String(deliveryAttempt), "teacher", String(index)),
          ...message,
          index,
        }));
        assertRuntimeGlossaryCoverage([input.text, ...teacherMessages.map((message) => message.text)], output.glossary);
        await withDbTransaction(async () => {
          const tx = await getDbReady();
          const [owner] = await tx.select().from(companionMessages).where(eq(companionMessages.id, messageId)).limit(1);
          if (!owner || owner.status !== "pending" || parseJson<Record<string, unknown>>(owner.metadataJson, {}).leaseId !== leaseId) {
            throw new CompanionServiceError("旧回复已被新重试取代", 409, "message_lease_lost");
          }
          await Promise.all([
            annotateRuntimeEnglish({ contentType: "speaking_message", contentId: messageId, text: input.text, glossary: output.glossary }),
            ...teacherMessages.map((message) => annotateRuntimeEnglish({ contentType: "speaking_message", contentId: message.id, text: message.text, glossary: output.glossary })),
          ]);
          const current = (await getCompanionThread(threadId))!;
          const start = (current.messages.at(-1)?.sequenceNo ?? 0) + 1;
          await tx.update(companionMessages).set({ status: "sent", aiRunId: result.runId }).where(eq(companionMessages.id, messageId));
          for (const message of teacherMessages) {
            await tx.insert(companionMessages).values({
              id: message.id,
              threadId,
              sequenceNo: start + message.index,
              role: "teacher",
              messageKind: "text",
              text: message.text,
              inputLanguage: "mixed",
              status: "sent",
              clientMessageId: `${input.clientMessageId}:teacher:${deliveryAttempt}:${message.index}`,
              sourceType: "companion",
              sourceId: messageId,
              aiRunId: result.runId,
              metadataJson: JSON.stringify({ parentClientMessageId: input.clientMessageId, purpose: message.purpose, persona: "chloe-v1" }),
            }).onConflictDoNothing({ target: [companionMessages.threadId, companionMessages.clientMessageId] });
          }
          await tx.update(companionThreads).set({ updatedAt: new Date().toISOString() }).where(eq(companionThreads.id, threadId));
        });
      },
    });
  } catch (reason) {
    const [owner] = await db.select().from(companionMessages).where(eq(companionMessages.id, messageId)).limit(1);
    const ownerMeta = owner ? parseJson<Record<string, unknown>>(owner.metadataJson, {}) : {};
    if (owner?.status === "pending" && ownerMeta.leaseId === leaseId) {
      await db.update(companionMessages).set({ status: "failed", metadataJson: JSON.stringify({ ...ownerMeta, error: safeErrorSummary(reason) }) }).where(eq(companionMessages.id, messageId));
    }
    if (owner && ownerMeta.leaseId !== leaseId) {
      throw new CompanionServiceError("旧回复已被新重试取代", 409, "message_lease_lost");
    }
    throw normalizeAiError(reason);
  }
  const completed = (await getCompanionThread(threadId))!;
  const newMemories = await extractMemoriesIfDue(completed).catch(() => []);
  return { thread: (await getCompanionThread(threadId))!, newMemories };
}

export async function listCompanionMemories(query = "") {
  const db = await getDbReady();
  const normalized = query.trim();
  const rows = await db.select().from(companionMemories).where(and(
    eq(companionMemories.status, "active"),
    normalized ? like(companionMemories.summary, `%${normalized.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`) : undefined,
  )).orderBy(desc(companionMemories.updatedAt)).limit(300);
  return rows.map((row) => ({
    id: row.id,
    category: row.category,
    summary: row.summary,
    scopeType: row.scopeType,
    scopeId: row.scopeId,
    confidence: row.confidence,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    evidence: parseJson<string[]>(row.evidenceJson, []),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}

export async function listCompanionThreads() {
  const db = await getDbReady();
  const rows = await db.select().from(companionThreads).where(eq(companionThreads.status, "active")).orderBy(desc(companionThreads.updatedAt)).limit(100);
  return rows.map((row) => ({
    id: row.id,
    scopeType: row.scopeType,
    scopeId: row.scopeId,
    title: row.title,
    updatedAt: row.updatedAt,
  }));
}

export async function extractCompanionMemoriesOnClose(threadId: string) {
  const thread = await getCompanionThread(threadId);
  if (!thread) throw new CompanionServiceError("Chloe 线程不存在", 404, "thread_not_found");
  return extractMemoriesIfDue(thread, true);
}

export async function updateCompanionMemory(input: { id: string; summary?: string; category?: string; status?: "active" | "dismissed" }) {
  const {webCompanion}=await import('@/lib/app-services/web'),memory=webCompanion().memory;
  const current=(await memory.list('',true)).find(row=>row.id===input.id);
  if(!current)throw new CompanionServiceError('记忆不存在',404,'memory_not_found');
  if(input.summary!==undefined||input.category!==undefined){
    const next=await memory.edit(input.id,{clientEventId:stableId('edit',input.id,input.summary??current.summary,input.category??current.category),summary:input.summary??current.summary,category:input.category??current.category});
    return {id:next.id,summary:next.summary,category:next.category,updatedAt:next.updated_at};
  }
  await memory.state(input.id,input.status??'active');
  return {id:current.id,summary:current.summary,category:current.category,updatedAt:current.updated_at};
}
export async function deleteCompanionMemory(id:string) {
  const {webCompanion}=await import('@/lib/app-services/web');
  await webCompanion().memory.state(id,'deleted');
}
export async function clearCompanionMemories() {
  const {webCompanion}=await import('@/lib/app-services/web'),memory=webCompanion().memory;
  const count=(await memory.list('',true)).length;await memory.clear();return count;
}
