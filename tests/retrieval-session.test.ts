import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { assertInsideTestResults, prepareTestDatabase } from "./helpers/temp-db";

const database = prepareTestDatabase("retrieval-session");
assertInsideTestResults(database.file);
process.env.ROASTDUCK_DB = database.url;
process.env.ROASTDUCK_SKIP_DB_BACKUP = "1";
process.env.AI_PROVIDER = "mock";

let db: Awaited<ReturnType<typeof import("@db/client").getDbReady>>;
let schema: typeof import("@db/schema");
let service: typeof import("@/lib/learning/session-service");

const questionId = "question_retrieval_v3";
const chunkId = "chunk_retrieval_v3";
const gapId = "gap_retrieval_v3";

function id() { return randomUUID(); }

async function insertV3Session(options: { mode?: "learn" | "review"; step?: string } = {}) {
  const sessionId = id();
  await db.insert(schema.learningSessions).values({
    id: sessionId,
    sessionDate: "2026-09-04",
    mode: options.mode ?? "learn",
    status: "active",
    queueJson: JSON.stringify([chunkId]),
    currentIndex: 0,
    step: options.step ?? (options.mode === "review" ? "review_prompt" : "retrieval_prompt"),
    stepVersion: 1,
    experienceVersion: "gap_retrieval_v3",
    scopeType: "question",
    scopeId: questionId,
    stateJson: "{}",
  });
  return sessionId;
}

beforeAll(async () => {
  schema = await import("@db/schema");
  db = await (await import("@db/client")).getDbReady();
  service = await import("@/lib/learning/session-service");

  await db.insert(schema.books).values({ id: "book_personal_ielts_answers", titleZh: "我的雅思答案", titleEn: "My IELTS Answers", sourceType: "personal", status: "beta", defaultAccent: "en-US" }).onConflictDoNothing();
  await db.insert(schema.topics).values({ id: "topic_retrieval_v3", bookId: "book_personal_ielts_answers", nameZh: "学习", nameEn: "Learning", ieltsPart: 1, status: "audited" });
  await db.insert(schema.questions).values({ id: questionId, bookId: "book_personal_ielts_answers", topicId: "topic_retrieval_v3", part: 1, text: "Are you making progress in English?", textZh: "你的英语有进步吗？", normText: "are you making progress in english", status: "audited" });
  await db.insert(schema.personalAnswers).values({ id: "answer_retrieval_v3", questionId, inputLanguage: "en", rawText: "I achieve progress.", status: "ready", currentVersionId: "version_retrieval_v3" });
  await db.insert(schema.answerVersions).values({ id: "version_retrieval_v3", answerId: "answer_retrieval_v3", versionNo: 1, kind: "normalized_transcript", textEn: "I achieve progress." });
  await db.insert(schema.personalAnswerSentences).values({ id: "sentence_retrieval_v3", answerId: "answer_retrieval_v3", answerVersionId: "version_retrieval_v3", questionId, sentenceIndex: 0, textEn: "I achieve progress.", textZh: "我取得了进步。" });
  await db.insert(schema.answerGaps).values({
    id: gapId,
    answerId: "answer_retrieval_v3",
    answerVersionId: "version_retrieval_v3",
    clusterId: null,
    gapType: "lexical_gap",
    evidenceText: "I achieve progress.",
    intentZh: "说明自己的英语正在稳步进步",
    recommendedExpression: "make steady progress",
    explanationZh: "英语通常使用 make progress；steady 强调持续而稳定。",
    confidence: 0.98,
    impactLevel: "high",
    reviewerDecision: "approved",
    reviewerReason: "证据明确，推荐表达自然且可复用。",
    reviewerRunId: "independent_gap_reviewer_v3",
    learningFit: true,
  });
  await db.insert(schema.chunks).values({
    id: chunkId,
    bookId: "book_personal_ielts_answers",
    canonicalChunk: "make steady progress",
    displayChunk: "make steady progress",
    unitType: "lexical_chunk",
    meaningZh: "取得稳定进步",
    englishGloss: "to improve consistently over time",
    pattern: "make steady progress + in/towards ...",
    qualityStatus: "approved",
    reviewProvenance: "independent_reviewer",
    reviewerVersion: "fixture-v3",
  });
  await db.insert(schema.chunkExamples).values({ id: "example_retrieval_v3", chunkId, textEn: "I am making steady progress in English.", textZh: "我的英语正在稳步进步。", generated: 1, contextType: "personal_answer" });
  await db.insert(schema.chunkPronunciations).values({ id: "pron_retrieval_v3", chunkId, ipa: "meɪk ˈstedi ˈprɑːɡres", accent: "en-US", source: "reviewed_fixture", isPrimary: 1 });
  await db.insert(schema.personalChunkLinks).values({ answerId: "answer_retrieval_v3", sentenceId: "sentence_retrieval_v3", chunkId, origin: "personal", generatorRunId: "generator_v3", reviewerRunId: "reviewer_v3" });
  await db.insert(schema.questionLearningUnits).values({ id: "unit_retrieval_v3", questionId, gapId, chunkId, requirement: "required", priority: 100, source: "historical_answer_gap" });
  await db.insert(schema.learningScenarios).values([
    { id: "scenario_repair_v3", chunkId, questionId, gapId, scenarioKind: "question_repair", settingZh: "雅思口语 Part 1 回答现场", relationshipZh: "考官与考生", purposeZh: "说明英语学习正在持续进步", register: "neutral", accent: "en-US", reviewDecision: "approved", reviewReason: "保留原题意图。", reviewerRunId: "scenario_reviewer_repair_v3" },
    { id: "scenario_common_v3", chunkId, questionId, gapId, scenarioKind: "common_usage", settingZh: "朋友在咖啡店聊最近的健身计划", relationshipZh: "关系熟悉的朋友", purposeZh: "说明一个长期目标正在稳定推进", register: "casual", accent: "en-US", reviewDecision: "approved", reviewReason: "日常迁移场景自然。", reviewerRunId: "scenario_reviewer_common_v3" },
  ]);
  await db.insert(schema.learningScenarioLines).values([
    { id: "repair_line_q_v3", scenarioId: "scenario_repair_v3", lineOrder: 0, speaker: "Examiner", textEn: "Are you making progress in English?", textZh: "你的英语有进步吗？", annotationStatus: "complete" },
    { id: "repair_line_a_v3", scenarioId: "scenario_repair_v3", lineOrder: 1, speaker: "Candidate", textEn: "I am making steady progress in English.", textZh: "我的英语正在稳步进步。", isTarget: true, annotationStatus: "complete" },
    { id: "common_line_q_v3", scenarioId: "scenario_common_v3", lineOrder: 0, speaker: "Maya", textEn: "How is your workout plan going?", textZh: "你的健身计划进展得怎么样？", annotationStatus: "complete" },
    { id: "common_line_a_v3", scenarioId: "scenario_common_v3", lineOrder: 1, speaker: "Leo", textEn: "I am making steady progress.", textZh: "我正在稳步推进。", isTarget: true, annotationStatus: "complete" },
  ]);
  await db.insert(schema.learningExperimentAssignments).values({ experimentId: "gap_retrieval_v3", chunkId, gapId, questionId, status: "active" });
});

describe("Gap 提取 V3 学习会话", () => {
  it("实验分配的个人 Gap 从中文意图开始，首屏不泄露答案也不请求麦克风", async () => {
    const view = await service.createOrResumeSession({ mode: "learn", scope: "question", questionId, restart: true });
    expect(view.experienceVersion).toBe("gap_retrieval_v3");
    expect(view.step.type).toBe("retrieval_prompt");
    expect(JSON.stringify(view.step)).toContain("Win + H");
    expect(JSON.stringify(view.step)).not.toContain("make steady progress");
    expect(JSON.stringify(view.step)).not.toContain("I achieve progress");
    expect(JSON.stringify(view.step)).not.toContain("microphone");
  });

  it("精确命中完全本地判定，迁移成功后才结算一次 FSRS", async () => {
    const sessionId = await insertV3Session();
    const beforeRuns = (await db.select().from(schema.aiRuns)).length;
    let view = await service.applySessionEvent(sessionId, { type: "submit_retrieval", clientEventId: id(), input: "  MAKE  steady progress！" });
    expect(view.step.type).toBe("comparison");
    if (view.step.type !== "comparison") throw new Error("预期对照步骤");
    expect(view.step.verdict).toBe("natural_equivalent");
    expect((await db.select().from(schema.aiRuns)).length).toBe(beforeRuns);

    view = await service.applySessionEvent(sessionId, { type: "continue_comparison", clientEventId: id() });
    expect(view.step.type).toBe("adaptive_instruction");
    if (view.step.type !== "adaptive_instruction") throw new Error("预期精简教学");
    expect(view.step.detailMode).toBe("compact");
    expect(view.step.next).toBe("transfer_recall");
    view = await service.applySessionEvent(sessionId, { type: "continue_instruction", clientEventId: id() });
    expect(view.step.type).toBe("transfer_recall");
    expect((await db.select().from(schema.reviewLog)).filter((row) => row.chunkId === chunkId)).toHaveLength(0);

    const transferEvent = { type: "submit_transfer" as const, clientEventId: id(), input: "make steady progress" };
    view = await service.applySessionEvent(sessionId, transferEvent);
    expect(view.step.type).toBe("outcome");
    if (view.step.type !== "outcome") throw new Error("预期结果页");
    expect(view.step.result.rating).toBe("good");
    expect(view.step.result.retrievalSummary?.independent).toBe(true);
    expect((await db.select().from(schema.reviewLog)).filter((row) => row.chunkId === chunkId)).toHaveLength(1);

    const replayed = await service.applySessionEvent(sessionId, transferEvent);
    expect(replayed.step.type).toBe("outcome");
    expect((await db.select().from(schema.retrievalAttempts)).filter((row) => row.sessionId === sessionId)).toHaveLength(2);
  });

  it("点击不会不调用 AI，教学后错误必须重做并按较近复习结算", async () => {
    const sessionId = await insertV3Session();
    const beforeRuns = (await db.select().from(schema.aiRuns)).length;
    let view = await service.applySessionEvent(sessionId, { type: "mark_unknown", clientEventId: id() });
    expect(view.step.type).toBe("comparison");
    expect((await db.select().from(schema.aiRuns)).length).toBe(beforeRuns);
    view = await service.applySessionEvent(sessionId, { type: "continue_comparison", clientEventId: id() });
    if (view.step.type !== "adaptive_instruction") throw new Error("预期完整教学");
    expect(view.step.detailMode).toBe("expanded");
    expect(view.step.next).toBe("active_recall");
    view = await service.applySessionEvent(sessionId, { type: "continue_instruction", clientEventId: id() });

    view = await service.applySessionEvent(sessionId, { type: "submit_retrieval", clientEventId: id(), input: "I become better maybe" });
    expect(view.step.type).toBe("active_recall");
    if (view.step.type !== "active_recall") throw new Error("错误后必须留在原场景提取");
    expect(view.step.feedbackZh).toBeTruthy();
    view = await service.applySessionEvent(sessionId, { type: "request_assist", clientEventId: id(), assist: "hint" });
    if (view.step.type !== "active_recall") throw new Error("提示后仍应提取");
    expect(view.step.assistLevel).toBe(1);
    expect(view.step.assistText).toContain("用途提示");

    view = await service.applySessionEvent(sessionId, { type: "submit_retrieval", clientEventId: id(), input: "make steady progress" });
    expect(view.step.type).toBe("transfer_recall");
    view = await service.applySessionEvent(sessionId, { type: "submit_transfer", clientEventId: id(), input: "make steady progress" });
    if (view.step.type !== "outcome") throw new Error("预期结果页");
    expect(view.step.result.rating).toBe("again");
    expect(view.step.result.retrievalSummary?.independent).toBe(false);
  }, 20_000);

  it("自然同义表达当场通过，独立 Reviewer 通过后同场景迁移可本地命中", async () => {
    const sessionId = await insertV3Session();
    const beforeJudgeRuns = (await db.select().from(schema.aiRuns)).filter((row) => row.role === "retrieval_judge").length;
    let view = await service.applySessionEvent(sessionId, { type: "submit_retrieval", clientEventId: id(), input: "I make consistent progress." });
    if (view.step.type !== "comparison") throw new Error("预期对照步骤");
    expect(view.step.verdict).toBe("natural_equivalent");
    const variants = await db.select().from(schema.expressionVariants);
    expect(variants).toEqual([expect.objectContaining({ expression: "I make consistent progress.", reviewDecision: "approved", active: true, reviewerRunId: expect.any(String) })]);
    view = await service.applySessionEvent(sessionId, { type: "continue_comparison", clientEventId: id() });
    view = await service.applySessionEvent(sessionId, { type: "continue_instruction", clientEventId: id() });
    view = await service.applySessionEvent(sessionId, { type: "submit_transfer", clientEventId: id(), input: "I make consistent progress." });
    expect(view.step.type).toBe("outcome");
    const judgeRuns = (await db.select().from(schema.aiRuns)).filter((row) => row.role === "retrieval_judge").length;
    expect(judgeRuns - beforeJudgeRuns).toBe(1);
    expect((await db.select().from(schema.aiRuns)).some((row) => row.role === "variant_reviewer")).toBe(true);
    expect((await db.select().from(schema.retrievalAttempts)).find((row) => row.sessionId === sessionId && row.phase === "transfer")?.judgementRoute).toBe("approved_variant");
  }, 20_000);

  it("到期复习必须先测；无辅助正确时走快速结算", async () => {
    const sessionId = await insertV3Session({ mode: "review" });
    const initial = await service.getSessionView(sessionId);
    expect(initial.step.type).toBe("review_prompt");
    const view = await service.applySessionEvent(sessionId, { type: "submit_retrieval", clientEventId: id(), input: "make steady progress" });
    if (view.step.type !== "outcome") throw new Error("复习精确命中应快速结束");
    expect(view.step.result.rating).toBe("easy");
  });

  it("AI 失败不判错、不结算并允许直接查看教学", async () => {
    const sessionId = await insertV3Session();
    let view = await service.applySessionEvent(sessionId, { type: "submit_retrieval", clientEventId: id(), input: "[mock:retrieval-fail]" });
    expect(view.step.type).toBe("retrieval_judgement");
    if (view.step.type !== "retrieval_judgement") throw new Error("预期失败判定状态");
    expect(view.step.status).toBe("failed");
    expect(view.step.message).toContain("不会被判错");
    expect((await db.select().from(schema.reviewLog)).filter((row) => row.chunkId === chunkId && JSON.parse(row.detailJson).sessionId === sessionId)).toHaveLength(0);
    view = await service.applySessionEvent(sessionId, { type: "continue_instruction", clientEventId: id() });
    expect(view.step.type).toBe("adaptive_instruction");
  }, 20_000);
});
