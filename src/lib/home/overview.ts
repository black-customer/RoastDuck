import { getPracticeOverview } from "@/lib/four-step/overview";
import { listQuestions, randomQuestion } from "@/lib/questions/service";
import { questionFiltersSchema } from "@/lib/questions/schemas";
import { sql } from "drizzle-orm";
import { getDbReady } from "@db/client";
import { lightOverview } from "@/lib/light-study/service";
import { modeSchema,scopeSchema } from "@/lib/light-study/contracts";
import { chooseHomeLightAction } from "./light-action";

export interface HomeSession {
  mode: "learn" | "review";
  scopeType: "daily" | "question";
  scopeId: string | null;
  experienceVersion?: string;
}

export function homeLearningHref(session: HomeSession | null, dueCount: number): string {
  const params = new URLSearchParams({ mode: session?.mode ?? (dueCount > 0 ? "review" : "learn") });
  if (session?.scopeType === "question" && session.scopeId) params.set("question", session.scopeId);
  return `/learn?${params}`;
}

/** 首页是只读概览；不创建会话、不记入 attempt，也不调用 Runtime AI。 */
export async function getHomeOverview(now = new Date()) {
  const [practice, history, question,light] = await Promise.all([
    getPracticeOverview(now),
    listQuestions(questionFiltersSchema.parse({ status: "has_history", pageSize: 12 })),
    randomQuestion(questionFiltersSchema.parse({})),
    lightOverview({type:"all"},now),
  ]);
  const [latest]=await(await getDbReady()).all<{scope_json:string;mode:string}>(sql`SELECT scope_json,mode FROM light_study_sessions WHERE status IN ('active','paused') AND NOT EXISTS(SELECT 1 FROM light_study_successions s WHERE s.legacy_session_id=light_study_sessions.id) ORDER BY julianday(updated_at) DESC,id DESC LIMIT 1`);
  const lightAction=chooseHomeLightAction(light,latest?{scope:scopeSchema.parse(JSON.parse(latest.scope_json)),mode:modeSchema.parse(latest.mode)}:null);
  const materials=await(await getDbReady()).all<{id:string;title:string;status:string;source_type:string;source_id:string;question_id:string|null}>(sql`
    SELECT pm.id,COALESCE(q.text,ft.title,'我的回答') AS title,pm.status,pm.source_type,pm.source_id,pm.question_id
    FROM practice_materials pm LEFT JOIN questions q ON q.id=pm.question_id
    LEFT JOIN free_talk_conversations ft ON pm.source_type='free_talk' AND ft.id=pm.source_id
    WHERE pm.status IN ('pending','queued','processing','generating','reviewing','failed') ORDER BY pm.updated_at DESC,pm.id LIMIT 3`);
  const materialTasks=materials.map(material=>({id:material.id,title:material.title||"我的回答",status:material.status,
    href:material.source_type==="free_talk"?`/free-talk?conversation=${encodeURIComponent(material.source_id)}`:
      material.source_type==="answer"?`/answer-studio/${encodeURIComponent(material.source_id)}`:
      material.question_id?`/questions/${encodeURIComponent(material.question_id)}/attempts/${encodeURIComponent(material.source_id)}`:"/review-content"}));
  const learning = practice.learning[0] ?? null;
  const review = practice.review[0] ?? null;
  return {
    historyCount: history.total, packs: history.items.slice(0, 3), question, practice,light,lightAction,materialTasks,
    hasActiveSession: Boolean(learning?.active || review?.active),
    hasActiveLearnSession: Boolean(learning?.active), hasActiveReviewSession: Boolean(review?.active),
    newGapAvailable: Boolean(learning), newGapHref: learning?.href ?? "/questions",
    dueGapCount: light.dueCount, reviewHref: "/review",
    learningHref: learning?.href ?? "/questions",
    dateLabel: new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "long", day: "numeric", weekday: "long" }).format(now),
  };
}

export type HomeOverview = Awaited<ReturnType<typeof getHomeOverview>>;
