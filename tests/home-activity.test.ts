import { afterEach, expect, it } from "vitest";
import { projectHomeActivity, readHomeActivity } from "@/lib/home/activity";
import { portableTestDatabase } from "./helpers/portable-db";

const opened: Array<ReturnType<typeof portableTestDatabase>> = [];
afterEach(() => { for (const fixture of opened.splice(0)) fixture.close(); });
function setup() { const fixture = portableTestDatabase(); opened.push(fixture); return fixture; }
const now = new Date("2026-09-08T08:00:00Z");

it("shows twelve Monday-based Shanghai weeks, fixed activity levels, and empty future cells", () => {
  const activity = projectHomeActivity(new Map([
    ["2026-09-02", 1], ["2026-09-03", 4], ["2026-09-04", 5], ["2026-09-05", 9],
    ["2026-09-06", 10], ["2026-09-07", 11], ["2026-09-08", 2], ["2026-09-09", 20],
  ]), now);
  expect(activity).toMatchObject({ timeZone: "Asia/Shanghai", from: "2026-06-22", to: "2026-09-13", weekDays: 2, streakDays: 7 });
  expect(activity.days).toHaveLength(84);
  expect(activity.days.filter(day => day.date >= "2026-09-01" && day.date <= "2026-09-09").map(day => day.level))
    .toEqual([0, 1, 1, 2, 2, 3, 3, 1, 0]);
  expect(activity.days.find(day => day.date === "2026-09-08")).toMatchObject({ isToday: true, isFuture: false });
  expect(activity.days.find(day => day.date === "2026-09-09")).toMatchObject({ count: 0, isFuture: true });
});

it("an inactive today carries yesterday's streak, and a streak can exceed the visible twelve weeks", () => {
  const counts = new Map<string, number>();
  for (let index = 1; index <= 100; index++) counts.set(new Date(Date.parse("2026-09-08T00:00:00Z") - index * 86_400_000).toISOString().slice(0, 10), 1);
  const activity = projectHomeActivity(counts, now);
  expect(activity).toMatchObject({ streakDays: 100, weekDays: 1 });
  counts.delete("2026-09-07");
  expect(projectHomeActivity(counts, now).streakDays).toBe(0);
});

it("counts original learning events by Shanghai day and stable item, including consolidation without counting controls", async () => {
  const f = setup();
  const insert = f.connection.prepare("INSERT INTO light_study_events(session_id,client_event_id,kind,payload_hash,learning_item_id,outcome,created_at) VALUES(?,?,?,?,?,?,?)");
  const event = (id: string, kind: string, item: string | null, outcome: string, at: string, session = "s") => insert.run(session, id, kind, id, item, outcome, at);
  event("old", "advance", "shared", "exposure", "2026-09-06T16:00:00Z");
  event("first", "rate", "shared", "diagnostic_exposure", "2026-09-07T15:59:59.999Z");
  event("review", "rate", "shared", "self_report", "2026-09-07T16:00:00Z", "another-source");
  event("same-day", "rate", "shared", "consolidation", "2026-09-08T00:00:00Z");
  event("consolidation", "rate", "other", "consolidation", "2026-09-08T00:01:00Z");
  for (const [kind, outcome] of [["reveal", "recorded"], ["pause", "recorded"], ["create", "created_or_resumed"], ["rate", "skipped"], ["reveal", "self_report"]]) {
    event(kind + outcome, kind, kind, outcome, "2026-09-08T01:00:00Z");
  }
  event("future-today", "rate", "future-today", "self_report", "2026-09-08T09:00:00Z");
  event("future-day", "rate", "future-day", "self_report", "2026-09-08T16:00:00Z");
  event("invalid-date", "rate", "invalid", "self_report", "not-a-timestamp");
  event("missing-item", "rate", null, "self_report", "2026-09-08T01:00:00Z");
  const before = f.connection.prepare("SELECT * FROM light_study_events ORDER BY client_event_id").all();
  const activity = await f.database.read(db => readHomeActivity(db, now));
  expect(activity.days.filter(day => day.count > 0).map(({ date, count }) => ({ date, count })))
    .toEqual([{ date: "2026-09-07", count: 1 }, { date: "2026-09-08", count: 2 }]);
  expect(activity).toMatchObject({ streakDays: 2, weekDays: 2, dailyIncomplete: false });
  expect(f.connection.prepare("SELECT * FROM light_study_events ORDER BY client_event_id").all()).toEqual(before);
  expect(f.connection.prepare("SELECT * FROM light_study_progress").all()).toEqual([]);
});

it("missing historical exposure dates are disclosed without inventing daily activity from progress", async () => {
  const f = setup();
  f.connection.exec("INSERT INTO light_study_progress(learning_item_id,first_seen_at,last_seen_at,due_at) VALUES('historical','2026-09-01','2026-09-07','2026-09-10')");
  const read = () => f.database.read(db => readHomeActivity(db, now));
  expect(await read()).toMatchObject({ dailyIncomplete: true, streakDays: 0, weekDays: 0 });
  expect((await read()).days.every(day => day.count === 0)).toBe(true);
  f.connection.exec("INSERT INTO light_study_events(session_id,client_event_id,kind,payload_hash,learning_item_id,outcome,created_at) VALUES('s','review','rate','review','historical','self_report','2026-09-07T08:00:00Z')");
  expect((await read()).dailyIncomplete).toBe(true);
  f.connection.exec("INSERT INTO light_study_events(session_id,client_event_id,kind,payload_hash,learning_item_id,outcome,created_at) VALUES('s','first','advance','first','historical','exposure','2026-09-01T08:00:00Z')");
  expect((await read()).dailyIncomplete).toBe(false);
});

it("Shanghai midnight determines today even while UTC is still yesterday", () => {
  const activity = projectHomeActivity(new Map([["2026-09-07", 1]]), new Date("2026-09-06T16:00:00Z"));
  expect(activity.days.find(day => day.isToday)?.date).toBe("2026-09-07");
  expect(activity).toMatchObject({ weekDays: 1, streakDays: 1 });
});
