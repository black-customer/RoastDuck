import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { assertInsideTestResults, prepareTestDatabase } from "../helpers/temp-db";

const testDatabase = prepareTestDatabase("home-overview.integration");
assertInsideTestResults(testDatabase.file);
process.env.ROASTDUCK_DB = testDatabase.url;
process.env.ROASTDUCK_SKIP_DB_BACKUP = "1";
process.env.AI_PROVIDER = "mock";

let home: typeof import("@/lib/home/overview");
let client: typeof import("@db/client");
let schema: typeof import("@db/schema");
const now = new Date("2026-09-02T17:00:00Z"); // 上海已经是 9 月 3 日。

beforeAll(async () => {
  [home, client, schema] = await Promise.all([
    import("@/lib/home/overview"), import("@db/client"), import("@db/schema"),
  ]);
  const db = await client.getDbReady();
  await db.insert(schema.questions).values({
    id: "home_question", bookId: "book_personal_ielts_answers", part: 1,
    text: "Do you enjoy reading?", textZh: "你喜欢阅读吗？", normText: "do you enjoy reading",
  });
  await db.insert(schema.personalAnswers).values({
    id: "home_answer", questionId: "home_question", inputLanguage: "zh", rawText: "测试回答", status: "ready",
  });
});

beforeEach(async () => {
  const db = await client.getDbReady();
  await db.delete(schema.learningSessions);
  for (const table of ["light_study_events", "light_study_sessions", "light_study_progress"]) await db.run(sql.raw(`DELETE FROM ${table}`));
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network in homepage regression"));
});
afterEach(() => { expect(globalThis.fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); });

describe("首页只读概览", () => {
  it("未发布个人表达不被伪装成可学内容，首页只返回活动和两个学习入口需要的数据", async () => {
    const overview = await home.getHomeOverview(now);
    expect(overview.light).toMatchObject({ totalCount: 0, newCount: 0, dueCount: 0, resumable: {} });
    expect(overview.resumeByMode).toEqual({});
    expect(overview.studiedCount).toBe(0);
    expect(overview.activity).toMatchObject({ timeZone: "Asia/Shanghai", weekDays: 0, streakDays: 0, dailyIncomplete: false });
    expect(overview.activity.days).toHaveLength(84);
    expect(Object.keys(overview).sort()).toEqual(["activity", "dateLabel", "light", "resumeByMode", "studiedCount"]);
    expect(await (await client.getDbReady()).all(sql`SELECT id,raw_text FROM personal_answers WHERE id='home_answer'`)).toEqual([{ id: "home_answer", raw_text: "测试回答" }]);
  });

  it("旧词书会话不重新成为首页训练入口，日期仍使用上海时区", async () => {
    const db = await client.getDbReady();
    await db.insert(schema.learningSessions).values([
      { id: "old-day", sessionDate: "2026-09-02", mode: "learn", queueJson: "[]", updatedAt: "2026-09-03T12:00:00Z" },
      { id: "completed", sessionDate: "2026-09-03", mode: "learn", queueJson: "[]", status: "completed", updatedAt: "2026-09-03T12:00:00Z" },
      { id: "daily", sessionDate: "2026-09-03", mode: "review", queueJson: "[]", updatedAt: "2026-09-02T16:10:00Z" },
      { id: "question", sessionDate: "2026-09-03", mode: "learn", queueJson: "[]", scopeType: "question", scopeId: "home_question", updatedAt: "2026-09-02T16:20:00Z" },
    ]);
    const overview = await home.getHomeOverview(now);
    expect(overview.resumeByMode).toEqual({});
    expect(overview.dateLabel).toContain("9月3日");
    expect(overview.activity.days.find(day => day.isToday)?.date).toBe("2026-09-03");
  });

  it("历史链接构造保留兼容，不用于当前首页", () => {
    expect(home.homeLearningHref(null, 5)).toBe("/learn?mode=review");
    expect(home.homeLearningHref(null, 0)).toBe("/learn?mode=learn");
    expect(home.homeLearningHref({ mode: "learn", scopeType: "daily", scopeId: null }, 5)).toBe("/learn?mode=learn");
    expect(home.homeLearningHref({ mode: "review", scopeType: "question", scopeId: "id &/" }, 0)).toBe("/learn?mode=review&question=id+%26%2F");
  });

  it("反复打开首页不新增回答、学习事件、进度或 AI Run", async () => {
    const db = await client.getDbReady();
    const snapshot = () => db.all(sql`SELECT
      (SELECT COUNT(*) FROM question_attempts) AS attempts,
      (SELECT COUNT(*) FROM personal_answers) AS answers,
      (SELECT COUNT(*) FROM learning_sessions) AS sessions,
      (SELECT COUNT(*) FROM learning_events) AS events,
      (SELECT COUNT(*) FROM learning_progress) AS progress,
      (SELECT COUNT(*) FROM light_study_sessions) AS light_sessions,
      (SELECT COUNT(*) FROM light_study_events) AS light_events,
      (SELECT COUNT(*) FROM light_study_progress) AS light_progress,
      (SELECT COUNT(*) FROM difficult_notes) AS notes,
      (SELECT COUNT(*) FROM ai_runs) AS runs`);
    const before = await snapshot();
    await home.getHomeOverview(now);
    await home.getHomeOverview(now);
    expect(await snapshot()).toEqual(before);
  });
  it("轻学习主动作携带其他题目范围的有效暂停会话ID，空队列不会抢占恢复入口",async()=>{
    const db=await client.getDbReady();
    const fixture = await (await import("../helpers/light-material")).publishLightFixture(db, "home-resume-answer", "brush my teeth", "刷牙", "home-resume-question");
    const light = await import("@/lib/light-study/service");
    const scope = { type: "question" as const, id: fixture.questionId };
    let session = await light.createLightSession({ scope, mode: "learn", clientRequestId: "home-resume-start" }, now);
    session = await light.applyLightEvent(session.id, { type: "reveal", version: session.version, clientEventId: "home-resume-reveal" }, now);
    session = await light.applyLightEvent(session.id, { type: "pause", version: session.version, clientEventId: "home-resume-pause" }, now);
    await db.run(sql`INSERT INTO light_study_sessions(id,scope_key,scope_json,mode,queue_json,status,created_at,updated_at)
      VALUES('home-light-paused','question','{"type":"question","id":"home_question"}','learn','[]','paused','2026-09-03T13:00:00Z','2026-09-03T13:00:00Z')`);
    const overview=await home.getHomeOverview(now);
    expect(overview.resumeByMode.learn).toEqual({ id: session.id, mode: "learn", scope, index: 0, total: 1 });
    expect(overview.studiedCount).toBe(0);
    expect(overview.activity.days.every(day => day.count === 0)).toBe(true);
    expect((await light.getLightView(session.id))).toMatchObject({ status: "paused", revealed: true, version: session.version });
  });
  it("共享表达的轻学习到期与累计只计一次，四步进度不会冒充首页轻学习", async () => {
    const materials = await import("@/lib/four-step/materials");
    const training = await import("@/lib/four-step/training");
    const db=await client.getDbReady();
    const snapshot=async(id:string)=>{await db.insert(schema.freeTalkConversations).values({id,title:'合成真实消息',mode:'relaxed'});const messages=[{id:`${id}-u`,role:'user' as const,text:'I saw a 井盖 outside.'},{id:`${id}-a`,role:'assistant' as const,text:'You saw a manhole cover.'}];for(const [index,m] of messages.entries())await db.insert(schema.freeTalkMessages).values({id:m.id,conversationId:id,sequenceNo:index+1,role:m.role,text:m.text});return messages;};
    const first = await materials.prepareMaterial({ sourceType: "free_talk", sourceId: "home-conv-one", question: null, mode: "relaxed", actualAnswer: "I saw a 井盖 outside.", intendedMeaningZh: "",sourceMessages:await snapshot('home-conv-one') });
    await materials.processMaterial(first.id);
    const active = await training.createTraining(first.id);
    let overview = await home.getHomeOverview(now);
    expect(overview.resumeByMode).toEqual({});
    expect(overview.studiedCount).toBe(0);
    const second = await materials.prepareMaterial({ sourceType: "free_talk", sourceId: "home-conv-two", question: null, mode: "relaxed", actualAnswer: "I saw a 井盖 outside.", intendedMeaningZh: "",sourceMessages:await snapshot('home-conv-two') });
    await materials.processMaterial(second.id);
    const [row] = await db.all<{ learning_item_id: string }>(sql`SELECT learning_item_id FROM practice_material_items WHERE material_id=${first.id}`);
    await db.run(sql`INSERT INTO learning_item_schedule VALUES (${row.learning_item_id},'{}','2026-09-01T00:00:00Z','2026-09-01T00:00:00Z',0)`);
    overview = await home.getHomeOverview(now);
    expect(overview.light.dueCount).toBe(0); // Optional four-step due work is not light-study due work.
    await db.run(sql`INSERT INTO light_study_progress(learning_item_id,first_seen_at,last_seen_at,due_at) VALUES(${row.learning_item_id},'2026-09-01','2026-09-01','2026-09-02')`);
    overview = await home.getHomeOverview(now);
    expect(overview.light.dueCount).toBe(1);
    expect(overview.studiedCount).toBe(1);
    expect(overview.activity.dailyIncomplete).toBe(true);
    expect(overview.activity.days.every(day => day.count === 0)).toBe(true);
    expect((await training.trainingView(active.id)).status).toBe("active");
  });
});
