import { beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { assertInsideTestResults, prepareTestDatabase } from "../helpers/temp-db";

const testDatabase = prepareTestDatabase("speaking-practice-api.integration");
assertInsideTestResults(testDatabase.file);
process.env.ROASTDUCK_DB = testDatabase.url;
process.env.ROASTDUCK_SKIP_DB_BACKUP = "1";
process.env.AI_PROVIDER = "mock";

let attemptsRoute: typeof import("@/app/api/speaking-practice/questions/[id]/attempts/route");
let attemptRoute: typeof import("@/app/api/speaking-practice/attempts/[id]/route");
let translationRoute: typeof import("@/app/api/speaking-practice/attempts/[id]/translation/route");
let convRoute: typeof import("@/app/api/free-talk/conversations/route");
let messagesRoute: typeof import("@/app/api/free-talk/conversations/[id]/messages/route");

const questionId = "q_api_test_speaking";
const background = vi.hoisted(() => [] as Array<() => Promise<void>>);
vi.mock("next/server", async (original) => ({ ...await original<typeof import("next/server")>(), after: (work: () => Promise<void>) => background.push(work) }));

beforeAll(async () => {
  const [{ getDbReady }, schema] = await Promise.all([import("@db/client"), import("@db/schema")]);
  const db = await getDbReady();
  await db.insert(schema.books).values({
    id: "book_speaking_api",
    titleZh: "口语题库",
    titleEn: "Speaking API Book",
    sourceType: "question_bank",
  }).onConflictDoNothing();

  await db.insert(schema.questions).values({
    id: questionId,
    bookId: "book_speaking_api",
    part: 1,
    text: "Do you like spending time alone or with friends?",
    textZh: "你喜欢独处还是和朋友在一起？",
    normText: "do you like spending time alone or with friends",
  }).onConflictDoNothing();

  [attemptsRoute, attemptRoute, translationRoute, convRoute, messagesRoute] = await Promise.all([
    import("@/app/api/speaking-practice/questions/[id]/attempts/route"),
    import("@/app/api/speaking-practice/attempts/[id]/route"),
    import("@/app/api/speaking-practice/attempts/[id]/translation/route"),
    import("@/app/api/free-talk/conversations/route"),
    import("@/app/api/free-talk/conversations/[id]/messages/route"),
  ]);
});

describe("IELTS Speaking Question Practice API Endpoints", () => {
  let createdAttemptId = "";

  it("POST /api/speaking-practice/questions/[id]/attempts creates an attempt with two input fields", async () => {
    const request = new Request(`http://local/api/speaking-practice/questions/${questionId}/attempts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "practice",
        answerText: "I usually stay home and I saw a 井盖 outside.",
        intendedMeaningZh: "我一般待在家里，在外面看到了井盖。",
      }),
    });

    const response = await attemptsRoute.POST(request, { params: Promise.resolve({ id: questionId }) });
    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body.attempt).toBeDefined();
    expect(body.attempt.status).toBe("processing");
    expect(body.attempt.answerText).toContain("井盖");
    createdAttemptId = body.attempt.id;
    for (const work of background.splice(0)) await work();
    const { attempt } = await (await attemptRoute.GET(new Request("http://local"), { params: Promise.resolve({ id: createdAttemptId }) })).json();
    expect(attempt.status).toBe("completed");
    expect(attempt.gapCount).toBe(1);
    expect(attempt.naturalVersion).toContain("manhole cover");
  });

  it("GET /api/speaking-practice/questions/[id]/attempts lists all independent attempts", async () => {
    const response = await attemptsRoute.GET(new Request("http://local"), { params: Promise.resolve({ id: questionId }) });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.attempts.length).toBeGreaterThanOrEqual(1);
    expect(body.attempts[0].id).toBe(createdAttemptId);
  });

  it("GET /api/speaking-practice/attempts/[id] retrieves attempt analysis, gaps, and cloze", async () => {
    const response = await attemptRoute.GET(new Request("http://local"), { params: Promise.resolve({ id: createdAttemptId }) });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.attempt.id).toBe(createdAttemptId);
    expect(body.attempt.analysis.clozeItems.length).toBeGreaterThanOrEqual(1);
  });

  it("POST /api/speaking-practice/attempts/[id]/translation evaluates translation semantically", async () => {
    const request = new Request("http://local", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        userEnglish: "I like to spend time by myself at home.",
      }),
    });

    const response = await translationRoute.POST(request, { params: Promise.resolve({ id: createdAttemptId }) });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.evaluation.passed).toBe(true);
  });
});

describe("AI Free Talk API Endpoints", () => {
  let conversationId = "";

  it("POST /api/free-talk/conversations creates conversation and GET lists it", async () => {
    const postReq = new Request("http://localhost/api/free-talk/conversations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({clientRequestId:'test-create-conversation', title: "Weekend Plans", mode: "relaxed" }),
    });

    const postRes = await convRoute.POST(postReq);
    expect(postRes.status).toBe(201);
    const postBody = await postRes.json();
    expect(postBody.conversation.title).toBe("Weekend Plans");
    conversationId = postBody.conversation.id;

    const getRes = await convRoute.GET();
    expect(getRes.status).toBe(200);
    const getBody = await getRes.json();
    expect(getBody.conversations.some((c: { id: string }) => c.id === conversationId)).toBe(true);
  });

  it("POST & GET /api/free-talk/conversations/[id]/messages sends message and gets history", async () => {
    const postMsgReq = new Request("http://localhost", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "I was walking around and saw a 井盖.",
        clientMessageId:'test-user-message-one',
      }),
    });

    const postMsgRes = await messagesRoute.POST(postMsgReq, { params: Promise.resolve({ id: conversationId }) });
    expect(postMsgRes.status).toBe(200);
    const postMsgBody = await postMsgRes.json();
    expect(postMsgBody.assistantMessage.role).toBe('assistant');
    expect(postMsgBody.assistantMessage.text.length).toBeGreaterThan(0);
    expect(postMsgBody.messages.some((m:{role:string;text:string})=>m.role==='user'&&m.text==='I was walking around and saw a 井盖.')).toBe(true);

    const getMsgsRes = await messagesRoute.GET(new Request("http://local"), { params: Promise.resolve({ id: conversationId }) });
    expect(getMsgsRes.status).toBe(200);
    const getMsgsBody = await getMsgsRes.json();
    expect(getMsgsBody.messages.some((m:{id:string;text:string})=>m.id===postMsgBody.assistantMessage.id&&m.text===postMsgBody.assistantMessage.text)).toBe(true);
    expect(getMsgsBody.messages.length).toBeGreaterThanOrEqual(3);
  });
});

it("排队任务在后台启动前中断，也能通过只读详情得到恢复入口而非永久处理中",async()=>{
  const db=await(await import("@db/client")).getDbReady();
  const service=await import("@/lib/speaking-practice/service");
  const [question]=await db.all<{id:string}>(sql`SELECT id FROM questions LIMIT 1`);
  const attempt=await service.prepareSpeakingAttempt({questionId:question.id,clientRequestId:"queued-stale-test",mode:"practice",answerText:"I live here.",intendedMeaningZh:"我住在这里。"});
  await db.run(sql`UPDATE practice_materials SET updated_at='2020-01-01T00:00:00Z',lease_until=NULL WHERE source_id=${attempt.id}`);
  expect(await service.getSpeakingAttempt(attempt.id)).toMatchObject({status:"failed",materialError:"上次处理已中断，原回答已保存。可以恢复处理。"});
  expect((await db.all<{status:string}>(sql`SELECT status FROM speaking_question_attempts WHERE id=${attempt.id}`))[0].status).toBe("processing");
});
