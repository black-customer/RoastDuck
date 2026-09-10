import fs from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { MockAiProvider } from "@/lib/ai/mock-provider";
import { createRuntimeCalls } from "@/lib/ai/runtime-ledger";
import { createMaterialService } from "@/lib/four-step/core-materials";
import { selectionMockResolver } from "@/lib/four-step/selection-mock";
import { createHomeOverview } from "@/lib/home/overview";
import { createLightCatalogue } from "@/lib/light-study/core-catalogue";
import type { LightCard, LightScope } from "@/lib/light-study/contracts";
import { advanceLightRound, createLightRound, revealLightRound, type LightRound } from "@/lib/light-study/round";
import { portableTestDatabase } from "./helpers/portable-db";

const opened: Array<ReturnType<typeof portableTestDatabase>> = [];
afterEach(() => { vi.restoreAllMocks(); for (const fixture of opened.splice(0)) fixture.close(); });
const now = new Date("2026-09-08T08:00:00Z");

async function setup() {
  const fixture = portableTestDatabase(); opened.push(fixture);
  let sequence = 0;
  const options = { now: () => now, newId: () => `home-${++sequence}`, bootId: "home-test", allowMock: true };
  const runtime = createRuntimeCalls(fixture.database, new MockAiProvider(selectionMockResolver), options);
  const materials = createMaterialService({ ...options, database: fixture.database, runtime, loadPrompt: name => fs.readFileSync(`pipeline/prompts/${name}`, "utf8") });
  fixture.connection.exec("INSERT INTO questions(id,book_id,part,text,text_zh,norm_text) VALUES('q','retired',1,'Do you live alone?','你一个人住吗？','q')");
  const english = "I'm used to live alone.", chinese = "我已经习惯一个人住了。";
  fixture.connection.prepare("INSERT INTO speaking_question_attempts(id,question_id,mode,answer_text,intended_meaning_zh,status) VALUES('attempt','q','practice',?,?,'processing')").run(english, chinese);
  const ielts = await materials.prepare({ sourceType: "ielts_practice", sourceId: "attempt", question: { id: "q", part: 1, textEn: "Do you live alone?", textZh: "你一个人住吗？" }, mode: "practice", actualAnswer: english, intendedMeaningZh: chinese });
  expect((await materials.process(ielts.id)).status).toBe("ready");
  async function chat(id: string, text: string, meaning: string) {
    fixture.connection.prepare("INSERT INTO free_talk_conversations(id,title) VALUES(?,?)").run(id, "合成对话");
    fixture.connection.prepare("INSERT INTO free_talk_messages(id,conversation_id,sequence_no,role,text) VALUES(?,?,1,'user',?)").run(id + "-message", id, text);
    const material = await materials.prepare({ sourceType: "free_talk", sourceId: id, question: null, mode: "relaxed", actualAnswer: text, intendedMeaningZh: meaning,
      sourceMessages: [{ id: id + "-message", role: "user", text }] });
    expect((await materials.process(material.id)).status).toBe("ready");
    return material;
  }
  const talk = await chat("shared-chat", english, chinese);
  const other = await chat("other-chat", "I saw a 井盖 outside.", "我在外面看到了一个井盖。");
  const cards = (await fixture.database.read(db => createLightCatalogue(db, true).readLightCatalogue({ type: "all" }))).cards;
  const ieltsCards = (await fixture.database.read(db => createLightCatalogue(db, true).readLightCatalogue({ type: "material", id: ielts.id }))).cards;
  const home = createHomeOverview(fixture.database, { enabled: () => true, allowMock: true });
  return { ...fixture, home, cards, ieltsCards, ielts, talk, other, chat };
}

function putSession(f: Awaited<ReturnType<typeof setup>>, id: string, cards: LightCard[], options: {
  mode?: "learn" | "review"; scope?: LightScope; status?: "active" | "paused" | "completed";
  at?: string; round?: LightRound; legacy?: boolean;
} = {}) {
  const scope = JSON.stringify(options.scope ?? { type: "all" }), round = options.round ?? createLightRound(cards.length);
  f.connection.prepare(`INSERT INTO light_study_sessions(id,scope_key,scope_json,mode,queue_json,status,cursor,revealed,experience_version,round_json,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, scope, scope, options.mode ?? "learn", JSON.stringify(cards), options.status ?? "paused", round.cursor, Number(round.revealed),
      options.legacy ? "light_study_v1" : "light_study_v2", options.legacy ? null : JSON.stringify(round), options.at ?? "2026-09-08T01:00:00Z", options.at ?? "2026-09-08T01:00:00Z");
}

it("returns exact newest usable sessions per mode, rejecting foreign, succeeded, damaged and finished snapshots", async () => {
  const f = await setup(), grammar = f.ieltsCards[0], other = f.cards.find(card => card.materialId === f.other.id)!;
  f.connection.prepare("INSERT INTO light_study_progress(learning_item_id,first_seen_at,last_seen_at,due_at,version) VALUES(?,'2026-09-01','2026-09-01','2026-09-02',3)").run(other.itemId);
  putSession(f, "learn-all", [grammar]);
  putSession(f, "learn-question", [grammar], { scope: { type: "question", id: "q" }, at: "2026-09-08T02:00:00Z" });
  putSession(f, "review-talk", [{ ...other, progressVersion: 3 }], { mode: "review", scope: { type: "collection", id: "free_talk" }, at: "2026-09-08T02:00:00Z" });
  putSession(f, "foreign", [grammar], { at: "2026-09-08T03:00:00Z" });
  f.connection.exec(`INSERT INTO app_device(singleton,device_id,dataset_id,created_at) VALUES(1,'here','dataset','2026-09-01');
    INSERT INTO device_sync_owners(entity,record_key,owner_device_id) VALUES('light_study_sessions','["foreign"]','elsewhere')`);
  putSession(f, "succeeded", [grammar], { at: "2026-09-08T04:00:00Z" });
  f.connection.exec("INSERT INTO light_study_successions(legacy_session_id,current_session_id,cutover_version,remaining_json,created_at,updated_at) VALUES('succeeded','learn-question',0,'[]','2026-09-08','2026-09-08')");
  putSession(f, "completed", [grammar], { status: "completed", at: "2026-09-08T05:00:00Z" });
  putSession(f, "bad-hash", [{ ...grammar, materialHash: "obsolete" }], { at: "2026-09-08T06:00:00Z" });
  putSession(f, "broken", [grammar], { at: "2026-09-08T07:00:00Z" });
  f.connection.exec("UPDATE light_study_sessions SET queue_json='not-json' WHERE id='broken'");
  const finished = advanceLightRound(revealLightRound(createLightRound(1)), "remembered");
  putSession(f, "finished-cursor", [grammar], { round: finished, at: "2026-09-08T07:30:00Z" });
  const before = f.connection.prepare("SELECT total_changes() AS count").get();
  const write = vi.spyOn(f.database, "write");
  const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network"));
  const overview = await f.home(now);
  expect(overview.resumeByMode).toEqual({
    learn: { id: "learn-question", scope: { type: "question", id: "q" }, mode: "learn", index: 0, total: 1 },
    review: { id: "review-talk", scope: { type: "collection", id: "free_talk" }, mode: "review", index: 0, total: 1 },
  });
  expect(overview.light).toMatchObject({ newCount: 1, dueCount: 1, totalCount: 2, resumable: { learn: { id: "learn-all", index: 0, total: 1 } } });
  expect(await f.home(now)).toEqual(overview);
  expect(f.connection.prepare("SELECT total_changes() AS count").get()).toEqual(before);
  expect(write).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
});

it("keeps historical studied items once across shared sources and hides no past work when materials stop being current", async () => {
  const f = await setup(), grammar = f.ieltsCards[0];
  f.connection.prepare("INSERT INTO light_study_progress(learning_item_id,first_seen_at,last_seen_at,due_at) VALUES(?,'2026-09-01','2026-09-01','2026-09-02')").run(grammar.itemId);
  f.connection.prepare("INSERT INTO expression_preferences(learning_item_id,hidden,self_known,updated_at) VALUES(?,1,1,'2026-09-08')").run(grammar.itemId);
  let overview = await f.home(now);
  expect(overview).toMatchObject({ studiedCount: 1, activity: { dailyIncomplete: true }, light: { totalCount: 1, newCount: 1, dueCount: 0 } });
  expect(overview.activity.days.every(day => day.count === 0)).toBe(true);
  f.connection.prepare("UPDATE practice_materials SET status='failed' WHERE id IN (?,?)").run(f.ielts.id, f.talk.id);
  f.connection.prepare("UPDATE learning_items SET status='retired' WHERE id=?").run(grammar.itemId);
  overview = await f.home(now);
  expect(overview.studiedCount).toBe(1);
  expect(overview.light.totalCount).toBe(1);
});

it("filters hidden, stopped and stale remaining cards while retaining a valid later card without advancing the cursor", async () => {
  const f = await setup(), grammar = f.ieltsCards[0], other = f.cards.find(card => card.materialId === f.other.id)!;
  putSession(f, "partial", [grammar, other], { scope: { type: "collection", id: "free_talk" } });
  f.connection.prepare("INSERT INTO expression_preferences(learning_item_id,hidden,updated_at) VALUES(?,1,'2026-09-08')").run(grammar.itemId);
  expect((await f.home(now)).resumeByMode.learn).toMatchObject({ id: "partial", index: 0, total: 2 });
  f.connection.prepare("INSERT INTO expression_preferences(learning_item_id,self_known,updated_at) VALUES(?,1,'2026-09-08')").run(other.itemId);
  expect((await f.home(now)).resumeByMode).toEqual({});
  f.connection.prepare("UPDATE expression_preferences SET self_known=0 WHERE learning_item_id=?").run(other.itemId);
  f.connection.prepare("INSERT INTO light_study_progress(learning_item_id,first_seen_at,last_seen_at,due_at) VALUES(?,'2026-09-01','2026-09-01','2026-09-02')").run(other.itemId);
  expect((await f.home(now)).resumeByMode).toEqual({});
  expect(f.connection.prepare("SELECT cursor,status FROM light_study_sessions WHERE id='partial'").get()).toMatchObject({ cursor: 0, status: "paused" });
});

it("V1 pending review can reproject a newer still-due version, but learned or no-longer-due legacy work is not resumed", async () => {
  const f = await setup(), grammar = f.ieltsCards[0];
  f.connection.prepare("INSERT INTO light_study_progress(learning_item_id,first_seen_at,last_seen_at,due_at,version) VALUES(?,'2026-09-01','2026-09-01','2026-09-02',4)").run(grammar.itemId);
  putSession(f, "legacy-review", [grammar], { legacy: true, mode: "review" });
  putSession(f, "legacy-learn", [grammar], { legacy: true });
  expect((await f.home(now)).resumeByMode).toEqual({ review: { id: "legacy-review", scope: { type: "all" }, mode: "review", index: 0, total: 1 } });
  f.connection.prepare("UPDATE light_study_progress SET due_at='2026-09-10' WHERE learning_item_id=?").run(grammar.itemId);
  expect((await f.home(now)).resumeByMode).toEqual({});
  expect(f.connection.prepare("SELECT * FROM light_study_successions").all()).toEqual([]);
});

it("V2 consolidation resumes with its assessed progress version without counting it as a new item or creating an FSRS event", async () => {
  const f = await setup();
  await f.chat("missing-chat", "I'm a student.", "我是一名大四学生，从化学转到计算机专业。");
  const cards = (await f.database.read(db => createLightCatalogue(db, true).readLightCatalogue({ type: "all" }))).cards;
  expect(cards).toHaveLength(4);
  let round = createLightRound(cards.length);
  for (let index = 0; index < cards.length; index++) round = advanceLightRound(revealLightRound(round), "forgot");
  expect(round).toMatchObject({ cursor: 4, queue: expect.any(Array) });
  expect(round.queue).toHaveLength(7);
  for (const card of cards) f.connection.prepare("INSERT INTO light_study_progress(learning_item_id,first_seen_at,last_seen_at,due_at) VALUES(?,'2026-09-08','2026-09-08','2026-09-09')").run(card.itemId);
  putSession(f, "consolidation", cards, { round });
  const overview = await f.home(now);
  expect(overview.resumeByMode.learn).toMatchObject({ id: "consolidation", index: 4, total: 7 });
  expect(overview.light).toMatchObject({ newCount: 0, dueCount: 0 });
  expect(f.connection.prepare("SELECT * FROM light_study_events").all()).toEqual([]);
  f.connection.prepare("UPDATE light_study_progress SET version=2 WHERE learning_item_id=?").run(cards[0].itemId);
  expect((await f.home(now)).resumeByMode).toEqual({});
});
