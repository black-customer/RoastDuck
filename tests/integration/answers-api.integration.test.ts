import { beforeAll, describe, expect, it } from "vitest";
import { assertInsideTestResults, prepareTestDatabase } from "../helpers/temp-db";

const testDatabase = prepareTestDatabase("answers-api.integration");
assertInsideTestResults(testDatabase.file);
process.env.ROASTDUCK_DB = testDatabase.url;
process.env.ROASTDUCK_SKIP_DB_BACKUP = "1";
process.env.AI_PROVIDER = "mock";

let answersRoute: typeof import("@/app/api/answers/route");
let answerRoute: typeof import("@/app/api/answers/[id]/route");
let processRoute: typeof import("@/app/api/answers/[id]/process/route");
let jobRoute: typeof import("@/app/api/ai/jobs/[id]/route");
let detailRoute: typeof import("@/app/api/questions/[id]/route");

const requestId = "33333333-3333-4333-8333-333333333333";
const answerId = "answer_33333333333343338333333333333333";

beforeAll(async () => {
  const [{ getDbReady }, schema] = await Promise.all([import("@db/client"), import("@db/schema")]);
  const db = await getDbReady();
  await db.insert(schema.books).values({ id: "book_answers_api", titleZh: "回答接口测试", titleEn: "Answer API", sourceType: "question_bank", status: "beta" });
  await db.insert(schema.topics).values({ id: "topic_answers_api", bookId: "book_answers_api", nameZh: "学习", nameEn: "Study", ieltsPart: 1, status: "audited" });
  await db.insert(schema.questions).values({ id: "question_answers_api", bookId: "book_answers_api", topicId: "topic_answers_api", part: 1, text: "How do you usually study?", textZh: "你通常怎样学习？", normText: "how do you usually study", status: "audited" });
  [answersRoute, answerRoute, processRoute, jobRoute, detailRoute] = await Promise.all([
    import("@/app/api/answers/route"),
    import("@/app/api/answers/[id]/route"),
    import("@/app/api/answers/[id]/process/route"),
    import("@/app/api/ai/jobs/[id]/route"),
    import("@/app/api/questions/[id]/route"),
  ]);
});

function createRequest() {
  return new Request("http://local/api/answers", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientRequestId: requestId, questionId: "question_answers_api", inputLanguage: "mixed", rawText: "I usually 在晚上复习 because it is quiet." }),
  });
}

describe("个人回答 HTTP 接口", () => {
  it("先保存原文与 raw 版本，再幂等创建 AI Job", async () => {
    const first = await answersRoute.POST(createRequest());
    expect(first.status).toBe(201);
    const firstBody = await first.json();
    expect(firstBody.answer).toMatchObject({ id: answerId, rawText: "I usually 在晚上复习 because it is quiet.", status: "queued" });
    expect(firstBody.answer.versions).toHaveLength(1);
    expect(firstBody.answer.versions[0]).toMatchObject({ versionNo: 1, kind: "raw", textZh: "I usually 在晚上复习 because it is quiet." });
    expect(firstBody.answer.job.status).toBe("queued");

    const duplicate = await answersRoute.POST(createRequest());
    expect(duplicate.status).toBe(201);
    const duplicateBody = await duplicate.json();
    expect(duplicateBody.answer.id).toBe(answerId);
    expect(duplicateBody.answer.versions).toHaveLength(1);

    const jobResponse = await jobRoute.GET(new Request(`http://local/api/ai/jobs/${firstBody.answer.job.id}`), { params: Promise.resolve({ id: firstBody.answer.job.id }) });
    expect(jobResponse.status).toBe(200);
    expect((await jobResponse.json()).job).not.toHaveProperty("payloadJson");
  });

  it("用户编辑只追加版本，旧版本仍可回看，冲突返回 409", async () => {
    const response = await answerRoute.PATCH(new Request(`http://local/api/answers/${answerId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ textEn: "I usually review my notes at night because it is quiet.", baseVersionNo: 1 }),
    }), { params: Promise.resolve({ id: answerId }) });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.answer.status).toBe("ready");
    expect(body.answer.versions.map((item: { versionNo: number }) => item.versionNo)).toEqual([2, 1]);
    expect(body.answer.rawText).toBe("I usually 在晚上复习 because it is quiet.");

    const conflict = await answerRoute.PATCH(new Request(`http://local/api/answers/${answerId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ textEn: "A stale edit.", baseVersionNo: 1 }),
    }), { params: Promise.resolve({ id: answerId }) });
    expect(conflict.status).toBe(409);
  });

  it("用 Mock 执行修订、Generator 与独立 Reviewer，题目详情返回个人材料", async () => {
    const retry = await processRoute.POST(new Request(`http://local/api/answers/${answerId}/process`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientRequestId: "44444444-4444-4444-8444-444444444444" }),
    }), { params: Promise.resolve({ id: answerId }) });
    expect(retry.status).toBe(200);
    const processed = await retry.json();
    expect(processed.answer.status).toBe("ready");
    expect(processed.answer.versions[0]).toMatchObject({ kind: "ai_revised", textEn: "I stay focused by putting my phone in another room." });

    const detail = await detailRoute.GET(new Request("http://local/api/questions/question_answers_api"), { params: Promise.resolve({ id: "question_answers_api" }) });
    expect(detail.status).toBe(200);
    const questionDetail = (await detail.json()).question;
    expect(questionDetail.answerHistory).toEqual([expect.objectContaining({ id: answerId, inputLanguage: "mixed", status: "ready" })]);
    expect(questionDetail.personalChunks).toEqual([expect.objectContaining({ display: "stay focused", origin: "personal" })]);

    const [{ getDbReady }, schema, { eq }] = await Promise.all([import("@db/client"), import("@db/schema"), import("drizzle-orm")]);
    const db = await getDbReady();
    const runs = await db.select().from(schema.aiRuns);
    expect(runs.map((run) => run.role).sort()).toEqual(["corrector", "generator", "reviewer"]);
    expect(new Set(runs.map((run) => run.runId)).size).toBe(3);
    expect(runs.every((run) => run.model === "deepseek-v4-flash")).toBe(true);
    const reviews = await db.select().from(schema.personalContentReviews);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ verdict: "approved" });
    const personalChunks = await db.select().from(schema.chunks).where(eq(schema.chunks.bookId, "book_personal_ielts_answers"));
    expect(personalChunks).toHaveLength(1);
  });

  it("每日新学按 40% 优先选择个人词书，不足时由公共内容补齐", async () => {
    const [{ getDbReady }, schema, progress] = await Promise.all([
      import("@db/client"),
      import("@db/schema"),
      import("@/lib/learning/progress"),
    ]);
    const db = await getDbReady();
    await db.update(schema.userSettings).set({ dailyNewTarget: 5, personalNewRatio: 0.4 });
    await db.insert(schema.chunks).values([
      ...Array.from({ length: 4 }, (_, index) => ({
        id: `personal_ratio_${index}`,
        bookId: "book_personal_ielts_answers",
        canonicalChunk: `personal ratio chunk ${index}`,
        displayChunk: `personal ratio chunk ${index}`,
        unitType: "lexical_chunk",
        meaningZh: `个人表达 ${index}`,
        englishGloss: "personal test expression",
        qualityStatus: "approved",
        reviewProvenance: "human_reviewer",
      })),
      ...Array.from({ length: 5 }, (_, index) => ({
        id: `public_ratio_${index}`,
        bookId: "book_answers_api",
        canonicalChunk: `public ratio chunk ${index}`,
        displayChunk: `public ratio chunk ${index}`,
        unitType: "lexical_chunk",
        meaningZh: `公共表达 ${index}`,
        englishGloss: "public test expression",
        qualityStatus: "approved",
        reviewProvenance: "human_reviewer",
      })),
    ]);
    const [sentence] = await db.select().from(schema.personalAnswerSentences);
    expect(sentence).toBeDefined();
    await db.insert(schema.personalChunkLinks).values(Array.from({ length: 4 }, (_, index) => ({
      answerId, sentenceId: sentence.id, chunkId: `personal_ratio_${index}`, origin: 'personal', status: 'active',
      generatorRunId: 'synthetic-ratio-generator', reviewerRunId: 'synthetic-ratio-reviewer',
    })));
    const queue = await progress.getTodayQueue();
    expect(queue.fresh).toHaveLength(5);
    const selected = await db.select({ id: schema.chunks.id, bookId: schema.chunks.bookId }).from(schema.chunks);
    const bookById = new Map(selected.map((item) => [item.id, item.bookId]));
    expect(queue.fresh.filter((id) => bookById.get(id) === "book_personal_ielts_answers")).toHaveLength(2);
    expect(queue.fresh.filter((id) => bookById.get(id) !== "book_personal_ielts_answers")).toHaveLength(3);
  });
});
