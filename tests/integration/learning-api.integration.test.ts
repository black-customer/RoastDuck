import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { assertInsideTestResults, prepareTestDatabase } from "../helpers/temp-db";

const testDatabase = prepareTestDatabase("learning-api.integration");
assertInsideTestResults(testDatabase.file);
process.env.ROASTDUCK_DB = testDatabase.url;
process.env.ROASTDUCK_SKIP_DB_BACKUP = "1";

let createRoute: typeof import("@/app/api/learning/sessions/route");
let eventRoute: typeof import("@/app/api/learning/sessions/[id]/events/route");
let getRoute: typeof import("@/app/api/learning/sessions/[id]/route");
let settingsRoute: typeof import("@/app/api/settings/route");
let aiHealthRoute: typeof import("@/app/api/ai/health/route");

beforeAll(async () => {
  const [{ getDbReady }, schema] = await Promise.all([import("@db/client"), import("@db/schema")]);
  const db = await getDbReady();
  await db.insert(schema.books).values({
    id: "book_api_test",
    titleZh: "API 测试词书",
    titleEn: "API Test Book",
    sourceType: "question_bank",
    status: "beta",
    defaultAccent: "en-US",
  });
  await db.insert(schema.topics).values({
    id: "topic_api_test",
    bookId: "book_api_test",
    nameZh: "学习",
    nameEn: "Study",
    ieltsPart: 1,
    status: "audited",
  });
  await db.insert(schema.questions).values({
    id: "question_api_test",
    bookId: "book_api_test",
    topicId: "topic_api_test",
    part: 1,
    text: "What helps you keep learning?",
    textZh: "什么能帮助你坚持学习？",
    normText: "what helps you keep learning",
    status: "audited",
  });
  await db.insert(schema.chunks).values({
    id: "c_api_sentence_first",
    bookId: "book_api_test",
    canonicalChunk: "make steady progress",
    displayChunk: "make steady progress",
    unitType: "lexical_chunk",
    meaningZh: "取得稳定进步",
    englishGloss: "to improve consistently over time",
    qualityStatus: "approved",
    reviewProvenance: "human_reviewer",
    reviewerVersion: "integration-fixture-v1",
    reviewedAt: new Date().toISOString(),
  });
  await db.insert(schema.chunkExamples).values({
    id: "example_api_sentence_first",
    chunkId: "c_api_sentence_first",
    textEn: "I make steady progress every day.",
    textZh: "我每天都取得稳定进步。",
    generated: 1,
    contextType: "generated_ielts",
  });
  await db.insert(schema.chunkPronunciations).values({
    id: "pronunciation_api_sentence_first",
    chunkId: "c_api_sentence_first",
    ipa: "meɪk ˈstedi ˈprəʊɡres",
    accent: "en-US",
    source: "integration-fixture",
    isPrimary: 1,
  });
  await db.insert(schema.chunkQuestionLinks).values({
    chunkId: "c_api_sentence_first",
    questionId: "question_api_test",
    relation: "coverage",
    answerDimensionId: "routine",
  });

  [createRoute, eventRoute, getRoute, settingsRoute, aiHealthRoute] = await Promise.all([
    import("@/app/api/learning/sessions/route"),
    import("@/app/api/learning/sessions/[id]/events/route"),
    import("@/app/api/learning/sessions/[id]/route"),
    import("@/app/api/settings/route"),
    import("@/app/api/ai/health/route"),
  ]);
});

describe("学习会话 HTTP 接口契约", () => {
  it("AI 健康接口只返回安全状态，并锁定 DeepSeek V4 Flash", async () => {
    const response = await aiHealthRoute.GET();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.model).toBe("deepseek-flash");
    expect(body).not.toHaveProperty("apiKey");
    expect(JSON.stringify(body)).not.toContain("sk-");
  });

  it("设置接口使用安全默认值、校验边界并可持久化", async () => {
    const initialResponse = await settingsRoute.GET();
    expect(initialResponse.status).toBe(200);
    const initial = await initialResponse.json();
    expect(initial.settings.autoCollectDifficulties).toBe(false);

    const invalidResponse = await settingsRoute.PATCH(new Request("http://local/api/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dailyNewTarget: 0 }),
    }));
    expect(invalidResponse.status).toBe(400);

    const savedResponse = await settingsRoute.PATCH(new Request("http://local/api/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ autoPlay: false, personalNewRatio: 0.55 }),
    }));
    expect(savedResponse.status).toBe(200);
    const saved = await savedResponse.json();
    expect(saved.settings.autoPlay).toBe(false);
    expect(saved.settings.personalNewRatio).toBe(0.55);

    await settingsRoute.PATCH(new Request("http://local/api/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ autoPlay: true }),
    }));
  });

  it("创建、推进、恢复同一会话，并拒绝坏事件", async () => {
    const createdResponse = await createRoute.POST(new Request("http://local/api/learning/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "learn" }),
    }));
    expect(createdResponse.status).toBe(200);
    const created = await createdResponse.json();
    expect(created.step.type).toBe("context_audio_input");
    expect(JSON.stringify(created.step)).not.toContain("取得稳定进步");
    expect(JSON.stringify(created.step)).not.toContain("What helps you keep learning");

    const invalidResponse = await eventRoute.POST(new Request(`http://local/api/learning/sessions/${created.id}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "rate_comprehension", rating: "maybe" }),
    }), { params: Promise.resolve({ id: created.id }) });
    expect(invalidResponse.status).toBe(400);

    const eventResponse = await eventRoute.POST(new Request(`http://local/api/learning/sessions/${created.id}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "mark_audio_heard",
        playback: "played",
        clientEventId: randomUUID(),
      }),
    }), { params: Promise.resolve({ id: created.id }) });
    expect(eventResponse.status).toBe(200);
    const comprehension = await eventResponse.json();
    expect(comprehension.step.type).toBe("comprehension_rating");
    expect(JSON.stringify(comprehension.step)).not.toContain("make steady progress");

    const ratingResponse = await eventRoute.POST(new Request(`http://local/api/learning/sessions/${created.id}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "rate_comprehension",
        rating: "not_understood",
        clientEventId: randomUUID(),
      }),
    }), { params: Promise.resolve({ id: created.id }) });
    expect(ratingResponse.status).toBe(200);
    const transcript = await ratingResponse.json();
    expect(transcript.step.type).toBe("transcript_replay");
    expect(transcript.step.context.lines).toHaveLength(2);
    expect(transcript.step).not.toHaveProperty("chunk");

    const restoredResponse = await getRoute.GET(new Request(`http://local/api/learning/sessions/${created.id}`), {
      params: Promise.resolve({ id: created.id }),
    });
    expect(restoredResponse.status).toBe(200);
    const restored = await restoredResponse.json();
    expect(restored.id).toBe(created.id);
    expect(restored.step.type).toBe("transcript_replay");

    const abandonedResponse = await getRoute.DELETE(new Request(`http://local/api/learning/sessions/${created.id}`, {
      method: "DELETE",
    }), { params: Promise.resolve({ id: created.id }) });
    expect(abandonedResponse.status).toBe(200);
    const staleResponse = await getRoute.GET(new Request(`http://local/api/learning/sessions/${created.id}`), {
      params: Promise.resolve({ id: created.id }),
    });
    expect(staleResponse.status).toBe(409);
  });
});
