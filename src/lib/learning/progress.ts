/**
 * 学习数据访问层：进度读写、每日队列（Book 与 Daily Queue 严格分离）。
 */
import { eq, inArray, sql } from "drizzle-orm";
import { getDbReady, withDbTransaction } from "@db/client";
import { chunks, chunkExamples, learningProgress, reviewLog } from "@db/schema";
import { getUserSettings } from "@/lib/settings";
import { deriveMastery, isDue, newCard, grade, type Card } from "./fsrs";

export interface Progress {
  chunkId: string;
  card: Card;
  introDone: boolean;
  mastery: string;
  ratingStats: Record<string, { seen: number; correct: number }>;
  skillStats: Record<string, { attempts: number; correct: number; assists: number }>;
  lastOutcome: Record<string, unknown>;
}

interface ProgressRow {
  chunkId: string;
  fsrsJson: string;
  mastery: string;
  introDone: number;
  ratingStatsJson: string;
  skillStatsJson: string;
  lastOutcomeJson: string;
}

function parseProgress(row: ProgressRow): Progress {
  const fsrsJson = JSON.parse(row.fsrsJson) as Partial<Card>;
  return {
    chunkId: row.chunkId,
    card: {
      ...newCard(),
      ...fsrsJson,
      due: new Date(fsrsJson.due ?? Date.now()),
      last_review: fsrsJson.last_review ? new Date(fsrsJson.last_review) : null,
    } as Card,
    introDone: row.introDone === 1,
    mastery: row.mastery ?? "new",
    ratingStats: JSON.parse(row.ratingStatsJson || "{}"),
    skillStats: JSON.parse(row.skillStatsJson || "{}"),
    lastOutcome: JSON.parse(row.lastOutcomeJson || "{}"),
  };
}

export async function getProgress(chunkId: string): Promise<Progress | null> {
  const db = await getDbReady();
  const rows = await db.select().from(learningProgress).where(eq(learningProgress.chunkId, chunkId)).limit(1);
  return rows.length ? parseProgress(rows[0]) : null;
}

export async function getOrCreateProgress(chunkId: string): Promise<Progress> {
  const existing = await getProgress(chunkId);
  if (existing) return existing;
  const db = await getDbReady();
  const card = newCard();
  await db
    .insert(learningProgress)
    .values({
      chunkId,
      fsrsJson: JSON.stringify(card),
      introDone: 0,
      ratingStatsJson: "{}",
      skillStatsJson: "{}",
      lastOutcomeJson: "{}",
    })
    .onConflictDoNothing();
  return (await getProgress(chunkId))!;
}

export interface LearningOutcomeMetrics {
  sessionId: string;
  comprehension: "understood" | "unsure" | "not_understood";
  errors: number;
  assists: number;
  shadowingAttempts: number;
  microphoneMode: "recorded" | "self_assessed";
  skills: Record<string, { attempts: number; correct: number; assists: number }>;
}

/** 整轮结束后唯一允许写入 FSRS 的入口；同一 session/chunk 重放时幂等。 */
export async function applyLearningOutcome(
  chunkId: string,
  rating: "again" | "hard" | "good" | "easy",
  metrics: LearningOutcomeMetrics,
): Promise<{ card: Card; mastery: string }> {
  return withDbTransaction(() => settleLearningOutcome(chunkId, rating, metrics));
}

async function settleLearningOutcome(chunkId: string, rating: 'again' | 'hard' | 'good' | 'easy', metrics: LearningOutcomeMetrics) {
  const db = await getDbReady();
  const alreadyApplied = await db.all<{ id: number }>(sql`
    SELECT id FROM review_log
    WHERE chunk_id = ${chunkId}
      AND training_type = 'learning_round'
      AND json_extract(detail_json, '$.sessionId') = ${metrics.sessionId}
    LIMIT 1`);
  const progress = await getOrCreateProgress(chunkId);
  if (alreadyApplied.length > 0) return { card: progress.card, mastery: progress.mastery };
  const claim = await db.all(sql`INSERT INTO learning_round_settlements (session_id, chunk_id, completed_at)
    VALUES (${metrics.sessionId}, ${chunkId}, ${new Date().toISOString()}) ON CONFLICT DO NOTHING RETURNING session_id`);
  if (!claim.length) return { card: progress.card, mastery: progress.mastery };

  const { card } = grade(progress.card, rating);
  const skillStats = { ...progress.skillStats };
  for (const [skill, delta] of Object.entries(metrics.skills)) {
    const current = skillStats[skill] ?? { attempts: 0, correct: 0, assists: 0 };
    skillStats[skill] = {
      attempts: current.attempts + delta.attempts,
      correct: current.correct + delta.correct,
      assists: current.assists + delta.assists,
    };
  }
  const mastery = deriveMastery(card, true);
  const outcome = { ...metrics, rating, isNew: !progress.introDone, completedAt: new Date().toISOString() };
  await db
    .update(learningProgress)
    .set({
      fsrsJson: JSON.stringify(card),
      mastery,
      introDone: 1,
      skillStatsJson: JSON.stringify(skillStats),
      lastOutcomeJson: JSON.stringify(outcome),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(learningProgress.chunkId, chunkId));
  await db.insert(reviewLog).values({
    chunkId,
    trainingType: "learning_round",
    rating,
    detailJson: JSON.stringify(outcome),
  });
  await db.run(sql`UPDATE question_learning_units SET first_round_completed_at = ${outcome.completedAt}, updated_at = ${outcome.completedAt}
    WHERE chunk_id = ${chunkId} AND status = 'active' AND first_round_completed_at IS NULL`);
  return { card, mastery };
}

/**
 * 今日新学与复习上限改为读 v3 的 `user_settings`（`learning_settings` 已废弃，
 * 只保留字段兼容）。默认值见 docs/PRODUCT.md「设置」。
 */
export async function getSettings() {
  const settings = await getUserSettings();
  return { id: 1, dailyNewTarget: settings.dailyNewTarget, dailyReviewCap: settings.dailyReviewCap, personalNewRatio: settings.personalNewRatio };
}

/** 今日队列：到期复习 + 新学（互不重复）。从未学过的语块（无进度行）也进入新学池。 */
export async function getTodayQueue(): Promise<{ due: string[]; fresh: string[] }> {
  const db = await getDbReady();
  const settings = await getSettings();
  const now = new Date();
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);

  const rows = await db
    .select({
      chunkId: learningProgress.chunkId,
      fsrsJson: learningProgress.fsrsJson,
      mastery: learningProgress.mastery,
      introDone: learningProgress.introDone,
      ratingStatsJson: learningProgress.ratingStatsJson,
      skillStatsJson: learningProgress.skillStatsJson,
      lastOutcomeJson: learningProgress.lastOutcomeJson,
    })
    .from(learningProgress)
    .innerJoin(chunks, eq(chunks.id, learningProgress.chunkId))
    .where(sql`${chunks.qualityStatus} IN ('approved','edited') AND (${chunks.bookId} != 'book_personal_ielts_answers' OR EXISTS (
      SELECT 1 FROM personal_chunk_links pcl JOIN personal_answers pa ON pa.id = pcl.answer_id
      WHERE pcl.chunk_id = ${chunks.id} AND pcl.status = 'active' AND pa.superseded_by_revision_id IS NULL))`);

  const due: string[] = [];
  const startedFresh: string[] = [];
  for (const row of rows) {
    const p = parseProgress(row);
    if (p.card.state !== 0 && isDue(p.card, now)) due.push(p.chunkId);
    else if (p.card.state === 0 && !p.introDone) startedFresh.push(p.chunkId);
  }

  // 从未学过的语块（无进度行）→ 新学池
  const untouched: Array<{ id: string; personal: number }> = [];
  for (const personal of [0, 1]) untouched.push(...await db.all<{ id: string; personal: number }>(sql`
    SELECT c.id, CASE WHEN c.book_id = 'book_personal_ielts_answers' THEN 1 ELSE 0 END AS personal FROM chunks c
    LEFT JOIN learning_progress lp ON lp.chunk_id = c.id
    WHERE lp.chunk_id IS NULL AND c.quality_status IN ('approved','edited')
      AND (CASE WHEN c.book_id = 'book_personal_ielts_answers' THEN 1 ELSE 0 END) = ${personal}
      AND (${personal} = 0 OR EXISTS (SELECT 1 FROM personal_chunk_links pcl JOIN personal_answers pa ON pa.id = pcl.answer_id
        WHERE pcl.chunk_id = c.id AND pcl.status = 'active' AND pa.superseded_by_revision_id IS NULL))
    ORDER BY c.created_at, c.id LIMIT ${settings.dailyNewTarget * 8}`));

  // 仅统计今日尚未复习的到期卡
  const reviewedToday = await db.all<{ chunkId: string; isNew: number; personal: number }>(sql`
    SELECT r.chunk_id AS chunkId, COALESCE(json_extract(r.detail_json, '$.isNew'),
      NOT EXISTS (SELECT 1 FROM review_log old WHERE old.chunk_id = r.chunk_id AND old.id < r.id AND old.training_type = 'learning_round')) AS isNew,
      CASE WHEN c.book_id = 'book_personal_ielts_answers' THEN 1 ELSE 0 END AS personal
    FROM review_log r JOIN chunks c ON c.id = r.chunk_id
    WHERE r.training_type = 'learning_round' AND date(r.trained_at, '+8 hours') = ${today}`);
  const newRemaining = Math.max(0, settings.dailyNewTarget - reviewedToday.filter((row) => row.isNew).length);
  const reviewRemaining = Math.max(0, settings.dailyReviewCap - reviewedToday.filter((row) => !row.isNew).length);
  const reviewedSet = new Set(reviewedToday.map((r) => r.chunkId));
  const dueToday = due.filter((id) => !reviewedSet.has(id)).slice(0, reviewRemaining);
  const startedKinds = startedFresh.length ? await db.select({ id: chunks.id, bookId: chunks.bookId }).from(chunks).where(inArray(chunks.id, startedFresh)) : [];
  const kindMap = new Map(startedKinds.map((item) => [item.id, item.bookId === "book_personal_ielts_answers"]));
  const candidates = [
    ...startedFresh.map((id) => ({ id, personal: kindMap.get(id) ?? false })),
    ...untouched.map((row) => ({ id: row.id, personal: Boolean(row.personal) })),
  ].filter((item, index, all) => !reviewedSet.has(item.id) && all.findIndex((candidate) => candidate.id === item.id) === index);
  const personalTarget = Math.min(newRemaining, Math.max(0, Math.round(settings.dailyNewTarget * settings.personalNewRatio) - reviewedToday.filter((row) => row.isNew && row.personal).length));
  const personal = candidates.filter((item) => item.personal).map((item) => item.id);
  const publicCards = candidates.filter((item) => !item.personal).map((item) => item.id);
  const selectedPersonal = personal.slice(0, personalTarget);
  const selectedPublic = publicCards.slice(0, newRemaining - selectedPersonal.length);
  const shortfall = newRemaining - selectedPersonal.length - selectedPublic.length;
  const freshToday = [...selectedPersonal, ...selectedPublic, ...personal.slice(selectedPersonal.length, selectedPersonal.length + shortfall)];
  return { due: dueToday, fresh: freshToday };
}

export interface ChunkCard {
  id: string;
  display: string;
  unitType: string;
  meaningZh: string;
  englishGloss: string;
  pattern: string | null;
  variants: string[];
  difficulty: string;
  topicName: string | null;
  examples: Array<{ en: string; zh: string }>;
}

export async function getChunksByIds(ids: string[]): Promise<ChunkCard[]> {
  if (ids.length === 0) return [];
  const db = await getDbReady();
  const rows = await db
    .select({
      id: chunks.id,
      display: chunks.displayChunk,
      unitType: chunks.unitType,
      meaningZh: chunks.meaningZh,
      englishGloss: chunks.englishGloss,
      pattern: chunks.pattern,
      variantsJson: chunks.variantsJson,
      difficulty: chunks.difficulty,
    })
    .from(chunks)
    .where(sql`${inArray(chunks.id, ids)} AND ${chunks.qualityStatus} IN ('approved','edited')`);
  const exRows = await db
    .select({ chunkId: chunkExamples.chunkId, en: chunkExamples.textEn, zh: chunkExamples.textZh })
    .from(chunkExamples)
    .where(inArray(chunkExamples.chunkId, ids))
    .orderBy(sql`${chunkExamples.isSourceSentence} DESC`, chunkExamples.sort);
  const exMap = new Map<string, Array<{ en: string; zh: string }>>();
  for (const e of exRows) {
    const list = exMap.get(e.chunkId as string) ?? [];
    if (list.length < 3) list.push({ en: e.en as string, zh: e.zh as string });
    exMap.set(e.chunkId as string, list);
  }
  const byId = new Map(rows.map((r) => [r.id as string, r]));
  return ids
    .filter((id) => byId.has(id))
    .map((id) => {
      const r = byId.get(id)!;
      return {
        id,
        display: r.display as string,
        unitType: r.unitType as string,
        meaningZh: r.meaningZh as string,
        englishGloss: (r.englishGloss as string) || "",
        pattern: (r.pattern as string) || null,
        variants: JSON.parse((r.variantsJson as string) || "[]"),
        difficulty: r.difficulty as string,
        topicName: null,
        examples: exMap.get(id) ?? [],
      };
    });
}

/** 随机干扰项（ Recognition 选项用）。 */
export async function getDistractors(
  excludeId: string,
  pool: string,
  n = 3,
  field: "meaning" | "display" = "meaning",
): Promise<string[]> {
  const db = await getDbReady();
  const rows = await db.all<{ id: string; value: string }>(field === "meaning" ? sql`
    SELECT id, meaning_zh AS value FROM chunks
    WHERE id != ${excludeId} AND quality_status IN ('approved','edited')
    ORDER BY id LIMIT ${n * 8}` : sql`
    SELECT id, display_chunk AS value FROM chunks
    WHERE id != ${excludeId} AND quality_status IN ('approved','edited')
    ORDER BY id LIMIT ${n * 8}`);
  const out: string[] = [];
  for (const r of rows) {
    const m = r.value || "";
    if (m && m !== pool && !out.includes(m)) out.push(m);
    if (out.length >= n) break;
  }
  return out;
}

export async function countStats() {
  const db = await getDbReady();
  const r = await db.all<{
    total: number; approved: number; learned: number; mastered: number;
    due: number; fresh: number; intro_done: number;
  }>(sql`
    SELECT
      (SELECT COUNT(*) FROM chunks WHERE quality_status IN ('approved','edited')) AS total,
      (SELECT COUNT(*) FROM chunks WHERE quality_status IN ('approved','edited')) AS approved,
      (SELECT COUNT(*) FROM learning_progress lp
        JOIN chunks c ON c.id = lp.chunk_id
        WHERE lp.intro_done = 1 AND c.quality_status IN ('approved','edited')) AS learned,
      (SELECT COUNT(*) FROM learning_progress lp
        JOIN chunks c ON c.id = lp.chunk_id
        WHERE lp.mastery = 'mastered' AND c.quality_status IN ('approved','edited')) AS mastered,
      0 AS due, 0 AS fresh, 0 AS intro_done`);
  const queue = await getTodayQueue();
  return {
    total: r[0]?.total ?? 0,
    learned: r[0]?.learned ?? 0,
    mastered: r[0]?.mastered ?? 0,
    dueCount: queue.due.length,
    freshCount: queue.fresh.length,
  };
}
