import { beforeAll, describe, expect, it } from "vitest";
import { assertInsideTestResults, prepareTestDatabase } from "../helpers/temp-db";

const testDatabase = prepareTestDatabase("questions-api.integration");
assertInsideTestResults(testDatabase.file);
process.env.ROASTDUCK_DB = testDatabase.url;
process.env.ROASTDUCK_SKIP_DB_BACKUP = "1";

let setsRoute: typeof import("@/app/api/question-sets/route");
let questionsRoute: typeof import("@/app/api/questions/route");
let randomRoute: typeof import("@/app/api/questions/random/route");
let detailRoute: typeof import("@/app/api/questions/[id]/route");
let learningPackRoute: typeof import("@/app/api/questions/[id]/learning-pack/route");
let attemptsRoute: typeof import("@/app/api/question-attempts/route");
let favoriteRoute: typeof import("@/app/api/questions/[id]/favorite/route");
let sourceRoute: typeof import("@/app/api/question-sources/[slug]/route");

beforeAll(async () => {
  const [{ getDbReady }, schema] = await Promise.all([import("@db/client"), import("@db/schema")]);
  const db = await getDbReady();
  await db.insert(schema.books).values({
    id: "book_questions_api",
    titleZh: "题库接口测试",
    titleEn: "Question API Fixture",
    sourceType: "question_bank",
    status: "beta",
  });
  await db.insert(schema.topics).values([
    { id: "topic_work", bookId: "book_questions_api", nameZh: "工作", nameEn: "Work", ieltsPart: 1, status: "audited" },
    { id: "topic_city", bookId: "book_questions_api", nameZh: "城市", nameEn: "Cities", ieltsPart: 3, status: "audited" },
  ]);
  await db.insert(schema.questions).values([
    { id: "question_work", bookId: "book_questions_api", topicId: "topic_work", part: 1, text: "Do you enjoy your work?", textZh: "你喜欢你的工作吗？", normText: "do you enjoy your work", status: "audited" },
    { id: "question_job", bookId: "book_questions_api", topicId: "topic_work", part: 1, text: "What job would you like to do?", textZh: "你想做什么工作？", normText: "what job would you like to do", status: "audited" },
    { id: "question_city", bookId: "book_questions_api", topicId: "topic_city", part: 3, text: "How can cities become greener?", textZh: "城市怎样才能变得更环保？", normText: "how can cities become greener", status: "audited" },
  ]);
  await db.insert(schema.questionSetLinks).values([
    { questionId: "question_work", questionSetId: "qs_2026_01_04", sourceSlug: "part1_new_2026q1", sourceFile: "Part1新题.pdf", sourcePage: 8 },
    { questionId: "question_work", questionSetId: "qs_2026_05_08", sourceSlug: "mdoors_part1_demo_2026q2", sourceFile: "【麦门雅思】2026年5-8月口语Part1新题高分demo.pdf", sourcePage: 6 },
    { questionId: "question_job", questionSetId: "qs_2026_01_04", sourceSlug: "part1_new_2026q1", sourceFile: "Part1新题.pdf", sourcePage: 8 },
    { questionId: "question_city", questionSetId: "qs_2026_05_08", sourceSlug: "mdoors_part3_2026q2", sourceFile: "【麦门雅思】26年5-8月Part3_十大话题高分示范.pdf", sourcePage: 7 },
  ]);
  await db.insert(schema.lexemes).values({
    id: "lexeme_enjoy",
    surface: "enjoy",
    normalized: "enjoy",
    meaningZh: "喜欢；享受",
    source: "integration-fixture",
    status: "verified",
  });
  await db.insert(schema.textAnnotations).values({
    id: "annotation_question_work_enjoy",
    contentType: "question",
    contentId: "question_work",
    startOffset: 7,
    endOffset: 12,
    surface: "enjoy",
    lexemeId: "lexeme_enjoy",
    meaningZh: "喜欢；享受",
  });

  await db.insert(schema.answerVersions).values({
    id: "answer_version_history_1",
    answerId: "answer_history_1",
    versionNo: 1,
    kind: "normalized_transcript",
    textEn: "I am interested on my work.",
  });
  await db.insert(schema.personalAnswers).values({
    id: "answer_history_1",
    questionId: "question_work",
    inputLanguage: "en",
    rawText: "I am interested on my work.",
    status: "ready",
    currentVersionId: "answer_version_history_1",
    attemptOrder: 1,
    sourceOrder: 1,
    sourceKind: "historical_import",
  });
  await db.insert(schema.gapClusters).values({
    id: "gap_cluster_interested_in",
    canonicalKey: "interested-in",
    titleZh: "介词搭配 interested in",
    gapType: "lexical_gap",
    occurrenceCount: 2,
  });
  await db.insert(schema.answerGaps).values({
    id: "gap_history_1",
    answerId: "answer_history_1",
    answerVersionId: "answer_version_history_1",
    clusterId: "gap_cluster_interested_in",
    gapType: "lexical_gap",
    evidenceText: "interested on my work",
    recommendedExpression: "interested in my work",
    explanationZh: "interested 后接介词 in。",
    confidence: 0.98,
    impactLevel: "medium",
    reviewerDecision: "approved",
    reviewerReason: "原文证据明确。",
    reviewerRunId: "reviewer_history_1",
    learningFit: true,
  });
  await db.insert(schema.chunks).values({
    id: "chunk_interested_in",
    bookId: "book_personal_ielts_answers",
    canonicalChunk: "be interested in something",
    displayChunk: "be interested in something",
    unitType: "lexical_chunk",
    meaningZh: "对某事感兴趣",
    qualityStatus: "approved",
    reviewProvenance: "independent_reviewer",
  });
  await db.insert(schema.chunkPronunciations).values({
    id: "pron_interested_in",
    chunkId: "chunk_interested_in",
    ipa: "bi ˈɪntrəstɪd ɪn",
    accent: "en-US",
    source: "integration-fixture",
    isPrimary: 1,
  });
  await db.insert(schema.questionLearningUnits).values({
    id: "unit_question_work_interested",
    questionId: "question_work",
    gapId: "gap_history_1",
    chunkId: "chunk_interested_in",
    requirement: "required",
    priority: 90,
    source: "historical_answer_gap",
  });
  await db.insert(schema.learningScenarios).values([
    { id: "scenario_common_interested", chunkId: "chunk_interested_in", gapId: "gap_history_1", scenarioKind: "common_usage", settingZh: "朋友聊天", purposeZh: "说明兴趣", reviewDecision: "approved", reviewerRunId: "scenario_reviewer_1" },
    { id: "scenario_repair_interested", chunkId: "chunk_interested_in", questionId: "question_work", gapId: "gap_history_1", scenarioKind: "question_repair", settingZh: "回答工作题", purposeZh: "修复原回答", reviewDecision: "approved", reviewerRunId: "scenario_reviewer_2" },
  ]);

  [setsRoute, questionsRoute, randomRoute, detailRoute, learningPackRoute, attemptsRoute, favoriteRoute, sourceRoute] = await Promise.all([
    import("@/app/api/question-sets/route"),
    import("@/app/api/questions/route"),
    import("@/app/api/questions/random/route"),
    import("@/app/api/questions/[id]/route"),
    import("@/app/api/questions/[id]/learning-pack/route"),
    import("@/app/api/question-attempts/route"),
    import("@/app/api/questions/[id]/favorite/route"),
    import("@/app/api/question-sources/[slug]/route"),
  ]);
});

describe("IELTS 题库 HTTP 接口", () => {
  it("返回两个题集，并支持季度、Part 和中英文搜索", async () => {
    const setsResponse = await setsRoute.GET();
    const setsBody = await setsResponse.json();
    expect(setsBody.sets.map((item: { id: string }) => item.id)).toEqual(["qs_2026_01_04", "qs_2026_05_08"]);

    const response = await questionsRoute.GET(new Request("http://local/api/questions?set=qs_2026_01_04&part=1&q=工作"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.total).toBe(2);
    expect(body.items.map((item: { id: string }) => item.id).sort()).toEqual(["question_job", "question_work"]);
    expect(body.items.find((item: { id: string }) => item.id === "question_work").interactiveQuestion.annotations).toHaveLength(1);
  });

  it("收藏和完成事件可筛选，重复 eventId 保持幂等", async () => {
    const favoriteResponse = await favoriteRoute.PUT(new Request("http://local/api/questions/question_work/favorite", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ favorite: true }),
    }), { params: Promise.resolve({ id: "question_work" }) });
    expect(favoriteResponse.status).toBe(200);

    const attemptRequest = () => new Request("http://local/api/question-attempts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ eventId: "11111111-1111-4111-8111-111111111111", questionId: "question_work", status: "completed", origin: "answer" }),
    });
    expect((await attemptsRoute.POST(attemptRequest())).status).toBe(200);
    expect((await attemptsRoute.POST(attemptRequest())).status).toBe(200);

    const response = await questionsRoute.GET(new Request("http://local/api/questions?status=answered&favorite=1"));
    const body = await response.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ id: "question_work", answered: true, favorite: true });
  });

  it("随机题排除最近随机查看，详情保留跨季度来源，PDF 只走白名单", async () => {
    for (const [index, questionId] of ["question_work", "question_job"].entries()) {
      const response = await attemptsRoute.POST(new Request("http://local/api/question-attempts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ eventId: `22222222-2222-4222-8222-22222222222${index}`, questionId, status: "viewed", origin: "random" }),
      }));
      expect(response.status).toBe(200);
    }
    const randomResponse = await randomRoute.GET(new Request("http://local/api/questions/random"));
    expect(randomResponse.status).toBe(200);
    expect((await randomResponse.json()).question.id).toBe("question_city");

    const detailResponse = await detailRoute.GET(new Request("http://local/api/questions/question_work"), { params: Promise.resolve({ id: "question_work" }) });
    const detail = await detailResponse.json();
    expect(detail.question.sources).toHaveLength(2);
    expect(detail.question.setNames).toEqual(["2026 年 1–4 月", "2026 年 5–8 月"]);

    const sourceResponse = await sourceRoute.GET(new Request("http://local/api/question-sources/part1_new_2026q1"), { params: Promise.resolve({ slug: "part1_new_2026q1" }) });
    expect(sourceResponse.headers.get("content-type")).toBe("application/pdf");
    const rejected = await sourceRoute.GET(new Request("http://local/api/question-sources/.."), { params: Promise.resolve({ slug: ".." }) });
    expect(rejected.status).toBe(400);
  });

  it("按历史回答、学习包和重复 Gap 筛选，并返回按题学习包", async () => {
    for (const status of ["has_history", "has_learning", "ready_to_learn", "repeated_gaps"]) {
      const response = await questionsRoute.GET(new Request(`http://local/api/questions?status=${status}`));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.items.map((item: { id: string }) => item.id)).toContain("question_work");
    }

    const response = await learningPackRoute.GET(new Request("http://local/api/questions/question_work/learning-pack"), { params: Promise.resolve({ id: "question_work" }) });
    expect(response.status).toBe(200);
    const { pack } = await response.json();
    expect(pack.state).toBe("ready_to_learn");
    expect(pack.summary).toMatchObject({ answerCount: 1, requiredTotal: 1, repeatedGapCount: 1 });
    expect(pack.units[0]).toMatchObject({ display: "be interested in something", scenarioKinds: ["common_usage", "question_repair"] });
  });
});
