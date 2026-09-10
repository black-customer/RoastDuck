import { afterEach,beforeAll, describe, expect, it,vi } from "vitest";
import { assertInsideTestResults, prepareTestDatabase } from "../helpers/temp-db";
import {MockAiProvider} from '@/lib/ai/mock-provider';
import {AiProviderError} from '@/lib/ai/errors';

const testDatabase = prepareTestDatabase("speaking-api.integration");
assertInsideTestResults(testDatabase.file);
process.env.ROASTDUCK_DB = testDatabase.url;
process.env.ROASTDUCK_SKIP_DB_BACKUP = "1";
process.env.AI_PROVIDER = "mock";

let sessionsRoute: typeof import("@/app/api/speaking/sessions/route");
let sessionRoute: typeof import("@/app/api/speaking/sessions/[id]/route");
let eventsRoute: typeof import("@/app/api/speaking/sessions/[id]/events/route");
let messagesRoute: typeof import("@/app/api/speaking/sessions/[id]/messages/route");
let lookupRoute: typeof import("@/app/api/lookups/[annotationId]/route");

const questionId = "question_speaking_api";
const requestId = "77777777-7777-4777-8777-777777777777";
afterEach(()=>vi.restoreAllMocks());
/** One transport failure, not the old fixture's three failures consumed by automatic retry. */
function failNextSchema(schemaName:string){
  const original=MockAiProvider.prototype.generate;let failed=false;
  return vi.spyOn(MockAiProvider.prototype,'generate').mockImplementation(async function(this:MockAiProvider,request){
    if(request.schemaName===schemaName&&!failed){failed=true;throw new AiProviderError('模拟单次网络中断','network_error',true);}
    return original.call(this,request);
  });
}

beforeAll(async () => {
  const [{ getDbReady }, schema] = await Promise.all([import("@db/client"), import("@db/schema")]);
  const db = await getDbReady();
  await db.insert(schema.books).values({ id: "book_speaking_api", titleZh: "口语输出测试", titleEn: "Speaking API", sourceType: "question_bank", status: "beta" });
  await db.insert(schema.topics).values({ id: "topic_speaking_api", bookId: "book_speaking_api", nameZh: "专注", nameEn: "Focus", ieltsPart: 1, status: "audited" });
  await db.insert(schema.questions).values({ id: questionId, bookId: "book_speaking_api", topicId: "topic_speaking_api", part: 1, text: "How do you stay focused while studying?", textZh: "学习时你怎样保持专注？", normText: "how do you stay focused while studying", status: "audited" });
  [sessionsRoute, sessionRoute, eventsRoute, messagesRoute, lookupRoute] = await Promise.all([
    import("@/app/api/speaking/sessions/route"),
    import("@/app/api/speaking/sessions/[id]/route"),
    import("@/app/api/speaking/sessions/[id]/events/route"),
    import("@/app/api/speaking/sessions/[id]/messages/route"),
    import("@/app/api/lookups/[annotationId]/route"),
  ]);
});

function sessionRequest(clientRequestId = requestId, answerId: string | null = null) {
  return new Request("http://local/api/speaking/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientRequestId, questionId, answerId }),
  });
}

function eventRequest(sessionId: string, payload: Record<string, unknown>) {
  return eventsRoute.POST(new Request(`http://local/api/speaking/sessions/${sessionId}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  }), { params: Promise.resolve({ id: sessionId }) });
}

function messageRequest(sessionId: string, payload: Record<string, unknown>) {
  return messagesRoute.POST(new Request(`http://local/api/speaking/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  }), { params: Promise.resolve({ id: sessionId }) });
}

describe("口语输出与纠错 HTTP 接口", () => {
  it("完成分级提示、结构化纠错、错误重说与个人 Gap 入库", async () => {
    const createdResponse = await sessionsRoute.POST(sessionRequest());
    expect(createdResponse.status).toBe(201);
    const created = (await createdResponse.json()).session;
    expect(created).toMatchObject({ status: "ready", ideaSource: "ai_generated", hintLevel: 0 });
    expect(created.hints.interactiveKeywords.every((item: { annotations: unknown[] }) => item.annotations.length > 0)).toBe(true);
    expect(created.hints.interactiveFullAnswer.annotations).toHaveLength(10);

    const duplicate = await sessionsRoute.POST(sessionRequest());
    expect((await duplicate.json()).session.id).toBe(created.id);

    for (const level of [1, 2, 3]) {
      const revealedResponse = await eventRequest(created.id, { type: "reveal_hint", clientEventId: `88888888-8888-4888-8888-88888888888${level}`, level });
      expect(revealedResponse.status).toBe(200);
      expect((await revealedResponse.json()).session.hintLevel).toBe(level);
    }

    const feedbackResponse = await eventRequest(created.id, {
      type: "submit_response",
      clientEventId: "99999999-9999-4999-8999-999999999999",
      text: "I put my phone other room.",
    });
    expect(feedbackResponse.status).toBe(200);
    const feedbackSession = (await feedbackResponse.json()).session;
    expect(feedbackSession.status).toBe("retrying");
    expect(feedbackSession.feedback.items).toHaveLength(1);
    expect(feedbackSession.feedback.items[0]).toMatchObject({
      problemType: "grammar",
      reasonZh: expect.any(String),
      gapExpression: "putting my phone in another room",
      resolved: false,
    });
    expect(feedbackSession.feedback.items[0].interactiveOriginal.annotations.length).toBeGreaterThan(0);
    expect(feedbackSession.feedback.items[0].interactiveRecommended.annotations.length).toBeGreaterThan(0);
    expect(feedbackSession.feedback.items[0].interactiveGap.annotations.length).toBeGreaterThan(0);

    const annotationId = feedbackSession.feedback.items[0].interactiveGap.annotations[0].id;
    const lookupResponse = await lookupRoute.GET(new Request(`http://local/api/lookups/${annotationId}`), { params: Promise.resolve({ annotationId }) });
    expect(lookupResponse.status).toBe(200);
    expect(await lookupResponse.json()).toMatchObject({ noteId: null });

    const wrongResponse = await eventRequest(created.id, {
      type: "submit_retry",
      clientEventId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      itemId: feedbackSession.activeRetryItemId,
      text: "I put my phone there.",
    });
    const wrongSession = (await wrongResponse.json()).session;
    expect(wrongSession.status).toBe("retrying");
    expect(wrongSession.feedback.items[0]).toMatchObject({ resolved: false, retryCount: 1 });

    const correctEvent = {
      type: "submit_retry",
      clientEventId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      itemId: feedbackSession.activeRetryItemId,
      text: "I stay focused by putting my phone in another room.",
    };
    const correctResponse = await eventRequest(created.id, correctEvent);
    const completed = (await correctResponse.json()).session;
    expect(completed.status).toBe("completed");
    expect(completed.activeRetryItemId).toBeNull();
    expect(completed.feedback.items[0]).toMatchObject({ resolved: true, retryCount: 2 });

    const duplicateCorrect = await eventRequest(created.id, correctEvent);
    expect((await duplicateCorrect.json()).session.attempts).toHaveLength(3);

    const [{ getDbReady }, schema, { and, eq }] = await Promise.all([import("@db/client"), import("@db/schema"), import("drizzle-orm")]);
    const db = await getDbReady();
    const runs = await db.select().from(schema.aiRuns);
    expect(runs.map((run) => run.role)).toEqual(expect.arrayContaining(["hint", "corrector", "generator", "reviewer"]));
    expect(runs.every((run) => run.model === "deepseek-flash")).toBe(true);
    expect(new Set(runs.map((run) => run.runId)).size).toBe(runs.length);
    const reviews = await db.select().from(schema.personalContentReviews);
    expect(reviews).toEqual([expect.objectContaining({ verdict: "approved", reviewerRunId: expect.any(String) })]);
    const personalLinks = await db.select().from(schema.personalChunkLinks).where(and(eq(schema.personalChunkLinks.answerId, completed.answerId), eq(schema.personalChunkLinks.status, "active")));
    expect(personalLinks).toHaveLength(1);
    const notes = await db.select().from(schema.difficultNotes);
    expect(notes).toHaveLength(0);
    // 该用例串行跑完 hint → 纠错 → Gap 生成 → Gap 审核四次 AI Job 与多轮事务，
    // 远超 Vitest 默认 5s 超时，单独放宽而不是简化断言。
  }, 60_000);

  it("刷新可读取同一会话，已有答案优先成为中文思路", async () => {
    const existingResponse = await sessionRoute.GET(new Request("http://local/api/speaking/session"), { params: Promise.resolve({ id: `speaking_${requestId.replaceAll("-", "")}` }) });
    const existing = (await existingResponse.json()).session;
    expect(existing.status).toBe("completed");

    const historyResponse = await sessionsRoute.POST(sessionRequest("cccccccc-cccc-4ccc-8ccc-cccccccccccc", existing.answerId));
    const history = (await historyResponse.json()).session;
    expect(history).toMatchObject({ status: "ready", ideaSource: "user_history", answerId: existing.answerId });
    expect(history.chineseIdea).toContain("手机");
  });

  it("持久化中英混合消息、返回多条老师气泡并保证幂等", async () => {
    const clientRequestId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const createdResponse = await sessionsRoute.POST(sessionRequest(clientRequestId));
    const created = (await createdResponse.json()).session;
    expect(created).toMatchObject({ status: "ready", experienceVersion: "teacher_chat_v2", turnCount: 0, companionThreadId: expect.any(String) });
    expect(created.messages).toHaveLength(1);
    expect(created.messages[0]).toMatchObject({ role: "teacher", status: "sent" });

    const payload = {
      clientMessageId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      text: "I put my phone in another room，这样我可以 stay focused。",
      inputLanguage: "mixed",
      messageKind: "text",
    };
    const repliedResponse = await messageRequest(created.id, payload);
    expect(repliedResponse.status).toBe(200);
    const replied = (await repliedResponse.json()).session;
    expect(replied).toMatchObject({ status: "conversing", turnCount: 1, defaultRoundLimit: 4 });
    expect(replied.messages).toHaveLength(5);
    expect(replied.messages.filter((message: { role: string }) => message.role === "teacher")).toHaveLength(4);
    expect(replied.messages.find((message: { clientMessageId: string }) => message.clientMessageId === payload.clientMessageId)).toMatchObject({ status: "sent", inputLanguage: "mixed" });
    expect(replied.messages.filter((message: { interactiveText: { annotations: unknown[] } }) => message.interactiveText.annotations.length > 0).length).toBeGreaterThanOrEqual(2);

    const [{ getDbReady }, schema, { eq }] = await Promise.all([import("@db/client"), import("@db/schema"), import("drizzle-orm")]);
    const db = await getDbReady();
    expect(await db.select().from(schema.speakingMessages).where(eq(schema.speakingMessages.sessionId, created.id))).toHaveLength(0);
    expect((await db.select().from(schema.companionMessages).where(eq(schema.companionMessages.threadId, created.companionThreadId))).some((message) => message.sourceType === "speaking_session" && message.sourceId === created.id)).toBe(true);
    const runsBeforeDuplicate = await db.select().from(schema.aiRuns).where(eq(schema.aiRuns.role, "companion_response"));
    const duplicateResponse = await messageRequest(created.id, payload);
    expect((await duplicateResponse.json()).session.messages).toHaveLength(5);
    const runsAfterDuplicate = await db.select().from(schema.aiRuns).where(eq(schema.aiRuns.role, "companion_response"));
    expect(runsAfterDuplicate).toHaveLength(runsBeforeDuplicate.length);

    const completeEvent = { type: "complete_conversation", clientEventId: "34343434-3434-4434-8434-343434343434" };
    const completeResponse = await eventRequest(created.id, completeEvent);
    expect(completeResponse.status).toBe(200);
    const completed = (await completeResponse.json()).session;
    expect(completed).toMatchObject({ status: "completed", responseText: payload.text, answerId: expect.any(String) });
    expect(completed.gapComparisons).toEqual([
      expect.objectContaining({ comparison: "new", gapType: "lexical_gap", recommendedExpression: expect.stringContaining("stay focused") }),
    ]);
    const [savedAnswer] = await db.select().from(schema.personalAnswers).where(eq(schema.personalAnswers.id, completed.answerId));
    expect(savedAnswer).toMatchObject({ rawText: payload.text, inputLanguage: "mixed", status: "ready", sourceKind: "runtime" });
    const savedGaps = await db.select().from(schema.answerGaps).where(eq(schema.answerGaps.answerId, completed.answerId));
    expect(savedGaps).toEqual([
      expect.objectContaining({ reviewerDecision: "approved", learningFit: true, reviewerRunId: expect.any(String) }),
    ]);
    const comparisonLinks = await db.select().from(schema.speakingGapLinks).where(eq(schema.speakingGapLinks.gapId, savedGaps[0].id));
    expect(comparisonLinks).toEqual([
      expect.objectContaining({ comparison: "new", reason: expect.any(String), comparatorRunId: expect.any(String) }),
    ]);
    const learningUnits = await db.select().from(schema.questionLearningUnits).where(eq(schema.questionLearningUnits.gapId, savedGaps[0].id));
    expect(learningUnits).toEqual([
      expect.objectContaining({ questionId, status: "active", source: "runtime_answer_gap", chunkId: expect.any(String) }),
    ]);
    const scenarios = await db.select().from(schema.learningScenarios).where(eq(schema.learningScenarios.gapId, savedGaps[0].id));
    expect(scenarios.map((scenario) => scenario.scenarioKind).sort()).toEqual(["common_usage", "question_repair"]);
    expect(scenarios.every((scenario) => scenario.reviewDecision === "approved" && scenario.accent === "en-US" && Boolean(scenario.reviewerRunId))).toBe(true);
    const scenarioLines = (await db.select().from(schema.learningScenarioLines)).filter((line) => scenarios.some((scenario) => scenario.id === line.scenarioId));
    expect(scenarioLines).toHaveLength(4);
    expect(scenarioLines.every((line) => line.annotationStatus === "complete")).toBe(true);
    expect((await db.select().from(schema.learningInboxItems).where(eq(schema.learningInboxItems.sourceId, savedGaps[0].id)))).toEqual([
      expect.objectContaining({ status: "open", chunkId: learningUnits[0].chunkId }),
    ]);
    const gapRuns = await db.select().from(schema.aiRuns);
    const generatorRun = gapRuns.find((run) => run.role === "gap_generator");
    const reviewerRun = gapRuns.find((run) => run.role === "gap_reviewer");
    const comparatorRun = gapRuns.find((run) => run.role === "reattempt_comparator");
    const materialRun = gapRuns.find((run) => run.role === "learning_material_compiler");
    const scenarioReviewerRun = gapRuns.find((run) => run.role === "scenario_reviewer");
    expect(generatorRun?.runId).toBeTruthy();
    expect(reviewerRun?.runId).toBeTruthy();
    expect(comparatorRun?.runId).toBeTruthy();
    expect(materialRun?.runId).toBeTruthy();
    expect(scenarioReviewerRun?.runId).toBeTruthy();
    expect(new Set([generatorRun?.runId, reviewerRun?.runId, comparatorRun?.runId, materialRun?.runId, scenarioReviewerRun?.runId]).size).toBe(5);
    const learningService = await import("@/lib/learning/session-service");
    const questionLearning = await learningService.createOrResumeSession({ mode: "learn", scope: "question", questionId, restart: true });
    expect(questionLearning.step).toMatchObject({ type: "context_audio_input", total: 1 });
    expect(questionLearning.step).not.toHaveProperty("context");
    const duplicateComplete = await eventRequest(created.id, completeEvent);
    expect((await duplicateComplete.json()).session.answerId).toBe(completed.answerId);

    const reattemptCreatedResponse = await sessionsRoute.POST(sessionRequest("abababab-abab-4bab-8bab-abababababab"));
    const reattemptCreated = (await reattemptCreatedResponse.json()).session;
    await messageRequest(reattemptCreated.id, {
      clientMessageId: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd",
      text: payload.text,
      inputLanguage: "mixed",
      messageKind: "text",
    });
    const reattemptCompleteResponse = await eventRequest(reattemptCreated.id, {
      type: "complete_conversation",
      clientEventId: "efefefef-efef-4fef-8fef-efefefefefef",
    });
    expect(reattemptCompleteResponse.status).toBe(200);
    const reattemptCompleted = (await reattemptCompleteResponse.json()).session;
    expect(reattemptCompleted.gapComparisons).toEqual([
      expect.objectContaining({ comparison: "repeated", relatedGapId: savedGaps[0].id, reason: expect.any(String) }),
    ]);
  }, 30_000);

  it("老师失败时不吞用户消息，同一消息 ID 可显式重试且不重复入库", async () => {
    const createdResponse = await sessionsRoute.POST(sessionRequest("ffffffff-ffff-4fff-8fff-ffffffffffff"));
    const created = (await createdResponse.json()).session;
    const payload = {
      clientMessageId: "12121212-1212-4212-8212-121212121212",
      text: "I stay focused.",
      inputLanguage: "en",
      messageKind: "text",
    };
    const calls=failNextSchema('companion_response_chloe_v1');
    const failedResponse = await messageRequest(created.id, payload);
    expect(failedResponse.status).toBe(502);
    expect(calls.mock.calls.filter(([request])=>request.schemaName==='companion_response_chloe_v1')).toHaveLength(1);
    const failed = (await failedResponse.json()).session;
    expect(failed).toMatchObject({ status: "ai_failed" });
    expect(failed.messages.filter((message: { clientMessageId: string }) => message.clientMessageId === payload.clientMessageId)).toEqual([
      expect.objectContaining({ clientMessageId: payload.clientMessageId, status: "failed", text: payload.text }),
    ]);

    const retryResponse = await messageRequest(created.id, { ...payload, retry: true });
    expect(retryResponse.status).toBe(200);
    expect(calls.mock.calls.filter(([request])=>request.schemaName==='companion_response_chloe_v1')).toHaveLength(2);
    const recovered = (await retryResponse.json()).session;
    expect(recovered).toMatchObject({ status: "conversing", turnCount: 1, lastError: null });
    expect(recovered.messages.filter((message: { clientMessageId: string }) => message.clientMessageId === payload.clientMessageId)).toHaveLength(1);
    expect(recovered.messages.filter((message: { metadata: { parentClientMessageId?: string } }) => message.metadata.parentClientMessageId === payload.clientMessageId)).toHaveLength(3);
  }, 30_000);

  it("独立 Gap 比较失败时复用完成事件，不重复创建个人 Answer", async () => {
    const createdResponse = await sessionsRoute.POST(sessionRequest("10101010-1010-4010-8010-101010101010"));
    const created = (await createdResponse.json()).session;
    await messageRequest(created.id, {
      clientMessageId: "20202020-2020-4020-8020-202020202020",
      text: "I stay focused.",
      inputLanguage: "en",
      messageKind: "text",
    });
    const completeEvent = { type: "complete_conversation", clientEventId: "30303030-3030-4030-8030-303030303030" };
    const calls=failNextSchema('speaking_reattempt_comparator_v1');
    const failedResponse = await eventRequest(created.id, completeEvent);
    expect(failedResponse.status).toBe(502);
    expect(calls.mock.calls.filter(([request])=>request.schemaName==='speaking_reattempt_comparator_v1')).toHaveLength(1);
    const failed = (await failedResponse.json()).session;
    expect(failed).toMatchObject({ status: "ai_failed" });

    const [{ getDbReady }, schema, { eq }] = await Promise.all([import("@db/client"), import("@db/schema"), import("drizzle-orm")]);
    const db = await getDbReady();
    const stableAnswerId = "answer_30303030303040308030303030303030";
    expect(await db.select().from(schema.personalAnswers).where(eq(schema.personalAnswers.id, stableAnswerId))).toHaveLength(1);

    const recoveredResponse = await eventRequest(created.id, completeEvent);
    expect(recoveredResponse.status).toBe(200);
    expect(calls.mock.calls.filter(([request])=>request.schemaName==='speaking_reattempt_comparator_v1')).toHaveLength(2);
    const recovered = (await recoveredResponse.json()).session;
    expect(recovered).toMatchObject({ status: "completed", answerId: stableAnswerId });
    expect(await db.select().from(schema.personalAnswers).where(eq(schema.personalAnswers.id, stableAnswerId))).toHaveLength(1);
    expect(recovered.gapComparisons).toHaveLength(1);
  }, 30_000);

  it("迁移前 teacher_chat_v1 会话仍按原消息表无损恢复", async () => {
    const [{ getDbReady }, schema, speaking, { eq }] = await Promise.all([
      import("@db/client"), import("@db/schema"), import("@/lib/speaking/service"), import("drizzle-orm"),
    ]);
    const db = await getDbReady();
    const legacyId = "speaking_legacy_v1_resume";
    await db.insert(schema.speakingSessions).values({ id: legacyId, questionId, status: "ready", experienceVersion: "teacher_chat_v1" });
    await db.insert(schema.speakingMessages).values({ id: "legacy_opening", sessionId: legacyId, sequenceNo: 1, role: "teacher", text: "旧会话开场", clientMessageId: "legacy-opening", status: "sent" });
    const recovered = await speaking.sendSpeakingMessage(legacyId, { clientMessageId: "45454545-4545-4545-8545-454545454545", text: "I stay focused.", inputLanguage: "en", messageKind: "text", retry: false });
    expect(recovered).toMatchObject({ experienceVersion: "teacher_chat_v1", status: "conversing", turnCount: 1 });
    expect(await db.select().from(schema.speakingMessages).where(eq(schema.speakingMessages.sessionId, legacyId))).toHaveLength(5);
  });
});
