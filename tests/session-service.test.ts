import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { assertInsideTestResults, prepareTestDatabase } from "./helpers/temp-db";

const testDatabase = prepareTestDatabase("session-service");
assertInsideTestResults(testDatabase.file);
process.env.ROASTDUCK_DB = testDatabase.url;
process.env.ROASTDUCK_SKIP_DB_BACKUP = "1";

let service: typeof import("@/lib/learning/session-service");
let db: Awaited<ReturnType<typeof import("@db/client").getDbReady>>;
let schema: typeof import("@db/schema");

async function insertSession(id: string) {
  await db.insert(schema.learningSessions).values({
    id,
    sessionDate: "2026-08-30",
    mode: "learn",
    status: "active",
    queueJson: JSON.stringify(["c_000000000001"]),
    currentIndex: 0,
    step: "context_audio_input",
    stepVersion: 1,
    experienceVersion: "context_audio_v2",
    scopeType: "daily",
    stateJson: "{}",
  });
}

async function reachTranscript(id: string, rating: "understood" | "unsure" | "not_understood") {
  const comprehension = await service.applySessionEvent(id, {
    type: "mark_audio_heard",
    clientEventId: randomUUID(),
    playback: "played",
  });
  expect(comprehension.step.type).toBe("comprehension_rating");
  return service.applySessionEvent(id, {
    type: "rate_comprehension",
    clientEventId: randomUUID(),
    rating,
  });
}

async function reachPractice(id: string, rating: "understood" | "unsure" | "not_understood") {
  const transcript = await reachTranscript(id, rating);
  expect(transcript.step.type).toBe("transcript_replay");
  const chunk = await service.applySessionEvent(id, { type: "continue_to_chunk", clientEventId: randomUUID() });
  expect(chunk.step.type).toBe("chunk_reveal");
  const shadowing = await service.applySessionEvent(id, { type: "continue_to_shadowing", clientEventId: randomUUID() });
  expect(shadowing.step.type).toBe("shadowing");
  const recall = await service.applySessionEvent(id, {
    type: "complete_shadowing",
    clientEventId: randomUUID(),
    attempts: 1,
    microphoneMode: "recorded",
    fallbackReason: null,
  });
  expect(recall.step.type).toBe("contextual_recall");
  return service.applySessionEvent(id, {
    type: "complete_contextual_recall",
    clientEventId: randomUUID(),
    attempts: 1,
    microphoneMode: "recorded",
    fallbackReason: null,
  });
}

beforeAll(async () => {
  const clientModule = await import("@db/client");
  schema = await import("@db/schema");
  service = await import("@/lib/learning/session-service");
  db = await clientModule.getDbReady();
  await db.insert(schema.books).values({
    id: "book_test",
    titleZh: "测试词书",
    titleEn: "Test Book",
    sourceType: "question_bank",
    status: "beta",
    defaultAccent: "en-US",
  });
  await db.insert(schema.topics).values({
    id: "topic_test",
    bookId: "book_test",
    nameZh: "学习",
    nameEn: "Study",
    ieltsPart: 1,
    status: "audited",
  });
  await db.insert(schema.questions).values({
    id: "question_test",
    bookId: "book_test",
    topicId: "topic_test",
    part: 1,
    text: "What helps you keep learning?",
    textZh: "什么能帮助你坚持学习？",
    normText: "what helps you keep learning",
    status: "audited",
  });
  const chunks = [
    ["c_000000000001", "make steady progress", "取得稳定进步"],
    ["c_000000000002", "build a useful habit", "养成有用的习惯"],
    ["c_000000000003", "learn from mistakes", "从错误中学习"],
    ["c_000000000004", "stay focused", "保持专注"],
  ] as const;
  for (let index = 0; index < chunks.length; index += 1) {
    const [id, display, meaning] = chunks[index];
    await db.insert(schema.chunks).values({
      id,
      bookId: "book_test",
      canonicalChunk: display,
      displayChunk: display,
      unitType: "lexical_chunk",
      meaningZh: meaning,
      englishGloss: "a useful spoken expression",
      qualityStatus: "approved",
      reviewProvenance: "human_reviewer",
      reviewerVersion: "test",
      reviewedAt: new Date().toISOString(),
      createdAt: `2026-01-01T00:00:0${index}.000Z`,
    });
    await db.insert(schema.chunkExamples).values({
      id: `example_${index}`,
      chunkId: id,
      textEn: index === 0 ? "I make steady progress every day." : `I ${display} every day.`,
      textZh: index === 0 ? "我每天都取得稳定进步。" : meaning,
      generated: 1,
      contextType: "generated_ielts",
    });
    await db.insert(schema.chunkPronunciations).values({
      id: `pronunciation_${index}`,
      chunkId: id,
      ipa: "meɪk ˈstedi ˈprɑːɡres",
      accent: "en-US",
      source: "test",
      isPrimary: 1,
    });
    await db.insert(schema.chunkQuestionLinks).values({
      chunkId: id,
      questionId: "question_test",
      relation: "coverage",
      answerDimensionId: "routine",
    });
  }
  await db.insert(schema.textAnnotations).values({
    id: "annotation_target",
    contentType: "example",
    contentId: "example_0",
    startOffset: 2,
    endOffset: 22,
    surface: "make steady progress",
    chunkId: "c_000000000001",
    meaningZh: "取得稳定进步",
    accent: "en-US",
  });
});

describe("语境盲听 V2 学习会话", () => {
  it("首屏和理解判断接口不泄露文本，音频文本只在服务端读取", async () => {
    await db.insert(schema.userSettings).values({ id: 1 }).onConflictDoNothing();
    await db.update(schema.userSettings).set({ autoCollectDifficulties: false, autoPlay: false });
    const id = randomUUID();
    await insertSession(id);
    const initial = await service.getSessionView(id);
    expect(initial.step.type).toBe("context_audio_input");
    if (initial.step.type !== "context_audio_input") throw new Error("预期语境盲听步骤");
    expect(initial.step.autoPlay).toBe(false);
    expect(initial.step.lineCount).toBe(2);
    const serialized = JSON.stringify(initial.step);
    expect(serialized).not.toContain("make steady progress");
    expect(serialized).not.toContain("取得稳定进步");
    expect(serialized).not.toContain("What helps you keep learning");
    expect(initial.step).not.toHaveProperty("chunk");
    expect(initial.step).not.toHaveProperty("context");

    const privateAudio = await service.getSessionAudioSpec(id, initial.step.stepVersion);
    expect(privateAudio.accent).toBe("en-US");
    expect(privateAudio.text).toContain("What helps you keep learning?");
    expect(privateAudio.text).toContain("I make steady progress every day.");

    const comprehension = await service.applySessionEvent(id, {
      type: "mark_audio_heard",
      clientEventId: randomUUID(),
      stepVersion: initial.step.stepVersion,
      playback: "played",
    });
    expect(comprehension.step.type).toBe("comprehension_rating");
    expect(JSON.stringify(comprehension.step)).not.toContain("make steady progress");
    await expect(service.getSessionAudioSpec(id, initial.step.stepVersion)).rejects.toMatchObject({ code: "stale_step" });
    await db.update(schema.userSettings).set({ autoPlay: true });
  });

  it("默认不自动记难点；主动开启后理解诊断才会记录", async () => {
    await db.update(schema.userSettings).set({ autoCollectDifficulties: false });
    const before = await db.select().from(schema.difficultNotes);
    const firstId = randomUUID();
    await insertSession(firstId);
    const transcript = await reachTranscript(firstId, "not_understood");
    expect(transcript.step.type).toBe("transcript_replay");
    expect(await db.select().from(schema.difficultNotes)).toHaveLength(before.length);

    await db.update(schema.userSettings).set({ autoCollectDifficulties: true });
    const secondId = randomUUID();
    await insertSession(secondId);
    await reachTranscript(secondId, "unsure");
    expect(await db.select().from(schema.difficultNotes)).toHaveLength(before.length + 1);
    await db.update(schema.userSettings).set({ autoCollectDifficulties: false });
  });

  it("打开英文小卡本身始终是只读行为", async () => {
    const before = await db.select().from(schema.difficultNotes);
    const first = await import("@/lib/learning/content").then(({ openLookup }) => openLookup("annotation_target"));
    const second = await import("@/lib/learning/content").then(({ openLookup }) => openLookup("annotation_target"));
    expect(first?.display).toBe("make steady progress");
    expect(second?.display).toBe("make steady progress");
    expect(await db.select().from(schema.difficultNotes)).toHaveLength(before.length);
  });

  it.each([
    ["understood", 1],
    ["unsure", 2],
    ["not_understood", 3],
  ] as const)("%s 经相同揭示流程并生成 %i 项练习", async (rating, practiceTotal) => {
    const id = randomUUID();
    await insertSession(id);
    const transcript = await reachTranscript(id, rating);
    expect(transcript.step.type).toBe("transcript_replay");
    if (transcript.step.type !== "transcript_replay") throw new Error("预期文本回放步骤");
    expect(transcript.step.context.lines).toHaveLength(2);
    expect(transcript.step).not.toHaveProperty("chunk");

    const chunk = await service.applySessionEvent(id, { type: "continue_to_chunk", clientEventId: randomUUID() });
    expect(chunk.step.type).toBe("chunk_reveal");
    if (chunk.step.type !== "chunk_reveal") throw new Error("预期 Chunk 揭示步骤");
    expect(chunk.step.chunk.meaningZh).toBe("取得稳定进步");

    await service.applySessionEvent(id, { type: "continue_to_shadowing", clientEventId: randomUUID() });
    const recall = await service.applySessionEvent(id, {
      type: "complete_shadowing",
      clientEventId: randomUUID(),
      attempts: 1,
      microphoneMode: "recorded",
      fallbackReason: null,
    });
    expect(recall.step.type).toBe("contextual_recall");
    expect(JSON.stringify(recall.step)).not.toContain("I make steady progress every day.");
    const practice = await service.applySessionEvent(id, {
      type: "complete_contextual_recall",
      clientEventId: randomUUID(),
      attempts: 1,
      microphoneMode: "recorded",
      fallbackReason: null,
    });
    expect(practice.step.type).toBe("guided_practice");
    if (practice.step.type === "guided_practice") expect(practice.step.practiceTotal).toBe(practiceTotal);
  });

  it("拒绝非法状态转换", async () => {
    const id = randomUUID();
    await insertSession(id);
    await expect(service.applySessionEvent(id, { type: "continue_to_shadowing", clientEventId: randomUUID() })).rejects.toMatchObject({ status: 409, code: "invalid_transition" });
  });

  it("放弃活动会话可幂等重放，且不会提前写入复习进度", async () => {
    const id = randomUUID();
    await insertSession(id);
    const before = await db.select().from(schema.learningProgress);
    await service.abandonSession(id);
    await service.abandonSession(id);
    await expect(service.getSessionView(id)).rejects.toMatchObject({ status: 409, code: "session_abandoned" });
    const row = (await db.select().from(schema.learningSessions)).find((item) => item.id === id);
    expect(row?.status).toBe("abandoned");
    expect(await db.select().from(schema.learningProgress)).toHaveLength(before.length);
  });

  it("错误练习留在当前题；整轮后依次进入结果、调度和完成", async () => {
    const id = randomUUID();
    await insertSession(id);
    let view = await reachPractice(id, "not_understood");
    expect(view.step.type).toBe("guided_practice");
    if (view.step.type !== "guided_practice") throw new Error("预期练习步骤");

    const wrongEventId = randomUUID();
    view = await service.applySessionEvent(id, { type: "submit_practice", clientEventId: wrongEventId, practiceId: view.step.practice.id, answer: "wrong" });
    expect(view.step.type).toBe("guided_practice");
    if (view.step.type !== "guided_practice") throw new Error("错误后必须留在练习");
    expect(view.step.practice.attempt).toBe(1);
    expect(view.step.practice.feedback?.status).toBe("incorrect");
    const replayed = await service.applySessionEvent(id, { type: "submit_practice", clientEventId: wrongEventId, practiceId: view.step.practice.id, answer: "wrong" });
    if (replayed.step.type !== "guided_practice") throw new Error("幂等重放应保留步骤");
    expect(replayed.step.practice.attempt).toBe(1);
    expect(await db.select().from(schema.learningProgress)).toHaveLength(0);

    while (view.step.type === "guided_practice") {
      const task = view.step.practice;
      const answer = task.kind === "meaning_recognition"
        ? task.options.find((option) => option.label === "取得稳定进步")?.id ?? ""
        : task.kind === "translation_reconstruction"
          ? "I make steady progress every day."
          : "make steady progress";
      view = await service.applySessionEvent(id, { type: "submit_practice", clientEventId: randomUUID(), practiceId: task.id, answer });
    }
    expect(view.step.type).toBe("outcome");
    expect(await db.select().from(schema.learningProgress)).toHaveLength(1);
    expect(await db.select().from(schema.reviewLog)).toHaveLength(1);

    view = await service.applySessionEvent(id, { type: "continue_outcome", clientEventId: randomUUID() });
    expect(view.step.type).toBe("scheduled");
    view = await service.applySessionEvent(id, { type: "continue_scheduled", clientEventId: randomUUID() });
    expect(view.step.type).toBe("complete");
  });
});
