import type { SqlReader } from "@/lib/platform/database";
import { query as sql } from "@/lib/platform/sql";

export const HOME_TIME_ZONE = "Asia/Shanghai";
const DAY_MS = 86_400_000;
const dateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: HOME_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
});

export interface HomeActivityDay {
  date: string;
  count: number;
  level: 0 | 1 | 2 | 3;
  isToday: boolean;
  isFuture: boolean;
}

export interface HomeActivity {
  timeZone: typeof HOME_TIME_ZONE;
  from: string;
  to: string;
  days: HomeActivityDay[];
  weekDays: number;
  streakDays: number;
  dailyIncomplete: boolean;
}

function shiftDay(day: string, offset: number) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + offset * DAY_MS).toISOString().slice(0, 10);
}

/** Calendar cells describe recorded contact, including consolidation, never objective mastery. */
export function projectHomeActivity(counts: ReadonlyMap<string, number>, now: Date, dailyIncomplete = false): HomeActivity {
  const today = dateFormatter.format(now);
  const weekday = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
  const monday = shiftDay(today, -weekday);
  const from = shiftDay(monday, -11 * 7);
  const to = shiftDay(monday, 6);
  const days = Array.from({ length: 12 * 7 }, (_, index): HomeActivityDay => {
    const date = shiftDay(from, index);
    const isFuture = date > today;
    const count = isFuture ? 0 : counts.get(date) ?? 0;
    return { date, count, level: count === 0 ? 0 : count < 5 ? 1 : count < 10 ? 2 : 3, isToday: date === today, isFuture };
  });
  let streakDays = 0;
  let previous = (counts.get(today) ?? 0) > 0 ? today : shiftDay(today, -1);
  while ((counts.get(previous) ?? 0) > 0) {
    streakDays++;
    previous = shiftDay(previous, -1);
  }
  return {
    timeZone: HOME_TIME_ZONE, from, to, days,
    weekDays: days.filter(day => day.date >= monday && !day.isFuture && day.count > 0).length,
    streakDays, dailyIncomplete,
  };
}

// The outcome is the recorded evidence, while kind excludes control operations even in old data.
const contactEvent = sql`((e.kind='advance' AND e.outcome='exposure') OR
  (e.kind='rate' AND e.outcome IN ('diagnostic_exposure','self_report','consolidation')))`;

/** Read original events without joining current materials: changing or hiding a source cannot erase a day. */
export async function readHomeActivity(db: SqlReader, now: Date): Promise<HomeActivity> {
  const timestamp = now.toISOString();
  // All stored learning timestamps use UTC. Shanghai has used UTC+8 throughout this application's history.
  const rows = await db.all<{ day: string; count: number }>(sql`
    SELECT strftime('%Y-%m-%d',e.created_at,'+8 hours') AS day,COUNT(DISTINCT e.learning_item_id) AS count
    FROM light_study_events e WHERE ${contactEvent} AND e.learning_item_id IS NOT NULL
      AND julianday(e.created_at)<=julianday(${timestamp})
    GROUP BY day`);
  const [{ incomplete }] = await db.all<{ incomplete: number }>(sql`
    SELECT EXISTS(SELECT 1 FROM light_study_progress lp WHERE NOT EXISTS(
      SELECT 1 FROM light_study_events e WHERE e.learning_item_id=lp.learning_item_id
        AND ((e.kind='advance' AND e.outcome='exposure') OR (e.kind='rate' AND e.outcome='diagnostic_exposure'))
        AND julianday(e.created_at)<=julianday(${timestamp})
    )) AS incomplete`);
  return projectHomeActivity(new Map(rows.map(row => [row.day, Number(row.count)])), now, Boolean(incomplete));
}
