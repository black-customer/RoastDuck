import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MockAiProvider } from "@/lib/ai/mock-provider";
import { eq } from "drizzle-orm";
import { assertInsideTestResults, prepareTestDatabase } from "./helpers/temp-db";

const database = prepareTestDatabase("free-talk-service");
assertInsideTestResults(database.file);
process.env.ROASTDUCK_DB = database.url;
process.env.ROASTDUCK_SKIP_DB_BACKUP = "1";
process.env.AI_PROVIDER = "mock";

let db: Awaited<ReturnType<typeof import("@db/client").getDbReady>>;
let schema: typeof import("@db/schema");
let freeTalkService: typeof import("@/lib/free-talk/service");
let practiceService: typeof import("@/lib/speaking-practice/service");
afterEach(() => vi.restoreAllMocks());

beforeAll(async () => {
  schema = await import("@db/schema");
  db = await (await import("@db/client")).getDbReady();
  freeTalkService = await import("@/lib/free-talk/service");
  practiceService = await import("@/lib/speaking-practice/service");

  await db.insert(schema.books).values({
    id: "book1_ielts_complete",
    titleZh: "雅思完整题库",
    titleEn: "IELTS Complete Speaking",
    sourceType: "question_bank",
  }).onConflictDoNothing();

  await db.insert(schema.questions).values({
    id: "q_test_shared",
    bookId: "book1_ielts_complete",
    part: 1,
    text: "Describe your neighbourhood.",
    textZh: "描述你的社区。",
    normText: "describe your neighbourhood",
  }).onConflictDoNothing();
});

describe("AI Free Talk Suite (Spec Section 65)", () => {
  it("Relaxed Mode: recasts naturally without breaking flow, captures gap, no mandatory repetition", async () => {
    const conv = await freeTalkService.createFreeTalkConversation({
      title: "Daily Chat Relaxed",
      mode: "relaxed",
    });
    expect(conv).not.toBeNull();
    if (!conv) return;

    const result = await freeTalkService.sendFreeTalkMessage(
      conv.id,
      "Yesterday I saw a 井盖 on the street.",
    );

    // Natural recast: mentions manhole cover naturally
    expect(result.assistantMessage.text).toContain("manhole cover");
    // No mandatory repetition in relaxed mode
    expect(result.assistantMessage.teachingState).toBeNull();
    expect(result.assistantMessage.targetRepetition).toBeNull();

    // Chinese translation included
    expect(result.assistantMessage.metadata.translationZh).toBeDefined();
    expect(result.assistantMessage.metadata.translationZh).toContain("井盖");

    // Inline user correction diagnosis provided
    expect(result.userCorrection).toBeDefined();
    expect(result.userCorrection?.natural).toBe(false);
    expect(result.userCorrection?.issue).toContain("井盖");

    // Gap captured
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0].targetEnglish).toBe("manhole cover");

    // Conversation messages persisted with metadata
    const messages = await freeTalkService.getFreeTalkMessages(conv.id);
    expect(messages.length).toBe(3); // welcome, user, assistant
    // User message metadata has persisted userCorrection
    expect(messages[1].metadata?.userCorrection?.natural).toBe(false);
    expect(messages[1].metadata?.userCorrection?.betterExpression).toContain("manhole cover");
  });


  it("Strict Mode: teaches expression, requests repetition, confirms on repetition, resumes conversation", async () => {
    const conv = await freeTalkService.createFreeTalkConversation({
      title: "Practice Chat Strict",
      mode: "strict",
    });
    if (!conv) return;

    // Step 1: User introduces gap
    const turn1 = await freeTalkService.sendFreeTalkMessage(
      conv.id,
      "Yesterday I saw a 井盖 on the street.",
    );

    // Strict mode teaches target expression and requests repetition
    expect(turn1.assistantMessage.teachingState).toBe("repetition_requested");
    expect(turn1.assistantMessage.targetRepetition).toContain("manhole cover");
    expect(turn1.assistantMessage.text).toContain("manhole cover");
    expect(turn1.assistantMessage.text).toContain("Try saying that once");

    // Step 2: User repeats the target expression
    const turn2 = await freeTalkService.sendFreeTalkMessage(
      conv.id,
      "I saw a manhole cover on the street.",
    );

    // Assistant confirms repetition and continues conversation
    expect(turn2.assistantMessage.teachingState).toBe("repetition_confirmed");
    expect(turn2.assistantMessage.targetRepetition).toBeNull();
    expect(turn2.assistantMessage.text).toContain("Spot on");
  });

  it("Rate Limiting on Errors: user produces multiple gaps, foreground limits to 1-2 items while preserving data", async () => {
    const conv = await freeTalkService.createFreeTalkConversation({
      title: "Complex Needs",
      mode: "strict",
    });
    if (!conv) return;

    const result = await freeTalkService.sendFreeTalkMessage(
      conv.id,
      "今年准备找实习、转专业，明年还要毕业、租房、做兼职，压力很大。",
    );

    // Backend preserves genuine gaps
    expect(result.gaps.length).toBeGreaterThanOrEqual(3);

    // Foreground assistant text focuses on 1 primary item first
    expect(result.assistantMessage.text).toContain("internship");
    expect(result.assistantMessage.teachingState).toBe("repetition_requested");
  });

  it("聊天候选不直接发布，复盘独立审核后与雅思共享学习项", async () => {
    // 1. Practice exposes "manhole cover"
    await practiceService.createSpeakingAttempt({
      questionId: "q_test_shared",
      mode: "practice",
      answerText: "I saw a 井盖.",
      intendedMeaningZh: "我看到了井盖。",
    });

    const [itemBefore] = await db
      .select()
      .from(schema.learningItems)
      .where(eq(schema.learningItems.canonicalKey, "manhole cover"));

    expect(itemBefore).toBeDefined();
    const countBefore = itemBefore.encounterCount;

    // 2. Free Talk also exposes "manhole cover"
    const conv = await freeTalkService.createFreeTalkConversation({
      title: "Shared Memory Test",
      mode: "relaxed",
    });
    if (!conv) return;

    await freeTalkService.sendFreeTalkMessage(conv.id, "I saw a 井盖 again.");
    expect((await db.select().from(schema.learningItems).where(eq(schema.learningItems.id, itemBefore.id)))[0].encounterCount).toBe(countBefore);
    const materials = await import("@/lib/four-step/materials");
    const messages = (await freeTalkService.getFreeTalkMessages(conv.id)).map(({ id, role, text }) => ({ id, role, text }));
    const material = await materials.prepareMaterial({ sourceType: "free_talk", sourceId: conv.id, question: null, mode: "relaxed", intendedMeaningZh: "", actualAnswer: "I saw a 井盖 again.", sourceMessages: messages });
    expect((await materials.processMaterial(material.id)).status).toBe("ready");

    const [itemAfter] = await db
      .select()
      .from(schema.learningItems)
      .where(eq(schema.learningItems.canonicalKey, "manhole cover"));

    expect(itemAfter).toBeDefined();
    // Encounter count incremented rather than creating a duplicate row
    expect(itemAfter.encounterCount).toBe(countBefore + 1);

    // Provenance tracked in gapEvents
    const events = await db
      .select()
      .from(schema.gapEvents)
      .where(eq(schema.gapEvents.learningItemId, itemAfter.id));

    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events.some((e) => e.sourceType === "ielts_practice")).toBe(true);
    expect(events.some((e) => e.sourceType === "free_talk")).toBe(true);
  });

  it("失败原文保留，稳定消息ID重试不复制，线程内并发不会争抢序号", async () => {
    const conv = (await freeTalkService.createFreeTalkConversation({ title: "失败恢复", mode: "relaxed" }))!;
    const provider = vi.spyOn(MockAiProvider.prototype, "generate").mockRejectedValueOnce(new Error("simulated outage"));
    const text = "I saw a 井盖 outside.";
    await expect(freeTalkService.sendFreeTalkMessage(conv.id, text, "relaxed", { clientMessageId: "failed-once" })).rejects.toMatchObject({ code: "message_service_failed" });
    expect((await freeTalkService.getFreeTalkMessages(conv.id)).at(-1)?.text).toBe(text);
    provider.mockRestore();
    const result = await freeTalkService.sendFreeTalkMessage(conv.id, text, "relaxed", { clientMessageId: "failed-once", retry: true });
    expect((await freeTalkService.sendFreeTalkMessage(conv.id, text, "relaxed", { clientMessageId: "failed-once", retry: true })).assistantMessage.id).toBe(result.assistantMessage.id);
    expect(await freeTalkService.getFreeTalkMessages(conv.id)).toHaveLength(3);
    const results = await Promise.allSettled([
      freeTalkService.sendFreeTalkMessage(conv.id, "First.", "relaxed", { clientMessageId: "parallel-first" }),
      freeTalkService.sendFreeTalkMessage(conv.id, "Second.", "relaxed", { clientMessageId: "parallel-second" }),
    ]);
    expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    const messages = await freeTalkService.getFreeTalkMessages(conv.id);
    expect(new Set(messages.map((m) => m.sequenceNo)).size).toBe(messages.length);
  });

  it("TTS Sentence Chunking & Voice Presets: supports splitSentences and 4 voice options", async () => {
    const { splitSentencesForTts } = await import("@/lib/tts");
    const { VOICE_PRESETS } = await import("@/lib/speech/contracts");

    const text = "I'm a fourth-year student majoring in computer science. I actually started out in chemistry, but later switched to CS! Do you like programming?";
    const chunks = splitSentencesForTts(text);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toBe("I'm a fourth-year student majoring in computer science.");
    expect(chunks[1]).toBe("I actually started out in chemistry, but later switched to CS!");
    expect(chunks[2]).toBe("Do you like programming?");

    expect(VOICE_PRESETS).toHaveLength(4);
    expect(VOICE_PRESETS.map((p) => p.id)).toEqual([
      "us-female",
      "us-male",
      "uk-female",
      "uk-male",
    ]);
  });
});
