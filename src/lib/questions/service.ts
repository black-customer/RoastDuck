import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { getDbReady } from "@db/client";
import { questionAttempts, questionFavorites, questions, textAnnotations } from "@db/schema";
import type { InteractiveAnnotation, InteractiveText } from "@/lib/learning/types";
import { listQuestionAnswerHistory } from "@/lib/answers/service";
import { personalChunksForQuestion } from "@/lib/answers/processor";
import type { QuestionFilters } from "./schemas";
import { questionActivityCte, questionPrimaryAction, QUESTION_STATE_LABELS, type QuestionState } from "./activity";

export interface QuestionSetSummary {
  id: string;
  nameZh: string;
  year: number;
  startMonth: number;
  endMonth: number;
  questionCount: number;
}

export interface QuestionTopicSummary {
  id: string;
  nameZh: string;
  nameEn: string;
  part: number | null;
  questionCount: number;
}

export interface QuestionListItem {
  id: string;
  part: number;
  textEn: string;
  textZh: string;
  topicId: string | null;
  topicZh: string;
  topicEn: string;
  setNames: string[];
  answered: boolean;
  favorite: boolean;
  sourceCount: number;
  lastPracticedAt: string | null;
  answerCount: number;
  learningUnitCount: number;
  requiredRemaining: number;
  openGapCount: number;
  repeatedGapCount: number;
  reattemptCount: number;
  state: QuestionState;
  stateLabel: string;
  primaryAction: ReturnType<typeof questionPrimaryAction>;
  interactiveQuestion: InteractiveText;
  daysSinceReview: number | null;
  isMastered: boolean;
  fourStepCompletedAt: string | null;
}

export interface QuestionSource {
  slug: string;
  file: string;
  page: number;
  setId: string;
  setName: string;
}

export interface QuestionChunk {
  id: string;
  display: string;
  meaningZh: string;
  ipa: string;
  exampleEn: string;
  exampleZh: string;
}

export interface QuestionDetail extends QuestionListItem {
  sources: QuestionSource[];
  publicChunks: QuestionChunk[];
  answerHistory: Array<{
    id: string;
    status: string;
    inputLanguage: string;
    createdAt: string;
    updatedAt: string;
  }>;
  personalChunks: Array<{ id: string; display: string; meaningZh: string; origin: string }>;
}

function baseConditions(filters: QuestionFilters, options: { omitTopic?: boolean; omitProgress?: boolean } = {}) {
  const conditions: SQL[] = [sql`q.part IN (1,2,3)`];
  if (filters.set) {
    conditions.push(sql`EXISTS (
      SELECT 1 FROM question_set_links qsl
      WHERE qsl.question_id = q.id AND qsl.question_set_id = ${filters.set}
    )`);
  }
  if (filters.part) conditions.push(sql`q.part = ${filters.part}`);
  if (filters.topic && !options.omitTopic) conditions.push(sql`q.topic_id = ${filters.topic}`);
  if (!options.omitProgress) {
    if (filters.status === "answered" || filters.status === "has_history") {
      conditions.push(sql`a.totalAnswerCount > 0`);
    } else if (filters.status === "unanswered") {
      conditions.push(sql`a.totalAnswerCount = 0`);
    } else if (filters.status === "learning_incomplete") {
      conditions.push(sql`a.state IN ('learning_incomplete','learning','ready_to_learn')`);
    } else if (filters.status === "learning_completed") {
      conditions.push(sql`a.state = 'learning_completed'`);
    } else if (filters.status === "mastered") {
      conditions.push(sql`a.isMastered = 1`);
    } else if (filters.status === "has_learning") {
      conditions.push(sql`a.currentUnitCount > 0`);
    } else if (filters.status === "ready_to_learn") {
      conditions.push(sql`a.state IN ('ready_to_learn','learning_incomplete','learning')`);
    } else if (filters.status === "ready_to_reattempt") {
      conditions.push(sql`a.state IN ('ready_to_reattempt','learning_completed')`);
    } else if (filters.status === "reattempted") {
      conditions.push(sql`a.reattemptCount > 0`);
    } else if (filters.status === "repeated_gaps") {
      conditions.push(sql`EXISTS (
        SELECT 1 FROM answer_gaps g JOIN personal_answers pa ON pa.id = g.answer_id
        JOIN gap_clusters gc ON gc.id = g.cluster_id
        WHERE pa.question_id = q.id AND pa.superseded_by_revision_id IS NULL AND gc.occurrence_count > 1 AND g.status = 'open'
          AND g.reviewer_decision IN ('approved','edited')
      )`);
    }
    if (filters.favorite) {
      conditions.push(sql`EXISTS (SELECT 1 FROM question_favorites qf WHERE qf.question_id = q.id)`);
    }
  }
  if (filters.q) {
    const term = `%${filters.q}%`;
    conditions.push(sql`(
      q.text LIKE ${term} COLLATE NOCASE OR q.text_zh LIKE ${term}
      OR t.name_en LIKE ${term} COLLATE NOCASE OR t.name_zh LIKE ${term}
    )`);
  }
  return sql.join(conditions, sql` AND `);
}

function safeJsonArray(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

async function annotationsFor(questionIds: string[]) {
  const map = new Map<string, InteractiveAnnotation[]>();
  if (!questionIds.length) return map;
  const db = await getDbReady();
  const rows = await db
    .select({
      contentId: textAnnotations.contentId,
      id: textAnnotations.id,
      start: textAnnotations.startOffset,
      end: textAnnotations.endOffset,
      surface: textAnnotations.surface,
    })
    .from(textAnnotations)
    .where(and(eq(textAnnotations.contentType, "question"), inArray(textAnnotations.contentId, questionIds)))
    .orderBy(textAnnotations.contentId, textAnnotations.startOffset, sql`${textAnnotations.endOffset} DESC`);
  for (const row of rows) {
    const annotations = map.get(row.contentId) ?? [];
    annotations.push({ id: row.id, start: row.start, end: row.end, surface: row.surface });
    map.set(row.contentId, annotations);
  }
  return map;
}

interface RawQuestionRow {
  id: string;
  part: number;
  textEn: string;
  textZh: string;
  topicId: string | null;
  topicZh: string;
  topicEn: string;
  setNamesJson: string;
  state: QuestionState;
  latestAnswerId: string | null;
  latestAnswerType: string | null;
  answered: number;
  favorite: number;
  sourceCount: number;
  lastPracticedAt: string | null;
  answerCount: number;
  learningUnitCount: number;
  requiredRemaining: number;
  openGapCount: number;
  repeatedGapCount: number;
  reattemptCount: number;
  isMastered: number;
  fourStepCompletedAt: string | null;
  daysSinceReview: number | null;
}

function mapQuestion(row: RawQuestionRow, annotations: Map<string, InteractiveAnnotation[]>): QuestionListItem {
  return {
    id: row.id,
    part: Number(row.part),
    textEn: row.textEn,
    textZh: row.textZh,
    topicId: row.topicId,
    topicZh: row.topicZh,
    topicEn: row.topicEn,
    setNames: safeJsonArray(row.setNamesJson),
    answered: Boolean(row.answered),
    favorite: Boolean(row.favorite),
    sourceCount: Number(row.sourceCount),
    lastPracticedAt: row.lastPracticedAt,
    answerCount: Number(row.answerCount),
    learningUnitCount: Number(row.learningUnitCount || 0),
    requiredRemaining: Number(row.requiredRemaining || 0),
    openGapCount: Number(row.openGapCount),
    repeatedGapCount: Number(row.repeatedGapCount),
    reattemptCount: Number(row.reattemptCount || 0),
    state: row.state,
    stateLabel: QUESTION_STATE_LABELS[row.state],
    primaryAction: questionPrimaryAction(row.id, row.state, row.latestAnswerId, row.latestAnswerType),
    interactiveQuestion: {
      contentType: "question",
      contentId: row.id,
      text: row.textEn,
      annotations: annotations.get(row.id) ?? [],
    },
    daysSinceReview: row.daysSinceReview != null ? Number(row.daysSinceReview) : null,
    isMastered: Boolean(row.isMastered),
    fourStepCompletedAt: row.fourStepCompletedAt ?? null,
  };
}

const questionProjection = sql`
  q.id,
  q.part,
  q.text AS textEn,
  q.text_zh AS textZh,
  q.topic_id AS topicId,
  COALESCE(t.name_zh, '') AS topicZh,
  COALESCE(t.name_en, '') AS topicEn,
  COALESCE((
    SELECT json_group_array(set_name) FROM (
      SELECT DISTINCT qs.name_zh AS set_name
      FROM question_set_links qsl JOIN question_sets qs ON qs.id = qsl.question_set_id
      WHERE qsl.question_id = q.id ORDER BY qs.sort
    )
  ), '[]') AS setNamesJson,
  (a.totalAnswerCount > 0) AS answered,
  EXISTS (SELECT 1 FROM question_favorites qf WHERE qf.question_id = q.id) AS favorite,
  (SELECT COUNT(DISTINCT qsl.source_slug || ':' || qsl.source_page) FROM question_set_links qsl WHERE qsl.question_id = q.id) AS sourceCount,
  (SELECT MAX(qa.created_at) FROM question_attempts qa WHERE qa.question_id = q.id AND qa.status = 'completed') AS lastPracticedAt,
  a.totalAnswerCount AS answerCount,
  a.currentUnitCount AS learningUnitCount,
  a.requiredRemaining,
  a.state,
  a.latestAnswerId,
  a.latestAnswerType,
  a.isMastered,
  a.fourStepCompletedAt,
  a.daysSinceReview,
  (SELECT COUNT(*) FROM answer_gaps g JOIN personal_answers pa ON pa.id = g.answer_id WHERE pa.question_id = q.id AND pa.superseded_by_revision_id IS NULL AND g.status = 'open' AND g.reviewer_decision IN ('approved','edited')) AS openGapCount,
  (SELECT COUNT(*) FROM answer_gaps g JOIN personal_answers pa ON pa.id = g.answer_id LEFT JOIN gap_clusters gc ON gc.id = g.cluster_id WHERE pa.question_id = q.id AND pa.superseded_by_revision_id IS NULL AND g.status = 'open' AND g.reviewer_decision IN ('approved','edited') AND COALESCE(gc.occurrence_count, 1) > 1) AS repeatedGapCount,
  a.reattemptCount`;

export async function listQuestionSets(): Promise<QuestionSetSummary[]> {
  const db = await getDbReady();
  const rows = await db.all<Record<string, unknown>>(sql`
    SELECT qs.id, qs.name_zh AS nameZh, qs.year, qs.start_month AS startMonth, qs.end_month AS endMonth,
      COUNT(DISTINCT qsl.question_id) AS questionCount
    FROM question_sets qs LEFT JOIN question_set_links qsl ON qsl.question_set_id = qs.id
    WHERE qs.status = 'active'
    GROUP BY qs.id ORDER BY qs.sort`);
  return rows.map((row) => ({
    id: String(row.id),
    nameZh: String(row.nameZh),
    year: Number(row.year),
    startMonth: Number(row.startMonth),
    endMonth: Number(row.endMonth),
    questionCount: Number(row.questionCount),
  }));
}

export async function listQuestionTopics(filters: QuestionFilters): Promise<QuestionTopicSummary[]> {
  const db = await getDbReady();
  const where = baseConditions(filters, { omitTopic: true, omitProgress: true });
  const rows = await db.all<Record<string, unknown>>(sql`
    ${questionActivityCte}
    SELECT t.id, t.name_zh AS nameZh, t.name_en AS nameEn, t.ielts_part AS part,
      COUNT(DISTINCT q.id) AS questionCount
    FROM questions q
    JOIN question_activity a ON a.id = q.id
    JOIN topics t ON t.id = q.topic_id
    WHERE ${where}
    GROUP BY t.id HAVING COUNT(DISTINCT q.id) > 0
    ORDER BY q.part, t.sort, t.name_zh, t.name_en`);
  return rows.map((row) => ({
    id: String(row.id),
    nameZh: String(row.nameZh ?? ""),
    nameEn: String(row.nameEn ?? ""),
    part: row.part == null ? null : Number(row.part),
    questionCount: Number(row.questionCount),
  }));
}

export async function listQuestions(filters: QuestionFilters) {
  const db = await getDbReady();
  const where = baseConditions(filters);
  const [{ total }] = await db.all<{ total: number }>(sql`
    ${questionActivityCte}
    SELECT COUNT(*) AS total
    FROM questions q
    JOIN question_activity a ON a.id = q.id
    LEFT JOIN topics t ON t.id = q.topic_id
    WHERE ${where}`);
  const offset = (filters.page - 1) * filters.pageSize;
  let orderByClause: SQL = sql`q.part, t.sort, q.id`;
  if (filters.sortBy === "longest_unreviewed") {
    orderByClause = sql`CASE WHEN a.daysSinceReview IS NULL THEN 1 ELSE 0 END, a.daysSinceReview DESC, q.part, t.sort, q.id`;
  } else if (filters.sortBy === "latest") {
    orderByClause = sql`CASE WHEN a.lastActiveAt IS NULL THEN 1 ELSE 0 END, a.lastActiveAt DESC, q.id`;
  } else if (filters.sortBy === "part") {
    orderByClause = sql`q.part, t.sort, q.id`;
  }

  const rows = await db.all<RawQuestionRow>(sql`
    ${questionActivityCte}
    SELECT ${questionProjection}
    FROM questions q
    JOIN question_activity a ON a.id = q.id
    LEFT JOIN topics t ON t.id = q.topic_id
    WHERE ${where}
    ORDER BY ${orderByClause}
    LIMIT ${filters.pageSize} OFFSET ${offset}`);
  const annotationMap = await annotationsFor(rows.map((row) => row.id));
  return {
    items: rows.map((row) => mapQuestion(row, annotationMap)),
    total: Number(total ?? 0),
    page: filters.page,
    pageSize: filters.pageSize,
    pageCount: Math.max(1, Math.ceil(Number(total ?? 0) / filters.pageSize)),
  };
}

export async function randomQuestion(filters: QuestionFilters): Promise<QuestionListItem | null> {
  const db = await getDbReady();
  const where = baseConditions(filters);
  const rows = await db.all<RawQuestionRow>(sql`
    ${questionActivityCte}
    SELECT ${questionProjection}
    FROM questions q
    JOIN question_activity a ON a.id = q.id
    LEFT JOIN topics t ON t.id = q.topic_id
    WHERE ${where}
      AND q.id NOT IN (
        SELECT question_id FROM question_attempts
        WHERE origin = 'random' AND status = 'viewed'
        ORDER BY created_at DESC LIMIT 20
      )
    ORDER BY
      CASE WHEN a.totalAnswerCount > 0 THEN 1 ELSE 0 END,
      COALESCE((SELECT MAX(qa.created_at) FROM question_attempts qa WHERE qa.question_id = q.id AND qa.status = 'completed'), '') ASC,
      random()
    LIMIT 1`);
  if (!rows[0]) return null;
  const annotationMap = await annotationsFor([rows[0].id]);
  return mapQuestion(rows[0], annotationMap);
}

export async function getQuestionDetail(id: string): Promise<QuestionDetail | null> {
  const db = await getDbReady();
  const rows = await db.all<RawQuestionRow>(sql`
    ${questionActivityCte}
    SELECT ${questionProjection}
    FROM questions q
    JOIN question_activity a ON a.id = q.id
    LEFT JOIN topics t ON t.id = q.topic_id
    WHERE q.id = ${id} AND q.part IN (1,2,3)
    LIMIT 1`);
  if (!rows[0]) return null;
  const [annotationMap, sourceRows, chunkRows, answerHistory, personalChunkRows] = await Promise.all([
    annotationsFor([id]),
    db.all<Record<string, unknown>>(sql`
      SELECT DISTINCT qsl.source_slug AS slug, qsl.source_file AS file, qsl.source_page AS page,
        qs.id AS setId, qs.name_zh AS setName
      FROM question_set_links qsl JOIN question_sets qs ON qs.id = qsl.question_set_id
      WHERE qsl.question_id = ${id}
      ORDER BY qs.sort, qsl.source_slug, qsl.source_page`),
    db.all<Record<string, unknown>>(sql`
      SELECT DISTINCT c.id, c.display_chunk AS display, c.meaning_zh AS meaningZh,
        COALESCE((SELECT cp.ipa FROM chunk_pronunciations cp WHERE cp.chunk_id = c.id ORDER BY cp.is_primary DESC, cp.id LIMIT 1), '') AS ipa,
        COALESCE((SELECT ce.text_en FROM chunk_examples ce WHERE ce.chunk_id = c.id ORDER BY ce.is_source_sentence DESC, ce.sort, ce.id LIMIT 1), '') AS exampleEn,
        COALESCE((SELECT ce.text_zh FROM chunk_examples ce WHERE ce.chunk_id = c.id ORDER BY ce.is_source_sentence DESC, ce.sort, ce.id LIMIT 1), '') AS exampleZh
      FROM chunk_question_links cql JOIN chunks c ON c.id = cql.chunk_id
      WHERE cql.question_id = ${id} AND c.quality_status IN ('approved','edited')
      ORDER BY c.display_chunk LIMIT 24`),
    listQuestionAnswerHistory(id),
    personalChunksForQuestion(id),
  ]);
  return {
    ...mapQuestion(rows[0], annotationMap),
    sources: sourceRows.map((row) => ({
      slug: String(row.slug),
      file: String(row.file),
      page: Number(row.page),
      setId: String(row.setId),
      setName: String(row.setName),
    })),
    publicChunks: chunkRows.map((row) => ({
      id: String(row.id),
      display: String(row.display),
      meaningZh: String(row.meaningZh),
      ipa: String(row.ipa),
      exampleEn: String(row.exampleEn),
      exampleZh: String(row.exampleZh),
    })),
    answerHistory,
    personalChunks: personalChunkRows.map((row) => ({ id: String(row.id), display: String(row.display), meaningZh: String(row.meaningZh), origin: String(row.origin) })),
  };
}

export async function recordQuestionAttempt(input: typeof questionAttempts.$inferInsert) {
  const db = await getDbReady();
  const [question] = await db.select({ id: questions.id }).from(questions).where(eq(questions.id, input.questionId)).limit(1);
  if (!question) return false;
  await db.insert(questionAttempts).values(input).onConflictDoNothing({ target: questionAttempts.id });
  return true;
}

export async function setQuestionFavorite(questionId: string, favorite: boolean) {
  const db = await getDbReady();
  const [question] = await db.select({ id: questions.id }).from(questions).where(eq(questions.id, questionId)).limit(1);
  if (!question) return null;
  if (favorite) {
    await db.insert(questionFavorites).values({ questionId }).onConflictDoNothing({ target: questionFavorites.questionId });
  } else {
    await db.delete(questionFavorites).where(eq(questionFavorites.questionId, questionId));
  }
  return favorite;
}

export async function findSourceFile(sourceSlug: string): Promise<string | null> {
  const db = await getDbReady();
  const rows = await db.all<{ sourceFile: string }>(sql`
    SELECT source_file AS sourceFile FROM question_set_links
    WHERE source_slug = ${sourceSlug} AND source_file != '' LIMIT 1`);
  return rows[0]?.sourceFile ?? null;
}

export async function setQuestionMastery(questionId: string, mastered: boolean) {
  const db = await getDbReady();
  const now = new Date().toISOString();
  await db.run(sql`
    INSERT INTO question_mastery (question_id, mastered, mastery_source, updated_at)
    VALUES (${questionId}, ${mastered ? 1 : 0}, 'manual', ${now})
    ON CONFLICT(question_id) DO UPDATE SET
      mastered = ${mastered ? 1 : 0},
      mastery_source = 'manual',
      updated_at = ${now}
  `);
  return { success: true, questionId, mastered };
}

export async function markQuestionFourStepCompleted(questionId: string) {
  const db = await getDbReady();
  const now = new Date().toISOString();
  await db.run(sql`
    INSERT INTO question_mastery (question_id, four_step_completed_at, last_learned_at, review_count, updated_at)
    VALUES (${questionId}, ${now}, ${now}, 1, ${now})
    ON CONFLICT(question_id) DO UPDATE SET
      four_step_completed_at = ${now},
      last_learned_at = ${now},
      review_count = review_count + 1,
      updated_at = ${now}
  `);
  return { success: true, questionId };
}
