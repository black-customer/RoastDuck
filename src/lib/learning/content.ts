import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDbReady } from "@db/client";
import {
  chunkExamples,
  chunkPronunciations,
  chunks,
  difficultNotes,
  textAnnotations,
} from "@db/schema";
import type { ContextLine, InteractiveAnnotation, InteractiveText } from "./types";
import { getUserSettings } from "@/lib/settings";

export interface LearningContent {
  chunk: {
    id: string;
    display: string;
    meaningZh: string;
    englishGloss: string;
    pattern: string | null;
    unitType: string;
    ipa: string;
    accent: string;
  };
  example: {
    id: string;
    textEn: string;
    textZh: string;
    generated: boolean;
    sourceSentenceId: string | null;
  };
  interactiveExample: InteractiveText;
  context: {
    kind: "common_usage" | "ielts_question";
    settingZh: string;
    relationshipZh: string;
    purposeZh: string;
    accent: string;
    generated: boolean;
    lines: ContextLine[];
    audioText: string;
  };
  recall: {
    settingZh: string;
    relationshipZh: string;
    purposeZh: string;
    promptZh: string;
    targetMeaningZh: string;
  };
}

type ContextRow = {
  scenarioId: string;
  kind: string;
  settingZh: string;
  relationshipZh: string;
  purposeZh: string;
  accent: string;
  generated: number;
  lineId: string;
  speaker: string;
  textEn: string;
  textZh: string;
  target: number;
  lineOrder: number;
  annotationStatus: string;
};

function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 14)}`;
}

export async function getAnnotations(contentType: InteractiveText["contentType"], contentId: string) {
  const db = await getDbReady();
  const rows = await db
    .select({
      id: textAnnotations.id,
      start: textAnnotations.startOffset,
      end: textAnnotations.endOffset,
      surface: textAnnotations.surface,
    })
    .from(textAnnotations)
    .where(and(eq(textAnnotations.contentType, contentType), eq(textAnnotations.contentId, contentId)))
    .orderBy(textAnnotations.startOffset, sql`${textAnnotations.endOffset} DESC`);
  return rows satisfies InteractiveAnnotation[];
}

export async function buildInteractiveText(
  contentType: InteractiveText["contentType"],
  contentId: string,
  text: string,
): Promise<InteractiveText> {
  return { contentType, contentId, text, annotations: await getAnnotations(contentType, contentId) };
}

async function loadApprovedScenario(chunkId: string, questionId?: string | null) {
  const db = await getDbReady();
  const scenarios = await db.all<{
    scenarioId: string;
    kind: string;
    settingZh: string;
    relationshipZh: string;
    purposeZh: string;
    accent: string;
    generated: number;
  }>(sql`
    SELECT s.id AS scenarioId, s.scenario_kind AS kind, s.setting_zh AS settingZh,
      s.relationship_zh AS relationshipZh, s.purpose_zh AS purposeZh, s.accent,
      s.is_generated AS generated
    FROM learning_scenarios s
    WHERE s.chunk_id = ${chunkId} AND s.scenario_kind = 'common_usage'
      AND s.review_decision = 'approved'
      AND (${questionId ?? null} IS NULL OR s.question_id = ${questionId ?? null})
    ORDER BY s.updated_at DESC, s.id LIMIT 1`);
  const scenario = scenarios[0];
  if (!scenario) return null;
  const rows = await db.all<ContextRow>(sql`
    SELECT ${scenario.scenarioId} AS scenarioId, ${scenario.kind} AS kind,
      ${scenario.settingZh} AS settingZh, ${scenario.relationshipZh} AS relationshipZh,
      ${scenario.purposeZh} AS purposeZh, ${scenario.accent} AS accent,
      ${scenario.generated} AS generated, l.id AS lineId, l.speaker, l.text_en AS textEn,
      l.text_zh AS textZh, l.is_target AS target, l.line_order AS lineOrder,
      l.annotation_status AS annotationStatus
    FROM learning_scenario_lines l WHERE l.scenario_id = ${scenario.scenarioId}
    ORDER BY l.line_order`);
  if (rows.length < 2 || rows.length > 4 || rows.some((row) => row.annotationStatus !== "complete")) return null;
  return {
    kind: "common_usage" as const,
    settingZh: rows[0].settingZh,
    relationshipZh: rows[0].relationshipZh,
    purposeZh: rows[0].purposeZh,
    accent: rows[0].accent,
    generated: rows[0].generated === 1,
    lines: await Promise.all(rows.map(async (row) => ({
      id: row.lineId,
      speaker: row.speaker,
      text: await buildInteractiveText("scenario_line", row.lineId, row.textEn),
      translationZh: row.textZh,
      target: row.target === 1,
    }))),
    audioText: rows.map((row) => row.textEn).join("\n"),
  };
}

async function loadQuestionContext(
  chunkId: string,
  example: { id: string; textEn: string; textZh: string; generated: number },
  questionId?: string | null,
) {
  const db = await getDbReady();
  const rows = await db.all<{ id: string; textEn: string; textZh: string; part: number; topicZh: string | null }>(sql`
    SELECT q.id, q.text AS textEn, q.text_zh AS textZh, q.part, t.name_zh AS topicZh
    FROM chunk_question_links l JOIN questions q ON q.id = l.question_id
    LEFT JOIN topics t ON t.id = q.topic_id
    WHERE l.chunk_id = ${chunkId}
    ORDER BY CASE WHEN q.id = ${questionId ?? ""} THEN 0 ELSE 1 END, q.part, q.id LIMIT 1`);
  const question = rows[0];
  if (!question) return null;
  const questionText = await buildInteractiveText("question", question.id, question.textEn);
  const exampleText = await buildInteractiveText("example", example.id, example.textEn);
  return {
    kind: "ielts_question" as const,
    settingZh: `IELTS Speaking Part ${question.part} 回答现场`,
    relationshipZh: "考官与考生",
    purposeZh: question.topicZh ? `回答“${question.topicZh}”话题并自然表达观点` : "自然回答当前口语题目",
    // IELTS 题库与 AI 生成示例统一使用自然美式英语；Podcast 场景由独立 scenario 保留来源口音。
    accent: "en-US",
    generated: example.generated === 1,
    lines: [
      { id: question.id, speaker: "Examiner", text: questionText, translationZh: question.textZh, target: false },
      { id: example.id, speaker: "Candidate", text: exampleText, translationZh: example.textZh, target: true },
    ] satisfies ContextLine[],
    audioText: `${question.textEn}\n${example.textEn}`,
    question,
  };
}

export async function loadLearningContent(chunkId: string, questionId?: string | null): Promise<LearningContent | null> {
  const db = await getDbReady();
  const [chunk] = await db
    .select({
      id: chunks.id,
      display: chunks.displayChunk,
      meaningZh: chunks.meaningZh,
      englishGloss: chunks.englishGloss,
      pattern: chunks.pattern,
      unitType: chunks.unitType,
    })
    .from(chunks)
    .where(sql`${chunks.id} = ${chunkId} AND ${chunks.qualityStatus} IN ('approved','edited')
      AND (${chunks.bookId} != 'book_personal_ielts_answers' OR EXISTS (
        SELECT 1 FROM personal_chunk_links pcl JOIN personal_answers pa ON pa.id = pcl.answer_id
        WHERE pcl.chunk_id = ${chunks.id} AND pcl.status = 'active' AND pa.superseded_by_revision_id IS NULL))`)
    .limit(1);
  if (!chunk) return null;

  const [example] = await db
    .select({
      id: chunkExamples.id,
      textEn: chunkExamples.textEn,
      textZh: chunkExamples.textZh,
      generated: chunkExamples.generated,
      sourceSentenceId: chunkExamples.sourceSentenceId,
    })
    .from(chunkExamples)
    .where(eq(chunkExamples.chunkId, chunkId))
    .orderBy(sql`${chunkExamples.isSourceSentence} DESC`, chunkExamples.sort, chunkExamples.id)
    .limit(1);
  if (!example) return null;

  const [pronunciation] = await db
    .select({ ipa: chunkPronunciations.ipa, accent: chunkPronunciations.accent })
    .from(chunkPronunciations)
    .where(eq(chunkPronunciations.chunkId, chunkId))
    .orderBy(sql`${chunkPronunciations.isPrimary} DESC`, chunkPronunciations.id)
    .limit(1);
  const fallbackAccent = pronunciation ? "en-GB" : (await getUserSettings()).defaultAccent;
  const accent = pronunciation?.accent ?? fallbackAccent;
  const scenario = await loadApprovedScenario(chunkId, questionId);
  const questionContext = scenario ? null : await loadQuestionContext(chunkId, example, questionId);
  const context = scenario ?? questionContext;
  if (!context || context.lines.length < 2 || context.lines.length > 4) return null;
  const targetLine = context.lines.find((line) => line.target) ?? context.lines.at(-1)!;

  return {
    chunk: {
      ...chunk,
      ipa: pronunciation?.ipa ?? "",
      accent,
    },
    example: {
      ...example,
      generated: example.generated === 1,
    },
    interactiveExample: await buildInteractiveText("example", example.id, example.textEn),
    context: {
      kind: context.kind,
      settingZh: context.settingZh,
      relationshipZh: context.relationshipZh,
      purposeZh: context.purposeZh,
      accent: context.accent,
      generated: context.generated,
      lines: context.lines,
      audioText: context.audioText,
    },
    recall: {
      settingZh: context.settingZh,
      relationshipZh: context.relationshipZh,
      purposeZh: context.purposeZh,
      promptZh: questionContext?.question.textZh
        ? `当考官问你“${questionContext.question.textZh}”时，用自己的话表达同一意思。`
        : `当你${context.purposeZh}时，用自己的话说出刚才的核心表达。`,
      targetMeaningZh: targetLine.translationZh || chunk.meaningZh,
    },
  };
}

export interface DifficultyNoteInput {
  chunkId?: string | null;
  annotationId?: string | null;
  surface: string;
  meaningZh?: string;
  sourceType: "chunk" | "annotation" | "practice";
  sourceId: string;
  trigger: string;
}

export async function upsertDifficultyNote(input: DifficultyNoteInput) {
  const db = await getDbReady();
  const id = stableId("note", input.sourceType, input.sourceId, input.surface.toLowerCase());
  const now = new Date().toISOString();
  await db
    .insert(difficultNotes)
    .values({
      id,
      chunkId: input.chunkId ?? null,
      annotationId: input.annotationId ?? null,
      surface: input.surface,
      meaningZh: input.meaningZh ?? "",
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      lastTrigger: input.trigger,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [difficultNotes.sourceType, difficultNotes.sourceId, difficultNotes.surface],
      set: {
        meaningZh: input.meaningZh ?? "",
        chunkId: input.chunkId ?? null,
        annotationId: input.annotationId ?? null,
        status: "open",
        lastTrigger: input.trigger,
        triggerCount: sql`${difficultNotes.triggerCount} + 1`,
        updatedAt: now,
      },
    });
  const [note] = await db.select().from(difficultNotes).where(eq(difficultNotes.id, id)).limit(1);
  return note;
}

export async function openLookup(annotationId: string) {
  const db = await getDbReady();
  const rows = await db.all<{
    id: string;
    surface: string;
    meaningZh: string;
    annotationIpa: string | null;
    accent: string;
    lexemeId: string | null;
    chunkId: string | null;
    lexemeLemma: string | null;
    lexemeSource: string | null;
    chunkDisplay: string | null;
    chunkMeaning: string | null;
    chunkIpa: string | null;
  }>(sql`
    SELECT a.id, a.surface, a.meaning_zh AS meaningZh, a.ipa AS annotationIpa, a.accent,
      a.lexeme_id AS lexemeId, a.chunk_id AS chunkId, l.lemma AS lexemeLemma, l.source AS lexemeSource,
      c.display_chunk AS chunkDisplay, c.meaning_zh AS chunkMeaning,
      (SELECT p.ipa FROM chunk_pronunciations p WHERE p.chunk_id = a.chunk_id ORDER BY p.is_primary DESC LIMIT 1) AS chunkIpa
    FROM text_annotations a
    LEFT JOIN lexemes l ON l.id = a.lexeme_id
    LEFT JOIN chunks c ON c.id = a.chunk_id
    WHERE a.id = ${annotationId} LIMIT 1`);
  const item = rows[0];
  if (!item) return null;
  const meaningZh = item.chunkMeaning || item.meaningZh;
  // 查询是纯读取行为：GET 请求不得产生数据库副作用（刷新、预取、Strict Mode 双发都会污染难点列表）。
  // 只回读已存在的笔记，让小卡能显示「已在难点中」，创建必须由用户显式点击触发。
  const [existingNote] = await db
    .select()
    .from(difficultNotes)
    .where(and(eq(difficultNotes.sourceType, "annotation"), eq(difficultNotes.sourceId, item.id)))
    .limit(1);
  return {
    id: item.id,
    surface: item.surface,
    display: item.chunkDisplay || item.surface,
    meaningZh,
    ipa: item.chunkIpa || item.annotationIpa || "",
    accent: item.accent,
    lemma: item.lexemeLemma,
    source: item.lexemeSource || (item.chunkId ? "项目 Chunk" : "项目词典"),
    kind: item.chunkId ? "chunk" : "lexeme",
    noteId: existingNote?.id ?? null,
    userRemark: existingNote?.userRemark ?? "",
  };
}

/** 用户显式点击「加入难点」时创建笔记；已存在则原样返回，不重复计数。 */
export async function createDifficultyNoteFromAnnotation(annotationId: string, trigger = "user_added") {
  const rows = await dbAnnotationForNote(annotationId);
  if (!rows) return null;
  if (rows.existing) return rows.existing;
  return upsertDifficultyNote({
    chunkId: rows.chunkId,
    annotationId: rows.id,
    surface: rows.surface,
    meaningZh: rows.meaningZh,
    sourceType: "annotation",
    sourceId: rows.id,
    trigger,
  });
}

async function dbAnnotationForNote(annotationId: string) {
  const db = await getDbReady();
  const rows = await db.all<{
    id: string;
    surface: string;
    meaningZh: string;
    chunkId: string | null;
    chunkMeaning: string | null;
  }>(sql`
    SELECT a.id, a.surface, a.meaning_zh AS meaningZh, a.chunk_id AS chunkId,
           c.meaning_zh AS chunkMeaning
    FROM text_annotations a
    LEFT JOIN chunks c ON c.id = a.chunk_id
    WHERE a.id = ${annotationId} LIMIT 1`);
  const item = rows[0];
  if (!item) return null;
  const [existing] = await db
    .select()
    .from(difficultNotes)
    .where(and(eq(difficultNotes.sourceType, "annotation"), eq(difficultNotes.sourceId, item.id)))
    .limit(1);
  return {
    id: item.id,
    surface: item.surface,
    chunkId: item.chunkId,
    meaningZh: item.chunkMeaning || item.meaningZh,
    existing: existing ?? null,
  };
}

export async function getExampleContext(exampleId: string) {
  const db = await getDbReady();
  const [example] = await db.select().from(chunkExamples).where(eq(chunkExamples.id, exampleId)).limit(1);
  if (!example) return null;
  if (example.contextType === "personal_answer") {
    const links = await db.all<Record<string, unknown>>(sql`
      SELECT pa.id AS answerId, pa.question_id AS questionId, q.text AS questionEn, q.text_zh AS questionZh
      FROM personal_chunk_links pcl
      JOIN personal_answers pa ON pa.id = pcl.answer_id
      JOIN questions q ON q.id = pa.question_id
      WHERE pcl.chunk_id = ${example.chunkId} AND pcl.status = 'active' AND pa.superseded_by_revision_id IS NULL
      ORDER BY pcl.created_at DESC LIMIT 1`);
    const link = links[0];
    return {
      kind: "personal_answer" as const,
      generated: false,
      label: "我的雅思答案",
      answerId: link ? String(link.answerId) : null,
      questionId: link ? String(link.questionId) : null,
      questionEn: link ? String(link.questionEn) : "",
      questionZh: link ? String(link.questionZh ?? "") : "",
      sentenceEn: example.textEn,
      sentenceZh: example.textZh,
    };
  }
  if (example.sourceSentenceId) {
    const currentRows = await db.all<{
      id: string;
      bookId: string;
      episodeOrFile: string;
      seq: number;
      text: string;
      textZh: string;
    }>(sql`
      SELECT id, book_id AS bookId, episode_or_file AS episodeOrFile, seq, text, text_zh AS textZh
      FROM source_sentences WHERE id = ${example.sourceSentenceId} LIMIT 1`);
    const current = currentRows[0];
    if (!current) return null;
    const neighbors = await db.all<{ id: string; seq: number; text: string; textZh: string }>(sql`
      SELECT id, seq, text, text_zh AS textZh FROM source_sentences
      WHERE book_id = ${current.bookId} AND episode_or_file = ${current.episodeOrFile}
        AND seq BETWEEN ${current.seq - 2} AND ${current.seq + 2}
      ORDER BY seq`);
    return {
      kind: "source_neighbors" as const,
      generated: false,
      source: current.episodeOrFile,
      currentSentenceId: current.id,
      sentences: await Promise.all(
        neighbors.map(async (row) => ({
          ...row,
          interactive: await buildInteractiveText("sentence", row.id, row.text),
        })),
      ),
    };
  }

  const topics = await db.all<{ id: string; nameZh: string; nameEn: string }>(sql`
    SELECT DISTINCT t.id, t.name_zh AS nameZh, t.name_en AS nameEn
    FROM chunk_topic_links l JOIN topics t ON t.id = l.topic_id
    WHERE l.chunk_id = ${example.chunkId} ORDER BY l.is_primary DESC, t.id`);
  const questions = await db.all<{
    id: string;
    text: string;
    textZh: string;
    part: number;
    relation: string;
    answerDimensionId: string;
  }>(sql`
    SELECT q.id, q.text, q.text_zh AS textZh, q.part, l.relation, l.answer_dimension_id AS answerDimensionId
    FROM chunk_question_links l JOIN questions q ON q.id = l.question_id
    WHERE l.chunk_id = ${example.chunkId} ORDER BY q.part, q.id`);
  return {
    kind: "ielts_association" as const,
    generated: true,
    label: "生成例句",
    topics,
    questions: await Promise.all(
      questions.map(async (question) => ({
        ...question,
        interactive: await buildInteractiveText("question", question.id, question.text),
      })),
    ),
  };
}

export async function listNotes(chunkIds?: string[]) {
  const db = await getDbReady();
  if (chunkIds?.length) {
    return db.select().from(difficultNotes).where(inArray(difficultNotes.chunkId, chunkIds)).orderBy(sql`${difficultNotes.updatedAt} DESC`);
  }
  return db.select().from(difficultNotes).orderBy(sql`${difficultNotes.updatedAt} DESC`).limit(100);
}
