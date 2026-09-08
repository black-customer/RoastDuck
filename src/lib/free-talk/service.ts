import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { desc, eq, sql } from "drizzle-orm";
import { getDbReady, withDbTransaction } from "@db/client";
import {
  freeTalkConversations,
  freeTalkMessages,
} from "@db/schema";
import { createAiProvider } from "@/lib/ai/provider-factory";
import { runtimeAnswerMockResolver } from "@/lib/answers/runtime-mock";
import { executeAuditedAiCall } from "@/lib/ai/job-service";
import {
  freeTalkAiResponseSchema,
  type CreateFreeTalkConversation,
  type FreeTalkAiResponse,
  type FreeTalkMode,
} from "./schemas";

function stableId(prefix: string, ...parts: string[]) {
  return `${prefix}_${createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 24)}`;
}

function readPrompt(filename: string): string {
  return fs.readFileSync(path.join(process.cwd(), "pipeline", "prompts", filename), "utf8");
}

export class FreeTalkServiceError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
  }
}

export async function createFreeTalkConversation(
  input: CreateFreeTalkConversation,
) {
  const db = await getDbReady();
  const id = `ft_conv_${randomUUID().replaceAll("-", "")}`;
  const now = new Date().toISOString();

  await db.insert(freeTalkConversations).values({
    id,
    title: input.title || "AI Free Talk",
    mode: input.mode,
    status: "active",
    createdAt: now,
    updatedAt: now,
  });

  const welcomeText =
    input.mode === "strict"
      ? "Hi there! I'm Chloe, your American English conversation tutor. In Strict Mode, we'll have a natural chat, but whenever you stumble upon a key expression or use Chinese, I'll teach it to you and ask you to try saying it once. What's on your mind today?"
      : "Hi there! I'm Chloe. Let's chat about anything you like! Don't worry about being perfect—if you get stuck on a word, feel free to use Chinese and keep the conversation flowing. What would you like to talk about today?";

  const openingMsgId = `ft_msg_${randomUUID().replaceAll("-", "")}`;
  await db.insert(freeTalkMessages).values({
    id: openingMsgId,
    conversationId: id,
    sequenceNo: 1,
    role: "assistant",
    text: welcomeText,
    teachingState: null,
    targetRepetition: null,
    gapCount: 0,
    metadataJson: JSON.stringify({ isWelcome: true }),
    createdAt: now,
  });

  return getFreeTalkConversation(id);
}

export async function getFreeTalkConversation(id: string) {
  const db = await getDbReady();
  const [conv] = await db
    .select()
    .from(freeTalkConversations)
    .where(eq(freeTalkConversations.id, id))
    .limit(1);

  if (!conv) return null;
  return {
    id: conv.id,
    title: conv.title,
    mode: conv.mode as FreeTalkMode,
    status: conv.status,
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
  };
}

export async function listFreeTalkConversations() {
  const db = await getDbReady();
  const rows = await db
    .select()
    .from(freeTalkConversations)
    .orderBy(desc(freeTalkConversations.updatedAt));

  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    mode: r.mode as FreeTalkMode,
    status: r.status,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

export async function getFreeTalkMessages(conversationId: string) {
  const db = await getDbReady();
  const rows = await db
    .select()
    .from(freeTalkMessages)
    .where(eq(freeTalkMessages.conversationId, conversationId))
    .orderBy(freeTalkMessages.sequenceNo);

  return rows.map((r) => ({
    id: r.id,
    conversationId: r.conversationId,
    sequenceNo: r.sequenceNo,
    role: r.role as "user" | "assistant",
    text: r.text,
    teachingState: r.teachingState as "repetition_requested" | "repetition_confirmed" | null,
    targetRepetition: r.targetRepetition,
    gapCount: r.gapCount,
    metadata: JSON.parse(r.metadataJson || "{}"),
    createdAt: r.createdAt,
  }));
}

export async function sendFreeTalkMessage(
  conversationId: string, userText: string, modeOverride?: FreeTalkMode,
  options: { clientMessageId?: string; retry?: boolean } = {},
) {
  const requestId = options.clientMessageId ?? randomUUID();
  const token = randomUUID();
  const now = new Date().toISOString();
  const reserved = await withDbTransaction(async () => {
    const db = await getDbReady();
    const conv = await getFreeTalkConversation(conversationId);
    if (!conv) throw new FreeTalkServiceError("对话不存在", 404, "conversation_not_found");
    const history = await getFreeTalkMessages(conversationId);
    const existing = history.find((m) => m.role === "user" && m.metadata.clientMessageId === requestId);
    if (existing && existing.text !== userText) throw new FreeTalkServiceError("消息编号已经用于其他内容", 409, "message_conflict");
    const answered = existing && history.find((m) => m.role === "assistant" && m.metadata.replyTo === existing.id);
    if (answered) return { completed: true as const, user: existing, assistant: answered };
    const unfinished = history.find((m) => m.role === "user" && ["pending","failed"].includes(m.metadata.deliveryStatus));
    if (unfinished && unfinished.id !== existing?.id) throw new FreeTalkServiceError("请先重试上一条保留的消息，再发送新内容", 409, "previous_message_unresolved");
    if (existing?.metadata.deliveryStatus === "pending" && existing.metadata.leaseExpiresAt > now) throw new FreeTalkServiceError("上一条消息正在处理，请稍候", 409, "message_busy");
    if (existing && !options.retry) throw new FreeTalkServiceError("这条消息已保留，请显式重试", 409, "message_retry_required");
    const mode = modeOverride ?? conv.mode;
    const userId = existing?.id ?? stableId("ft_user", conversationId, requestId);
    const sequence = existing?.sequenceNo ?? (history.at(-1)?.sequenceNo ?? 0) + 1;
    const metadata = { ...existing?.metadata, previousMessageId:existing?.metadata.previousMessageId??history.at(-1)?.id??null,clientMessageId: requestId, deliveryStatus: "pending", leaseToken: token, leaseExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString() };
    if (existing) await db.update(freeTalkMessages).set({ metadataJson: JSON.stringify(metadata) }).where(eq(freeTalkMessages.id, userId));
    else await db.insert(freeTalkMessages).values({ id: userId, conversationId, sequenceNo: sequence, role: "user", text: userText, metadataJson: JSON.stringify(metadata), createdAt: now });
    const lastAssistant = history.filter((m) => m.role === "assistant").at(-1);
    return { completed: false as const, mode, userId, sequence, metadata, history: [...history.filter((m) => m.id !== userId).slice(-7), { role: "user", text: userText }],
      previousTeachingState: lastAssistant?.teachingState ?? null, previousTargetRepetition: lastAssistant?.targetRepetition ?? null };
  });
  if (reserved.completed) return { assistantMessage: reserved.assistant, userMessageId: reserved.user.id, userCorrection: reserved.user.metadata.userCorrection, gaps: reserved.assistant.metadata.gaps ?? [] };
  const { mode, userId, metadata } = reserved;let deliveredConversationId=conversationId;
  try {
    const db = await getDbReady();
    // 只有经过材料 Reviewer 的到期表达才可带入，最多一项；候选不冒充已确认 Gap。
    const knownItems = await db.all<{ canonicalKey: string; targetEnglish: string; intentionZh: string }>(sql`
      SELECT i.canonical_key AS canonicalKey,i.target_english AS targetEnglish,i.intention_zh AS intentionZh
      FROM learning_items i JOIN learning_item_schedule p ON p.learning_item_id=i.id
      WHERE i.status='active' AND p.due_at<=${now}
        AND EXISTS(SELECT 1 FROM practice_material_items mi JOIN practice_materials pm ON pm.id=mi.material_id WHERE mi.learning_item_id=i.id AND pm.status='ready')
      ORDER BY p.due_at LIMIT 1`);
    const generated = await executeAuditedAiCall(createAiProvider({ mockResolver: runtimeAnswerMockResolver }), null, {
      role: "free_talk_tutor", instructions: readPrompt("free_talk_response.chloe.v1.md"),
      input: JSON.stringify({ mode, userText, previousTeachingState: reserved.previousTeachingState, previousTargetRepetition: reserved.previousTargetRepetition, recentHistory: reserved.history, knownLearningItems: knownItems }),
      schema: freeTalkAiResponseSchema, schemaName: "free_talk_response_v1",
      promptVersion: "free-talk-tutor-v1", schemaVersion: "free-talk-response-v1",
      idempotencyKey: stableId("ft_resp", conversationId, requestId),
    }, { maxAttempts: 1 });
    const data: FreeTalkAiResponse = generated.data;
    const assistantId = stableId("ft_assistant", conversationId, requestId);
    await withDbTransaction(async () => {
      const tx = await getDbReady();
      const [owner] = await tx.select().from(freeTalkMessages).where(eq(freeTalkMessages.id, userId));
      if (!owner || JSON.parse(owner.metadataJson).leaseToken !== token) throw new FreeTalkServiceError("旧回复已经由新重试接替", 409, "message_lease_lost");
      deliveredConversationId=owner.conversationId;
      await tx.insert(freeTalkMessages).values({ id: assistantId, conversationId:deliveredConversationId, sequenceNo: owner.sequenceNo + 1, role: "assistant", text: data.reply,
        teachingState: data.teachingState, targetRepetition: data.targetRepetition, gapCount: data.gapCount,
        metadataJson: JSON.stringify({ replyTo: userId,previousMessageId:userId, runId: generated.runId, translationZh: data.translationZh, gaps: data.gaps, learningItems: data.learningItems, reviewStatus: "candidate", resurfacedItemKey: data.resurfacedItemKey }) });
      await tx.update(freeTalkMessages).set({ metadataJson: JSON.stringify({ ...metadata, deliveryStatus: "completed", leaseToken: null, leaseExpiresAt: null, userCorrection: data.userCorrection }) }).where(eq(freeTalkMessages.id, userId));
      await tx.update(freeTalkConversations).set({ mode, updatedAt: new Date().toISOString() }).where(eq(freeTalkConversations.id, deliveredConversationId));
      // 候选只保留在消息快照；复盘独立审核通过后才写 learning_items/gap_events。
    });
    const assistantMessage = (await getFreeTalkMessages(deliveredConversationId)).find((m) => m.id === assistantId)!;
    return { assistantMessage, userMessageId: userId, userCorrection: data.userCorrection, gaps: data.gaps };
  } catch (error) {
    await withDbTransaction(async () => {
      const tx = await getDbReady();
      const [owner] = await tx.select().from(freeTalkMessages).where(eq(freeTalkMessages.id, userId));
      if (owner && JSON.parse(owner.metadataJson).leaseToken === token) await tx.update(freeTalkMessages).set({ metadataJson: JSON.stringify({ ...metadata, deliveryStatus: "failed", leaseToken: null, leaseExpiresAt: null }) }).where(eq(freeTalkMessages.id, userId));
    });
    if (error instanceof FreeTalkServiceError) throw error;
    throw new FreeTalkServiceError("回复暂时不可用，原消息已保存，请原地重试", 503, "message_service_failed");
  }
}
