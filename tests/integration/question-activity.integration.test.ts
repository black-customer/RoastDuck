import { beforeAll, describe, expect, it } from "vitest";
import { prepareTestDatabase } from "../helpers/temp-db";

const temporary = prepareTestDatabase("question-activity.integration");
process.env.ROASTDUCK_DB = temporary.url;
process.env.ROASTDUCK_SKIP_DB_BACKUP = "1";
const early = "2026-08-01T00:00:00.000Z";
const start = "2026-08-02T00:00:00.000Z";
const later = "2026-08-03T00:00:00.000Z";
let db: Awaited<ReturnType<typeof import("@db/client").getDbReady>>;
let schema: typeof import("@db/schema");
let activity: typeof import("@/lib/questions/activity");
let service: typeof import("@/lib/questions/service");
let packs: typeof import("@/lib/questions/learning-pack-service");

beforeAll(async () => {
  schema = await import("@db/schema");
  db = await (await import("@db/client")).getDbReady();
  activity = await import("@/lib/questions/activity");
  service = await import("@/lib/questions/service");
  packs = await import("@/lib/questions/learning-pack-service");
  await db.insert(schema.books).values({ id: "activity_book", titleZh: "状态测试", titleEn: "Activity", sourceType: "question_bank" });
});

async function question(id: string) {
  await db.insert(schema.questions).values({ id, bookId: "activity_book", part: 1, text: `Question ${id}?`, textZh: "测试题", normText: id });
}
async function answer(id: string, questionId: string, status = "ready", createdAt = early) {
  await db.insert(schema.personalAnswers).values({ id, questionId, status, inputLanguage: "en", rawText: "My answer.", currentVersionId: `v_${id}`, createdAt, updatedAt: createdAt });
  await db.insert(schema.answerVersions).values({ id: `v_${id}`, answerId: id, kind: "normalized_transcript", versionNo: 1, textEn: "My answer.", createdAt });
}
async function expectState(id: string, expected: string) {
  const { questionFiltersSchema } = await import("@/lib/questions/schemas");
  const list = await service.listQuestions(questionFiltersSchema.parse({ q: id }));
  const detail = await service.getQuestionDetail(id);
  const pack = await packs.getQuestionLearningPack(id);
  expect((await activity.getQuestionActivity(id))?.state).toBe(expected);
  expect(list.items.find((q) => q.id === id)?.state).toBe(expected);
  expect(detail?.state).toBe(expected);
  expect(pack?.state).toBe(expected);
  expect(detail?.primaryAction).toEqual(pack?.primaryAction);
}
async function unit(id: string, questionId: string, requirement: "required" | "optional", qualityStatus = "approved", chunkId = `c_${id}`) {
  await db.insert(schema.chunks).values({ id: chunkId, bookId: "activity_book", canonicalChunk: chunkId, displayChunk: chunkId, meaningZh: "测试", unitType: "lexical_chunk", qualityStatus, reviewProvenance: "independent_reviewer" }).onConflictDoNothing();
  await db.insert(schema.questionLearningUnits).values({ id, questionId, chunkId, requirement, source: id });
  await db.insert(schema.learningScenarios).values([
    { id: `common_${id}`, chunkId, scenarioKind: "common_usage", settingZh: "朋友聊天", purposeZh: "分享", reviewDecision: "approved", reviewerRunId: `review_common_${id}` },
    { id: `repair_${id}`, chunkId, questionId, scenarioKind: "question_repair", settingZh: "原题", purposeZh: "修复", reviewDecision: "approved", reviewerRunId: `review_repair_${id}` },
  ]);
}

describe("题目统一活动状态", () => {
  it("空题、保存但未发布的回答不是分析中，也不是默认可以重答", async () => {
    await question("q_empty"); await expectState("q_empty", "unanswered");
    await answer("a_empty", "q_empty"); await expectState("q_empty", "materials_pending");
    await unit("quarantined", "q_empty", "required", "pending_review");
    await expectState("q_empty", "materials_pending");
    expect((await packs.getQuestionLearningPack("q_empty"))?.units).toEqual([]);
  });

  it("只有真实任务才能显示处理中，最新成功重试不被旧失败遮住", async () => {
    await question("q_job"); await answer("a_job", "q_job");
    await db.insert(schema.aiJobs).values({ id: "j_failed", kind: "speaking_learning_material_pipeline", targetType: "answer_version", targetId: "v_a_job", status: "retryable_failure", idempotencyKey: "job_failure", createdAt: early });
    await expectState("q_job", "analysis_failed");
    await db.insert(schema.aiJobs).values({ id: "j_retry", kind: "speaking_learning_material_pipeline", targetType: "answer_version", targetId: "v_a_job", status: "generating", idempotencyKey: "job_retry", createdAt: later });
    await expectState("q_job", "analysis_pending");
    const { eq } = await import("drizzle-orm");
    await db.update(schema.aiJobs).set({ status: "completed" }).where(eq(schema.aiJobs.id, "j_retry"));
    await expectState("q_job", "materials_pending");
  });

  it("必学首轮完成即可重答，可选项不阻塞，跨题与多来源共享一份进度", async () => {
    const { eq } = await import("drizzle-orm");
    for (const q of ["q_required", "q_shared", "q_optional"]) { await question(q); await answer(`a_${q}`, q); }
    await unit("u_required", "q_required", "required");
    await unit("u_optional", "q_required", "optional");
    await unit("u_shared", "q_shared", "required", "approved", "c_u_required");
    await db.insert(schema.questionLearningUnits).values({ id: "duplicate_source", questionId: "q_shared", chunkId: "c_u_required", requirement: "optional", source: "other_source" });
    await unit("only_optional", "q_optional", "optional");
    await expectState("q_required", "ready_to_learn");
    await expectState("q_optional", "ready_to_reattempt");
    await db.update(schema.questionLearningUnits).set({ firstRoundCompletedAt: later }).where(eq(schema.questionLearningUnits.id, "u_required"));
    await expectState("q_required", "ready_to_reattempt");
    await expectState("q_shared", "ready_to_reattempt");
    const pack = await packs.getQuestionLearningPack("q_shared");
    expect(pack?.units).toHaveLength(1);
    expect(pack?.summary.requiredCompleted).toBe(1);
    const { questionFiltersSchema } = await import("@/lib/questions/schemas");
    const ready = await service.listQuestions(questionFiltersSchema.parse({ status: "ready_to_reattempt" }));
    expect(ready.items.map((q) => q.id)).toEqual(expect.arrayContaining(["q_required", "q_shared", "q_optional"]));
  });

  it("v1/v2 只统计有效完成入账的重答，排除草稿、失败、旧答案、跨题和重复关联", async () => {
    await question("q_retry"); await answer("a_original", "q_retry");
    await unit("u_retry", "q_retry", "optional");
    await question("q_other"); await answer("a_other", "q_other", "ready", later);
    for (const id of ["a_v1", "a_v2", "a_failed"]) await answer(id, "q_retry", id === "a_failed" ? "failed" : "ready", later);
    const cases = [
      ["s_v1", "a_v1", "completed", "teacher_chat_v1"],
      ["s_v2", "a_v2", "completed", "teacher_chat_v2"],
      ["s_duplicate", "a_v2", "completed", "teacher_chat_v2"],
      ["s_draft", "a_v1", "ready", "teacher_chat_v1"],
      ["s_failed", "a_v1", "ai_failed", "teacher_chat_v1"],
      ["s_unposted", "missing", "completed", "teacher_chat_v1"],
      ["s_wrong_question", "a_other", "completed", "teacher_chat_v2"],
      ["s_old_answer", "a_original", "completed", "teacher_chat_v1"],
      ["s_failed_answer", "a_failed", "completed", "teacher_chat_v1"],
      ["s_legacy_form", "a_v1", "completed", "correction_v1"],
    ];
    await db.insert(schema.speakingSessions).values(cases.map(([id, answerId, status, experienceVersion]) => ({ id, questionId: "q_retry", answerId, status, experienceVersion, createdAt: start, updatedAt: later })));
    const row = await activity.getQuestionActivity("q_retry");
    expect(row?.reattemptCount).toBe(2);
    expect((await packs.getQuestionLearningPack("q_retry"))?.reattemptCount).toBe(2);
    const { questionFiltersSchema } = await import("@/lib/questions/schemas");
    const list = await service.listQuestions(questionFiltersSchema.parse({ status: "reattempted" }));
    expect(list.items.find((q) => q.id === "q_retry")?.reattemptCount).toBe(2);
  });

  it("首次回答的完成会话不冒充重答", async () => {
    await question("q_first"); await answer("a_first", "q_first", "ready", later);
    await db.insert(schema.speakingSessions).values({ id: "s_first", questionId: "q_first", answerId: "a_first", status: "completed", experienceVersion: "teacher_chat_v1", createdAt: start });
    expect((await activity.getQuestionActivity("q_first"))?.reattemptCount).toBe(0);
  });

  it("无需制卡必须有独立审核证据，普通 ready 或只有规则/单次运行不够", async () => {
    await question("q_no_cards"); await answer("a_no_cards", "q_no_cards");
    await db.insert(schema.aiJobs).values({ id: "j_review", kind: "speaking_gap_pipeline", status: "completed", targetType: "personal_answer", targetId: "a_no_cards", idempotencyKey: "no_cards", updatedAt: later });
    await expectState("q_no_cards", "materials_pending");
    for (const role of ["gap_generator", "gap_reviewer"]) {
      await db.insert(schema.aiRuns).values({ runId: role, jobId: "j_review", role, provider: "mock", model: "deepseek-v4-flash", status: "completed", promptVersion: role, inputHash: `hash_${role}` });
    }
    await expectState("q_no_cards", "ready_to_reattempt");
    expect((await activity.getQuestionActivity("missing"))).toBeNull();
  });
  it("新旧回答按真实时间比较，失败和处理中也保留稳定入口，不按ID前缀猜来源", async () => {
    await question("q_mixed_history");
    await answer("latest_personal", "q_mixed_history", "ready", "2026-09-05T00:00:00Z");
    await db.insert(schema.speakingQuestionAttempts).values({ id: "id_without_prefix", questionId: "q_mixed_history", mode: "practice", answerText: "My raw answer", status: "completed", createdAt: early });
    expect((await activity.getQuestionActivity("q_mixed_history"))?.latestAnswerId).toBe("latest_personal");
    const { eq } = await import("drizzle-orm");
    await db.update(schema.speakingQuestionAttempts).set({ createdAt: "2026-09-06T00:00:00Z", status: "failed" }).where(eq(schema.speakingQuestionAttempts.id, "id_without_prefix"));
    await expectState("q_mixed_history", "analysis_failed");
    const detail = await service.getQuestionDetail("q_mixed_history");
    expect(detail?.primaryAction.href).toBe("/questions/q_mixed_history/attempts/id_without_prefix");
    expect(detail?.answerCount).toBe(2);
  });
});
