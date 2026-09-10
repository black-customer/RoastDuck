import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { assertInsideTestResults, prepareTestDatabase } from "../helpers/temp-db";
import { publishLightFixture } from "../helpers/light-material";

const temporary = prepareTestDatabase("home-study-options");
assertInsideTestResults(temporary.file);
process.env.ROASTDUCK_DB = temporary.url;
process.env.ROASTDUCK_SKIP_DB_BACKUP = "1";
process.env.AI_PROVIDER = "mock";

let db: Awaited<ReturnType<typeof import("@db/client").getDbReady>>;
let options: typeof import("@/lib/home/study-options");
let home: typeof import("@/lib/home/overview");
let sharedItem: string;
let otherItem: string;
const now = new Date("2026-09-08T08:00:00Z");

beforeAll(async () => {
  db = await (await import("@db/client")).getDbReady();
  options = await import("@/lib/home/study-options"); home = await import("@/lib/home/overview");
  const first = await publishLightFixture(db, "choice-shared-a", "brush my teeth", "刷牙", "choice-q-a");
  await publishLightFixture(db, "choice-shared-b", "brush my teeth", "刷牙", "choice-q-b");
  await publishLightFixture(db, "choice-shared-a-again", "brush my teeth", "刷牙", "choice-q-a");
  const other = await publishLightFixture(db, "choice-other", "wash my hands", "洗手", "choice-q-c");
  const [firstLink] = await db.all<{ learning_item_id: string }>(sql`SELECT learning_item_id FROM practice_material_items WHERE material_id=${first.materialId}`);
  const [otherLink] = await db.all<{ learning_item_id: string }>(sql`SELECT learning_item_id FROM practice_material_items WHERE material_id=${other.materialId}`);
  sharedItem = firstLink.learning_item_id; otherItem = otherLink.learning_item_id;
  await db.run(sql`INSERT INTO questions(id,book_id,part,text,text_zh,norm_text) VALUES('choice-new','retired',2,'Describe a place.','描述一个地方。','choice-new')`);
  await db.run(sql`INSERT INTO topics(id,book_id,name_zh,name_en) VALUES('choice-topic','retired','日常生活','Daily life')`);
  await db.run(sql`UPDATE questions SET topic_id='choice-topic' WHERE id IN ('choice-q-a','choice-q-b')`);
  await db.run(sql`INSERT INTO question_sets(id,name_zh,year,start_month,end_month) VALUES('choice-season-a','2026年1—4月',2026,1,4),('choice-season-b','2026年5—8月',2026,5,8)`);
  await db.run(sql`INSERT INTO question_set_links(question_id,question_set_id,source_slug,source_file,source_page) VALUES('choice-q-a','choice-season-a','fixture','fixture.pdf',1),('choice-q-a','choice-season-b','fixture','fixture.pdf',1)`);
});

beforeEach(async () => {
  await db.run(sql`DELETE FROM light_study_progress`);
  await db.run(sql`DELETE FROM expression_preferences`);
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network in study options"));
});
afterEach(() => { expect(globalThis.fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); });

it("shared sources are projected onto every question and counted once per question, with real topic and season metadata", async () => {
  const result = await options.studyQuestionOptions("learn", now);
  for (const id of ["choice-q-a", "choice-q-b", "choice-q-c"]) expect(result.find(q => q.id === id)).toMatchObject({ newCount: 1, totalCount: 1, dueCount: 0 });
  expect(result.find(q => q.id === "choice-q-a")).toMatchObject({ topicId: "choice-topic", topic: "日常生活",
    seasons: expect.arrayContaining([{ id: "choice-season-a", name: "2026年1—4月" }, { id: "choice-season-b", name: "2026年5—8月" }]) });
  expect((await home.getHomeOverview(now)).light).toMatchObject({ totalCount: 2, newCount: 2, dueCount: 0 });
});

it("review offers only due questions while a new unanswered question remains available for a real answer", async () => {
  await db.run(sql`INSERT INTO light_study_progress(learning_item_id,first_seen_at,last_seen_at,due_at) VALUES
    (${sharedItem},'2026-09-01','2026-09-01','2026-09-08T08:00:00Z'),
    (${otherItem},'2026-09-01','2026-09-01','2026-09-08T08:00:01Z')`);
  const review = await options.studyQuestionOptions("review", now);
  expect(review.map(q => q.id).sort()).toEqual(["choice-q-a", "choice-q-b"]);
  expect(review.every(q => q.newCount === 0 && q.dueCount === 1)).toBe(true);
  const learn = await options.studyQuestionOptions("learn", now);
  expect(learn.find(q => q.id === "choice-new")).toMatchObject({ newCount: 0, dueCount: 0, totalCount: 0, materialId: null, materialStatus: null, sourceId: null });
});

it("hidden and self-known items never inflate availability or due options, and restoring preferences preserves their schedule", async () => {
  await db.run(sql`INSERT INTO light_study_progress(learning_item_id,first_seen_at,last_seen_at,due_at) VALUES(${sharedItem},'2026-09-01','2026-09-01','2026-09-02')`);
  await db.run(sql`INSERT INTO expression_preferences(learning_item_id,hidden,self_known,updated_at) VALUES(${sharedItem},1,0,'2026-09-08'),(${otherItem},0,1,'2026-09-08')`);
  const before = await db.all(sql`SELECT * FROM light_study_progress`);
  const learn = await options.studyQuestionOptions("learn", now);
  expect(learn.filter(q => q.id.startsWith("choice-q-")).every(q => q.newCount === 0 && q.dueCount === 0 && q.totalCount === 0)).toBe(true);
  expect(await options.studyQuestionOptions("review", now)).toEqual([]);
  await db.run(sql`UPDATE expression_preferences SET hidden=0 WHERE learning_item_id=${sharedItem}`);
  expect((await options.studyQuestionOptions("review", now)).map(q => q.id).sort()).toEqual(["choice-q-a", "choice-q-b"]);
  expect(await db.all(sql`SELECT * FROM light_study_progress`)).toEqual(before);
});

it("both option lists and the homepage are repeatable reads with no new answers, sessions, events, materials, or runtime requests", async () => {
  const snapshot = () => db.all(sql`SELECT
    (SELECT COUNT(*) FROM speaking_question_attempts) AS answers,
    (SELECT COUNT(*) FROM practice_materials) AS materials,
    (SELECT COUNT(*) FROM light_study_sessions) AS sessions,
    (SELECT COUNT(*) FROM light_study_events) AS events,
    (SELECT COUNT(*) FROM light_study_progress) AS progress,
    (SELECT COUNT(*) FROM light_study_successions) AS successions,
    (SELECT COUNT(*) FROM runtime_requests) AS requests,
    (SELECT COUNT(*) FROM ai_runs) AS runs`);
  const before = await snapshot();
  const first = await options.studyQuestionOptions("learn", now);
  expect(await options.studyQuestionOptions("learn", now)).toEqual(first);
  await options.studyQuestionOptions("review", now);
  await home.getHomeOverview(now);
  expect(await snapshot()).toEqual(before);
});
