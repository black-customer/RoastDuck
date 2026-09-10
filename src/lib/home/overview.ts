import { z } from "zod";
import type { DatabasePort, SqlReader } from "@/lib/platform/database";
import { nodeDatabase } from "@/lib/platform/node/database";
import { query as sql } from "@/lib/platform/sql";
import { localOwnerFilter } from "@/lib/device-sync/ownership";
import { createLightCatalogue, type ProgressRow } from "@/lib/light-study/core-catalogue";
import { lightStudyEnabled } from "@/lib/light-study/enabled";
import { LightStudyError, modeSchema, scopeSchema, type LightCard, type LightMode, type LightOverview, type LightScope } from "@/lib/light-study/contracts";
import { consolidationIsEligible, initialWasAssessed, lightRoundSchema } from "@/lib/light-study/round";
import { notSuperseded } from "@/lib/light-study/succession";
import { HOME_TIME_ZONE, readHomeActivity } from "./activity";

export interface HomeSession {
  mode: "learn" | "review";
  scopeType: "daily" | "question";
  scopeId: string | null;
  experienceVersion?: string;
}

/** Old links remain readable; current home actions use concrete light-study session IDs. */
export function homeLearningHref(session: HomeSession | null, dueCount: number): string {
  const params = new URLSearchParams({ mode: session?.mode ?? (dueCount > 0 ? "review" : "learn") });
  if (session?.scopeType === "question" && session.scopeId) params.set("question", session.scopeId);
  return `/learn?${params}`;
}

export interface HomeResume {
  id: string;
  scope: LightScope;
  mode: LightMode;
  index: number;
  total: number;
}

interface ResumeRow {
  id: string;
  scope_json: string;
  mode: string;
  cursor: number;
  revealed: number;
  queue_json: string;
  experience_version: string;
  round_json: string | null;
}

const snapshotSchema = z.object({
  itemId: z.string().min(1), materialId: z.string().min(1), materialHash: z.string().min(1),
  rowIndex: z.number().int().nonnegative(), progressVersion: z.number().int().nonnegative(),
});
type ResumeSnapshot = z.infer<typeof snapshotSchema>;

function remainingSnapshot(row: ResumeRow) {
  try {
    const scope = scopeSchema.parse(JSON.parse(row.scope_json));
    const mode = modeSchema.parse(row.mode);
    const cards = z.array(snapshotSchema).parse(JSON.parse(row.queue_json));
    if (!Number.isInteger(row.cursor) || row.cursor < 0 || !cards.length) return null;
    if (row.experience_version === "light_study_v1") {
      if (row.cursor >= cards.length) return null;
      return { scope, mode, total: cards.length, remaining: cards.slice(row.cursor), legacy: true };
    }
    if (row.experience_version !== "light_study_v2") return null;
    const round = lightRoundSchema.parse(JSON.parse(row.round_json ?? "null"));
    if (round.initialCount !== cards.length || round.cursor !== row.cursor || round.revealed !== Boolean(row.revealed)) return null;
    return {
      scope, mode, total: round.queue.length, legacy: false,
      remaining: round.queue.flatMap((occurrence, cursor) => cursor < round.cursor || !consolidationIsEligible({ ...round, cursor }) ? [] : [{
        ...cards[occurrence.sourceIndex],
        progressVersion: cards[occurrence.sourceIndex].progressVersion + Number(initialWasAssessed(round, occurrence.sourceIndex)),
      }]),
    };
  } catch { return null; } // A damaged historical snapshot cannot prevent access to other valid sessions.
}

async function readHomeResumes(db: SqlReader, cards: LightCard[], progress: Map<string, ProgressRow>, now: Date, allowMock: boolean) {
  const rows = await db.all<ResumeRow>(sql`SELECT * FROM light_study_sessions
    WHERE status IN ('active','paused') AND ${notSuperseded}
      AND ${localOwnerFilter('light_study_sessions', 'light_study_sessions.id')}
    ORDER BY julianday(updated_at) DESC,id DESC`);
  const resumeByMode: Partial<Record<LightMode, HomeResume>> = {};
  const allResumable: LightOverview["resumable"] = {};
  const snapshots = new Map(cards.map(card => [card.itemId + ':' + card.materialId, card]));
  const allowedKeys = new Set(cards.flatMap(card => (card.sources?.length ? card.sources : [{ materialId: card.materialId }])
    .map(source => card.itemId + ':' + source.materialId)));
  const materialCards = new Map<string, Map<string, LightCard>>();
  async function liveSnapshot(card: ResumeSnapshot) {
    const key = card.itemId + ':' + card.materialId;
    if (!allowedKeys.has(key)) return null;
    let live = snapshots.get(key);
    if (!live) {
      let byItem = materialCards.get(card.materialId);
      if (!byItem) {
        try {
          const scoped = await createLightCatalogue(db, allowMock).readLightCatalogue({ type: "material", id: card.materialId });
          byItem = new Map(scoped.cards.map(item => [item.itemId, item]));
        } catch (error) {
          if (!(error instanceof LightStudyError) || error.status !== 404) throw error;
          byItem = new Map();
        }
        materialCards.set(card.materialId, byItem);
      }
      live = byItem.get(card.itemId);
    }
    return live?.materialHash === card.materialHash && live.rowIndex === card.rowIndex ? live : null;
  }
  for (const row of rows) {
    const snapshot = remainingSnapshot(row);
    if (!snapshot || resumeByMode[snapshot.mode] && (snapshot.scope.type !== "all" || allResumable[snapshot.mode])) continue;
    let available = false;
    for (const card of snapshot.remaining) {
      const live = await liveSnapshot(card);
      if (!live) continue;
      const prior = progress.get(card.itemId);
      // V1 continuation reprojects versions; V2 must still match its original progress snapshot.
      if (snapshot.legacy ? snapshot.mode === "learn" ? Boolean(prior) : !prior || !(Date.parse(prior.due_at) <= now.getTime())
        : live.progressVersion !== card.progressVersion) continue;
      available = true;
      break;
    }
    if (!available) continue;
    const resume: HomeResume = { id: row.id, scope: snapshot.scope, mode: snapshot.mode, index: row.cursor, total: snapshot.total };
    resumeByMode[snapshot.mode] ??= resume;
    if (snapshot.scope.type === "all") allResumable[snapshot.mode] ??= { id: row.id, index: row.cursor, total: snapshot.total };
  }
  return { resumeByMode, allResumable };
}

/** Only read ports are exposed here; homepage reads neither create sessions nor initiate AI work. */
export function createHomeOverview(database: DatabasePort, options: { enabled: () => boolean; allowMock?: boolean }) {
  return (now = new Date()) => database.read(async db => {
    const { cards, progress, unavailableCount } = await createLightCatalogue(db, options.allowMock).readLightCatalogue({ type: "all" });
    const { resumeByMode, allResumable } = await readHomeResumes(db, cards, progress, now, Boolean(options.allowMock));
    const newCount = cards.filter(card => !progress.has(card.itemId)).length;
    const dueCount = cards.filter(card => Date.parse(progress.get(card.itemId)?.due_at ?? "") <= now.getTime()).length;
    const light: LightOverview = { enabled: options.enabled(), scope: { type: "all" }, newCount, dueCount, totalCount: cards.length,
      unavailableCount, defaultMode: dueCount > 0 ? "review" : "learn", resumable: allResumable };
    // Same lifetime/all-source projection as the expression collections, without adding the two collections together.
    const [{ studiedCount }] = await db.all<{ studiedCount: number }>(sql`
      SELECT COUNT(DISTINCT lp.learning_item_id) AS studiedCount FROM light_study_progress lp
      JOIN practice_material_items mi ON mi.learning_item_id=lp.learning_item_id JOIN practice_materials pm ON pm.id=mi.material_id`);
    return {
      dateLabel: new Intl.DateTimeFormat("zh-CN", { timeZone: HOME_TIME_ZONE, month: "long", day: "numeric", weekday: "long" }).format(now),
      activity: await readHomeActivity(db, now), studiedCount: Number(studiedCount), light, resumeByMode,
    };
  });
}

export const getHomeOverview = createHomeOverview(nodeDatabase, {
  enabled: lightStudyEnabled, allowMock: process.env.NODE_ENV === "test" || process.env.ROASTDUCK_E2E === "1",
});
export type HomeOverview = Awaited<ReturnType<typeof getHomeOverview>>;
