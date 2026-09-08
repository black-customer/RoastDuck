import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getDbReady, withDbTransaction } from "@db/client";
import { learningEvents, learningSessions } from "@db/schema";
import { getUserSettings } from "@/lib/settings";
import { loadLearningContent, upsertDifficultyNote, type LearningContent } from "./content";
import { applyLearningOutcome, getDistractors, getTodayQueue, type LearningOutcomeMetrics } from "./progress";
import type {
  ComprehensionRating,
  LearningEvent,
  LearningSessionView,
  LearningStep,
  PracticeKind,
  PracticeStep,
  SessionMeta,
} from "./types";
import { LearningSessionError } from "./errors";
import { applyRetrievalSessionEvent, createCompanionThreadForQuestion, toRetrievalView } from "./retrieval-service";

type SessionStepName =
  | "context_audio_input"
  | "comprehension_rating"
  | "transcript_replay"
  | "chunk_reveal"
  | "shadowing"
  | "contextual_recall"
  | "guided_practice"
  | "outcome"
  | "scheduled";

interface SkillDelta {
  attempts: number;
  correct: number;
  assists: number;
}

interface InternalPractice {
  id: string;
  kind: PracticeKind;
  title: string;
  instruction: string;
  promptText: string | null;
  promptContentType: "example" | null;
  promptContentId: string | null;
  promptZh: string | null;
  options: Array<{ id: string; label: string }>;
  tiles: Array<{ id: string; label: string }>;
  audioText: string | null;
  correctAnswer: string;
  correctOptionId: string | null;
}

interface SessionState {
  contextPlayback: "played" | "unavailable" | null;
  comprehension: ComprehensionRating | null;
  practicePlan: InternalPractice[];
  practiceIndex: number;
  attempts: Record<string, number>;
  errors: number;
  assists: number;
  feedback: { practiceId: string; message: string; expectedHint: string | null } | null;
  shadowingAttempts: number;
  contextualRecallAttempts: number;
  microphoneMode: "recorded" | "self_assessed";
  microphoneFallbackReason: string | null;
  contextualRecallMode: "recorded" | "self_assessed";
  contextualRecallFallbackReason: string | null;
  skills: Record<string, SkillDelta>;
  outcomeRating: "again" | "hard" | "good" | "easy" | null;
}

const internalPracticeSchema = z.object({
  id: z.string(),
  kind: z.enum([
    "meaning_recognition",
    "listening_discrimination",
    "chunk_reconstruction",
    "sentence_reconstruction",
    "cloze",
    "translation_reconstruction",
  ]),
  title: z.string(),
  instruction: z.string(),
  promptText: z.string().nullable(),
  promptContentType: z.literal("example").nullable(),
  promptContentId: z.string().nullable(),
  promptZh: z.string().nullable(),
  options: z.array(z.object({ id: z.string(), label: z.string() })),
  tiles: z.array(z.object({ id: z.string(), label: z.string() })),
  audioText: z.string().nullable(),
  correctAnswer: z.string(),
  correctOptionId: z.string().nullable(),
});

const stateSchema = z.object({
  contextPlayback: z.enum(["played", "unavailable"]).nullable().default(null),
  comprehension: z.enum(["understood", "unsure", "not_understood"]).nullable().default(null),
  practicePlan: z.array(internalPracticeSchema).default([]),
  practiceIndex: z.number().int().min(0).default(0),
  attempts: z.record(z.string(), z.number().int().min(0)).default({}),
  errors: z.number().int().min(0).default(0),
  assists: z.number().int().min(0).default(0),
  feedback: z
    .object({ practiceId: z.string(), message: z.string(), expectedHint: z.string().nullable() })
    .nullable()
    .default(null),
  shadowingAttempts: z.number().int().min(0).default(0),
  contextualRecallAttempts: z.number().int().min(0).default(0),
  microphoneMode: z.enum(["recorded", "self_assessed"]).default("self_assessed"),
  microphoneFallbackReason: z.string().nullable().default(null),
  contextualRecallMode: z.enum(["recorded", "self_assessed"]).default("self_assessed"),
  contextualRecallFallbackReason: z.string().nullable().default(null),
  skills: z.record(
    z.string(),
    z.object({ attempts: z.number().int(), correct: z.number().int(), assists: z.number().int() }),
  ).default({}),
  outcomeRating: z.enum(["again", "hard", "good", "easy"]).nullable().default(null),
});

type SessionRow = typeof learningSessions.$inferSelect;

export { LearningSessionError } from "./errors";

function emptyState(): SessionState {
  return stateSchema.parse({});
}

function parseState(value: string): SessionState {
  return stateSchema.parse(JSON.parse(value || "{}"));
}

function todayInShanghai(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 12)}`;
}

function normalizeAnswer(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[“”‘’]/g, "'")
    .replace(/[^a-z0-9'\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function deterministicOrder<T>(values: T[], seed: string): T[] {
  return [...values]
    .map((value, index) => ({ value, hash: createHash("sha1").update(`${seed}|${index}|${JSON.stringify(value)}`).digest("hex") }))
    .sort((a, b) => a.hash.localeCompare(b.hash))
    .map((item) => item.value);
}

function skillForPractice(kind: PracticeKind): string {
  if (kind === "meaning_recognition" || kind === "listening_discrimination") return "understanding";
  if (kind === "translation_reconstruction") return "translation";
  return "reconstruction";
}

function updateSkill(state: SessionState, skill: string, delta: Partial<SkillDelta>): void {
  const current = state.skills[skill] ?? { attempts: 0, correct: 0, assists: 0 };
  state.skills[skill] = {
    attempts: current.attempts + (delta.attempts ?? 0),
    correct: current.correct + (delta.correct ?? 0),
    assists: current.assists + (delta.assists ?? 0),
  };
}

async function buildPracticePlan(content: LearningContent, rating: ComprehensionRating): Promise<InternalPractice[]> {
  const meaningDistractors = await getDistractors(content.chunk.id, content.chunk.meaningZh, 3, "meaning");
  const meaningOptions = deterministicOrder(
    [content.chunk.meaningZh, ...meaningDistractors].map((label) => ({
      id: stableId("opt", content.chunk.id, "meaning", label),
      label,
    })),
    `${content.chunk.id}|meaning`,
  );
  const meaningCorrectId = meaningOptions.find((option) => option.label === content.chunk.meaningZh)?.id ?? null;
  const meaning: InternalPractice = {
    id: stableId("practice", content.chunk.id, "meaning"),
    kind: "meaning_recognition",
    title: "先确认意思",
    instruction: "选择这段表达在原句中的意思。",
    promptText: content.example.textEn,
    promptContentType: "example",
    promptContentId: content.example.id,
    promptZh: null,
    options: meaningOptions,
    tiles: [],
    audioText: null,
    correctAnswer: content.chunk.meaningZh,
    correctOptionId: meaningCorrectId,
  };

  const words = content.chunk.display.split(/\s+/).filter(Boolean);
  const reconstruction: InternalPractice = {
    id: stableId("practice", content.chunk.id, "chunk_reconstruction"),
    kind: "chunk_reconstruction",
    title: "把 Chunk 拼回来",
    instruction: "按正确顺序组合刚学的表达。",
    promptText: null,
    promptContentType: null,
    promptContentId: null,
    promptZh: content.chunk.meaningZh,
    options: [],
    tiles: deterministicOrder(
      words.map((label, index) => ({ id: stableId("tile", content.chunk.id, String(index), label), label })),
      `${content.chunk.id}|tiles`,
    ),
    audioText: null,
    correctAnswer: content.chunk.display,
    correctOptionId: null,
  };

  const translationAnswer = content.example.textZh.trim() ? content.example.textEn : content.chunk.display;
  const translationPrompt = content.example.textZh.trim() || content.chunk.meaningZh;
  const translationWords = translationAnswer.split(/\s+/).filter(Boolean);
  const translation: InternalPractice = {
    id: stableId("practice", content.chunk.id, "translation"),
    kind: "translation_reconstruction",
    title: "从中文提取英文",
    instruction: "根据中文提示重构英文；大小写和句末标点不影响判分。",
    promptText: null,
    promptContentType: null,
    promptContentId: null,
    promptZh: translationPrompt,
    options: [],
    tiles: deterministicOrder(
      translationWords.map((label, index) => ({ id: stableId("tile", content.chunk.id, "translation", String(index), label), label })),
      `${content.chunk.id}|translation`,
    ),
    audioText: null,
    correctAnswer: translationAnswer,
    correctOptionId: null,
  };

  if (rating === "understood") return [reconstruction];
  if (rating === "unsure") return [meaning, reconstruction];
  return [meaning, reconstruction, translation];
}

function deriveOutcome(row: SessionRow, state: SessionState): "again" | "hard" | "good" | "easy" {
  if (state.errors >= 3 || (state.comprehension === "not_understood" && state.assists >= 2)) return "again";
  if (state.comprehension !== "understood" || state.errors > 0 || state.assists > 0 || state.microphoneMode === "self_assessed") {
    return "hard";
  }
  if (row.mode === "review" && state.shadowingAttempts >= 1) return "easy";
  return "good";
}

function outcomeCopy(rating: "again" | "hard" | "good" | "easy") {
  const copies = {
    again: { label: "需要尽快再见", message: "你已经当场改对了；系统会把它放进更近的复习队列。" },
    hard: { label: "已完成，但需要巩固", message: "这轮用了提示或重试，系统会安排更密集的复习。" },
    good: { label: "掌握得不错", message: "你完成了输入、模仿和提取练习，接下来交给复习调度。" },
    easy: { label: "提取很顺畅", message: "本轮没有错误或提示，复习间隔会适当拉长。" },
  } as const;
  return copies[rating];
}

function meta(row: SessionRow, queue: string[]): SessionMeta {
  return {
    sessionId: row.id,
    stepVersion: row.stepVersion,
    current: Math.min(row.currentIndex + 1, queue.length),
    total: queue.length,
    remaining: Math.max(0, queue.length - row.currentIndex - 1),
  };
}

async function buildStep(row: SessionRow): Promise<LearningStep> {
  const queue = z.array(z.string()).parse(JSON.parse(row.queueJson));
  if (row.status === "completed" || row.currentIndex >= queue.length) {
    return {
      type: "complete",
      sessionId: row.id,
      total: queue.length,
      completed: Math.min(row.currentIndex, queue.length),
      message: "今天的这一组已经完成。",
    };
  }
  const content = await loadLearningContent(queue[row.currentIndex], row.scopeType === "question" ? row.scopeId : null);
  if (!content) throw new LearningSessionError("当前学习内容不存在或尚未通过发布审核", 409, "content_unavailable");
  const state = parseState(row.stateJson);
  const settings = await getUserSettings();
  const common = meta(row, queue);

  const context = {
    kind: content.context.kind,
    settingZh: content.context.settingZh,
    relationshipZh: content.context.relationshipZh,
    purposeZh: content.context.purposeZh,
    accent: content.context.accent,
    generated: content.context.generated,
    lines: content.context.lines,
  };
  const audioUrl = `/api/learning/sessions/${encodeURIComponent(row.id)}/audio?stepVersion=${row.stepVersion}`;
  const comprehensionOptions = [
    { value: "understood" as const, label: "理解" as const },
    { value: "unsure" as const, label: "有点懵" as const },
    { value: "not_understood" as const, label: "没听懂" as const },
  ];

  if (row.step === "context_audio_input") {
    return {
      ...common,
      type: "context_audio_input",
      contextKind: content.context.kind,
      audioUrl,
      accent: content.context.accent,
      autoPlay: settings.autoPlay,
      lineCount: content.context.lines.length,
    };
  }
  if (row.step === "comprehension_rating") {
    return {
      ...common,
      type: "comprehension_rating",
      playback: state.contextPlayback ?? "unavailable",
      comprehensionOptions,
    };
  }
  if (row.step === "transcript_replay") {
    if (!state.comprehension) throw new LearningSessionError("揭示页缺少理解诊断", 500, "corrupt_session");
    return {
      ...common,
      type: "transcript_replay",
      comprehension: state.comprehension,
      context,
      audioUrl,
      support: {
        slowReplay: state.comprehension === "not_understood",
        breakdown: state.comprehension !== "understood",
      },
    };
  }
  if (row.step === "chunk_reveal") {
    if (!state.comprehension) throw new LearningSessionError("Chunk 揭示页缺少理解诊断", 500, "corrupt_session");
    return {
      ...common,
      type: "chunk_reveal",
      comprehension: state.comprehension,
      context,
      chunk: content.chunk,
      example: {
        ...content.interactiveExample,
        translationZh: content.example.textZh,
        contextId: content.example.id,
        generated: content.example.generated,
      },
      support: {
        slowReplay: state.comprehension === "not_understood",
        breakdown: state.comprehension !== "understood",
        automaticNote: settings.autoCollectDifficulties && state.comprehension !== "understood",
      },
    };
  }
  if (row.step === "shadowing") {
    const targetLine = content.context.lines.find((line) => line.target) ?? content.context.lines.at(-1);
    if (!targetLine) throw new LearningSessionError("语境缺少可模仿目标行", 500, "corrupt_content");
    return {
      ...common,
      type: "shadowing",
      targetLine,
      accent: content.context.accent,
      instructions: ["先听原音", "录下自己的模仿", "回放对比后选择重录或继续"],
      microphoneFallbackAllowed: true,
    };
  }
  if (row.step === "contextual_recall") {
    return {
      ...common,
      type: "contextual_recall",
      scene: content.recall,
      accent: content.context.accent,
      microphoneFallbackAllowed: true,
    };
  }
  if (row.step === "guided_practice") {
    const task = state.practicePlan[state.practiceIndex];
    if (!task) throw new LearningSessionError("练习计划损坏", 500, "corrupt_session");
    const prompt = task.promptText && task.promptContentType && task.promptContentId
      ? { ...content.interactiveExample, text: task.promptText }
      : null;
    const practice: PracticeStep["practice"] = {
      id: task.id,
      kind: task.kind,
      title: task.title,
      instruction: task.instruction,
      prompt,
      promptZh: task.promptZh,
      options: task.options,
      tiles: task.tiles,
      audioText: task.audioText,
      attempt: state.attempts[task.id] ?? 0,
      feedback:
        state.feedback?.practiceId === task.id
          ? { status: "incorrect", message: state.feedback.message, expectedHint: state.feedback.expectedHint }
          : null,
    };
    return {
      ...common,
      type: "guided_practice",
      practice,
      practiceNumber: state.practiceIndex + 1,
      practiceTotal: state.practicePlan.length,
    };
  }
  if (row.step === "outcome") {
    if (!state.outcomeRating) throw new LearningSessionError("结果页缺少结算等级", 500, "corrupt_session");
    const copy = outcomeCopy(state.outcomeRating);
    return {
      ...common,
      type: "outcome",
      result: {
        rating: state.outcomeRating,
        label: copy.label,
        message: copy.message,
        errors: state.errors,
        assists: state.assists,
        shadowingAttempts: state.shadowingAttempts,
      },
    };
  }
  if (row.step === "scheduled") {
    if (!state.outcomeRating) throw new LearningSessionError("调度页缺少结算等级", 500, "corrupt_session");
    const copy = outcomeCopy(state.outcomeRating);
    return {
      ...common,
      type: "scheduled",
      result: {
        rating: state.outcomeRating,
        label: copy.label,
        message: copy.message,
        errors: state.errors,
        assists: state.assists,
        shadowingAttempts: state.shadowingAttempts,
      },
      nextAction: row.currentIndex + 1 < queue.length ? "next_item" : "complete_session",
    };
  }
  throw new LearningSessionError(`未知学习步骤：${row.step}`, 500, "corrupt_session");
}

async function loadSession(sessionId: string): Promise<SessionRow> {
  const db = await getDbReady();
  let [row] = await db.select().from(learningSessions).where(eq(learningSessions.id, sessionId)).limit(1);
  if (!row) throw new LearningSessionError("学习会话不存在", 404, "session_not_found");
  if (row.status === "materials_removed") throw new LearningSessionError("材料已移除，请从题目或对话开始新的强化练习", 410, "materials_removed");
  if (row.status === "active" && !["context_audio_v2", "gap_retrieval_v3"].includes(row.experienceVersion)) {
    const legacyStepMap: Record<string, SessionStepName> = {
      sentence_input: "context_audio_input",
      reveal: "transcript_replay",
      shadowing: "shadowing",
      practice: "guided_practice",
      outcome: "outcome",
    };
    const nextStep = legacyStepMap[row.step] ?? "context_audio_input";
    const now = new Date().toISOString();
    await db.update(learningSessions).set({
      step: nextStep,
      experienceVersion: "context_audio_v2",
      stepVersion: row.stepVersion + 1,
      updatedAt: now,
    }).where(eq(learningSessions.id, row.id));
    [row] = await db.select().from(learningSessions).where(eq(learningSessions.id, sessionId)).limit(1);
    if (!row) throw new LearningSessionError("学习会话迁移后不可用", 500, "session_migration_failed");
  }
  return row;
}

async function toView(row: SessionRow): Promise<LearningSessionView> {
  if (row.experienceVersion === "gap_retrieval_v3") return toRetrievalView(row);
  return {
    id: row.id,
    status: row.status === "completed" ? "completed" : "active",
    mode: row.mode === "review" ? "review" : "learn",
    experienceVersion: "context_audio_v2",
    step: await buildStep(row),
  };
}

async function filterV3Assignments(ids: string[], questionId: string | null): Promise<string[]> {
  if (!ids.length) return [];
  const db = await getDbReady();
  const rows = await db.all<{ chunkId: string }>(sql`
    SELECT a.chunk_id AS chunkId FROM learning_experiment_assignments a
    WHERE a.experiment_id='gap_retrieval_v3' AND a.status='active'
      AND a.chunk_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
      AND (${questionId} IS NULL OR a.question_id=${questionId})`);
  const assigned = new Set(rows.map((row) => row.chunkId));
  return ids.filter((id) => assigned.has(id));
}

async function getQuestionQueue(questionId: string): Promise<string[]> {
  const db = await getDbReady();
  const rows = await db.all<{ chunkId: string }>(sql`
    SELECT DISTINCT u.chunk_id AS chunkId
    FROM question_learning_units u JOIN chunks c ON c.id = u.chunk_id
    WHERE u.question_id = ${questionId} AND u.status = 'active'
      AND c.quality_status IN ('approved','edited')
      AND (u.first_round_completed_at IS NULL OR EXISTS (
        SELECT 1 FROM learning_progress lp WHERE lp.chunk_id = c.id
          AND julianday(json_extract(lp.fsrs_json, '$.due')) <= julianday('now')))
      AND (c.book_id != 'book_personal_ielts_answers' OR EXISTS (
        SELECT 1 FROM personal_chunk_links pcl JOIN personal_answers pa ON pa.id = pcl.answer_id
        WHERE pcl.chunk_id = c.id AND pcl.status = 'active' AND pa.question_id = ${questionId} AND pa.superseded_by_revision_id IS NULL))
    ORDER BY CASE WHEN u.first_round_completed_at IS NULL THEN 0 ELSE 1 END,
      u.priority DESC, u.created_at, u.id LIMIT 8`);
  return rows.map((row) => row.chunkId);
}

export async function createOrResumeSession(input: {
  mode: "learn" | "review";
  restart?: boolean;
  scope?: "daily" | "question";
  questionId?: string;
}): Promise<LearningSessionView> {
  const mode = input.mode;
  const restart = input.restart ?? false;
  const scope = input.scope ?? "daily";
  const scopeId = scope === "question" ? input.questionId ?? null : null;
  if (scope === "question" && !scopeId) throw new LearningSessionError("按题学习缺少 questionId", 400, "question_required");
  const db = await getDbReady();
  const sessionDate = todayInShanghai();
  const [existing] = await db
    .select()
    .from(learningSessions)
    .where(and(
      eq(learningSessions.sessionDate, sessionDate),
      eq(learningSessions.mode, mode),
      eq(learningSessions.status, "active"),
      eq(learningSessions.scopeType, scope),
      scopeId ? eq(learningSessions.scopeId, scopeId) : sql`${learningSessions.scopeId} IS NULL`,
    ))
    .orderBy(sql`${learningSessions.updatedAt} DESC`)
    .limit(1);
  if (existing && !restart) return toView(existing);
  if (existing) {
    const now = new Date().toISOString();
    await db
      .update(learningSessions)
      .set({ status: "abandoned", lastEventAt: now, updatedAt: now })
      .where(eq(learningSessions.id, existing.id));
  }

  const queue = scope === "question" ? null : await getTodayQueue();
  let ids = scope === "question"
    ? await getQuestionQueue(scopeId!)
    : mode === "review"
      ? queue!.due
      : [...queue!.fresh, ...queue!.due];
  const v3Ids = await filterV3Assignments(ids, scopeId);
  const useV3 = v3Ids.length > 0 && (scope === "question" || mode === "review");
  if (useV3) ids = v3Ids;
  if (ids.length === 0) {
    return {
      id: null,
      status: "completed",
      mode,
      step: { type: "complete", sessionId: null, total: 0, completed: 0, message: "当前没有已发布且需要学习的内容。" },
    };
  }
  const id = randomUUID();
  const companionThreadId = scopeId ? await createCompanionThreadForQuestion(scopeId) : null;
  await db.insert(learningSessions).values({
    id,
    sessionDate,
    mode,
    status: "active",
    queueJson: JSON.stringify(ids),
    currentIndex: 0,
    step: useV3 ? (mode === "review" ? "review_prompt" : "retrieval_prompt") : "context_audio_input",
    stepVersion: 1,
    experienceVersion: useV3 ? "gap_retrieval_v3" : "context_audio_v2",
    scopeType: scope,
    scopeId,
    companionThreadId,
    stateJson: JSON.stringify(useV3 ? {} : emptyState()),
  });
  return toView(await loadSession(id));
}

export async function getSessionView(sessionId: string): Promise<LearningSessionView> {
  const row = await loadSession(sessionId);
  if (row.status === "abandoned") {
    throw new LearningSessionError("这个学习会话已被放弃，请重新开始", 409, "session_abandoned");
  }
  return toView(row);
}

/** 为盲听音频端点提供服务端文本；该文本不得进入学习步骤 JSON。 */
export async function getSessionAudioSpec(sessionId: string, expectedStepVersion: number) {
  const row = await loadSession(sessionId);
  if (row.experienceVersion === "gap_retrieval_v3") {
    throw new LearningSessionError("V3 提取流程不使用盲听音频端点", 409, "audio_not_used");
  }
  if (row.status !== "active") throw new LearningSessionError("学习会话已经结束", 409, "session_completed");
  if (row.stepVersion !== expectedStepVersion) throw new LearningSessionError("学习步骤已经变化，请刷新后重播", 409, "stale_step");
  assertStep(row, ["context_audio_input", "transcript_replay"], "request_context_audio");
  const queue = z.array(z.string()).parse(JSON.parse(row.queueJson));
  const chunkId = queue[row.currentIndex];
  const content = await loadLearningContent(chunkId, row.scopeType === "question" ? row.scopeId : null);
  if (!content) throw new LearningSessionError("当前语境音频内容不可用", 409, "content_unavailable");
  return { text: content.context.audioText, accent: content.context.accent };
}

/** 放弃未完成会话不写 FSRS；调用可安全重放。 */
export async function abandonSession(sessionId: string): Promise<void> {
  const db = await getDbReady();
  const row = await loadSession(sessionId);
  if (row.status !== "active") return;
  const now = new Date().toISOString();
  await db
    .update(learningSessions)
    .set({ status: "abandoned", lastEventAt: now, updatedAt: now })
    .where(and(eq(learningSessions.id, sessionId), eq(learningSessions.status, "active")));
  await db.insert(learningEvents).values({
    id: randomUUID(),
    clientEventId: randomUUID(),
    sessionId,
    eventType: "abandon_session",
    payloadJson: JSON.stringify({ type: "abandon_session", abandonedAt: now }),
  });
}

function assertStep(row: SessionRow, allowed: SessionStepName[], eventType: string): void {
  if (!allowed.includes(row.step as SessionStepName)) {
    throw new LearningSessionError(
      `事件 ${eventType} 不能用于步骤 ${row.step}`,
      409,
      "invalid_transition",
    );
  }
}

async function persistSession(row: SessionRow, step: SessionStepName, state: SessionState, currentIndex = row.currentIndex, status = row.status) {
  const db = await getDbReady();
  const now = new Date().toISOString();
  const updated = await db
    .update(learningSessions)
    .set({ step, stepVersion: row.stepVersion + 1, stateJson: JSON.stringify(state), currentIndex, status, lastEventAt: now, updatedAt: now })
    .where(and(eq(learningSessions.id, row.id), eq(learningSessions.stepVersion, row.stepVersion), eq(learningSessions.status, row.status)))
    .returning({ id: learningSessions.id });
  if (!updated.length) throw new LearningSessionError('学习状态已更新，请刷新后继续', 409, 'event_conflict');
}

export async function applySessionEvent(sessionId: string, event: LearningEvent): Promise<LearningSessionView> {
  const row = await loadSession(sessionId);
  if (row.experienceVersion === "gap_retrieval_v3") return applyRetrievalSessionEvent(sessionId, event);
  return withDbTransaction(() => applySessionEventInTransaction(sessionId, event));
}

async function applySessionEventInTransaction(sessionId: string, event: LearningEvent): Promise<LearningSessionView> {
  const db = await getDbReady();
  const duplicate = await db.select().from(learningEvents).where(eq(learningEvents.clientEventId, event.clientEventId)).limit(1);
  if (duplicate[0]) {
    if (duplicate[0].sessionId !== sessionId) throw new LearningSessionError("clientEventId 已被其他会话使用", 409, "event_conflict");
    return getSessionView(sessionId);
  }

  const row = await loadSession(sessionId);
  if (row.status !== "active") throw new LearningSessionError("会话已经结束", 409, "session_completed");
  if (event.stepVersion !== undefined && event.stepVersion !== row.stepVersion) return getSessionView(sessionId);
  const queue = z.array(z.string()).parse(JSON.parse(row.queueJson));
  const chunkId = queue[row.currentIndex];
  const content = await loadLearningContent(chunkId, row.scopeType === "question" ? row.scopeId : null);
  if (!content) throw new LearningSessionError("当前学习内容不可用", 409, "content_unavailable");
  const state = parseState(row.stateJson);

  if (event.type === "mark_audio_heard") {
    assertStep(row, ["context_audio_input"], event.type);
    state.contextPlayback = event.playback;
    if (event.playback === "unavailable") state.assists += 1;
    await persistSession(row, "comprehension_rating", state);
  } else if (event.type === "rate_comprehension") {
    assertStep(row, ["comprehension_rating"], event.type);
    state.comprehension = event.rating;
    state.practicePlan = await buildPracticePlan(content, event.rating);
    updateSkill(state, "listening", { attempts: 1, correct: event.rating === "understood" ? 1 : 0 });
    const settings = await getUserSettings();
    if (settings.autoCollectDifficulties && event.rating !== "understood") {
      await upsertDifficultyNote({
        chunkId,
        surface: content.chunk.display,
        meaningZh: content.chunk.meaningZh,
        sourceType: "chunk",
        sourceId: chunkId,
        trigger: event.rating,
      });
    }
    await persistSession(row, "transcript_replay", state);
  } else if (event.type === "request_assist") {
    assertStep(row, ["transcript_replay", "chunk_reveal", "guided_practice"], event.type);
    state.assists += 1;
    if (row.step === "guided_practice") {
      const current = state.practicePlan[state.practiceIndex];
      if (current) updateSkill(state, skillForPractice(current.kind), { assists: 1 });
    }
    await persistSession(row, row.step as SessionStepName, state);
  } else if (event.type === "continue_to_chunk") {
    assertStep(row, ["transcript_replay"], event.type);
    await persistSession(row, "chunk_reveal", state);
  } else if (event.type === "continue_to_shadowing") {
    assertStep(row, ["chunk_reveal"], event.type);
    await persistSession(row, "shadowing", state);
  } else if (event.type === "complete_shadowing") {
    assertStep(row, ["shadowing"], event.type);
    state.shadowingAttempts = event.attempts;
    state.microphoneMode = event.microphoneMode;
    state.microphoneFallbackReason = event.fallbackReason;
    updateSkill(state, "shadowing", { attempts: event.attempts, correct: 1, assists: event.microphoneMode === "self_assessed" ? 1 : 0 });
    if (event.microphoneMode === "self_assessed") state.assists += 1;
    await persistSession(row, "contextual_recall", state);
  } else if (event.type === "complete_contextual_recall") {
    assertStep(row, ["contextual_recall"], event.type);
    state.contextualRecallAttempts = event.attempts;
    state.contextualRecallMode = event.microphoneMode;
    state.contextualRecallFallbackReason = event.fallbackReason;
    updateSkill(state, "contextual_recall", {
      attempts: event.attempts,
      correct: 1,
      assists: event.microphoneMode === "self_assessed" ? 1 : 0,
    });
    if (event.microphoneMode === "self_assessed") state.assists += 1;
    await persistSession(row, "guided_practice", state);
  } else if (event.type === "submit_practice") {
    assertStep(row, ["guided_practice"], event.type);
    const task = state.practicePlan[state.practiceIndex];
    if (!task || task.id !== event.practiceId) {
      throw new LearningSessionError("练习 ID 与当前步骤不一致", 409, "practice_mismatch");
    }
    state.attempts[task.id] = (state.attempts[task.id] ?? 0) + 1;
    const correct = task.correctOptionId
      ? event.answer === task.correctOptionId || normalizeAnswer(event.answer) === normalizeAnswer(task.correctAnswer)
      : normalizeAnswer(event.answer) === normalizeAnswer(task.correctAnswer);
    const skill = skillForPractice(task.kind);
    updateSkill(state, skill, { attempts: 1, correct: correct ? 1 : 0 });
    if (!correct) {
      state.errors += 1;
      state.feedback = {
        practiceId: task.id,
        message: "还没有完全拼对。看一下提示，再把这一题做对后继续。",
        expectedHint: task.kind === "meaning_recognition" ? "回到原句判断语境" : `共 ${task.correctAnswer.split(/\s+/).length} 个词`,
      };
      const settings = await getUserSettings();
      if (settings.autoCollectDifficulties) {
        await upsertDifficultyNote({
          chunkId,
          surface: content.chunk.display,
          meaningZh: content.chunk.meaningZh,
          sourceType: "practice",
          sourceId: task.id,
          trigger: "practice_error",
        });
      }
      await persistSession(row, "guided_practice", state);
    } else {
      state.feedback = null;
      state.practiceIndex += 1;
      if (state.practiceIndex < state.practicePlan.length) {
        await persistSession(row, "guided_practice", state);
      } else {
        const rating = deriveOutcome(row, state);
        state.outcomeRating = rating;
        const metrics: LearningOutcomeMetrics = {
          sessionId: row.id,
          comprehension: state.comprehension ?? "not_understood",
          errors: state.errors,
          assists: state.assists,
          shadowingAttempts: state.shadowingAttempts,
          microphoneMode: state.microphoneMode,
          skills: state.skills,
        };
        await applyLearningOutcome(chunkId, rating, metrics);
        await persistSession(row, "outcome", state);
      }
    }
  } else if (event.type === "continue_outcome") {
    assertStep(row, ["outcome"], event.type);
    await persistSession(row, "scheduled", state);
  } else if (event.type === "continue_scheduled") {
    assertStep(row, ["scheduled"], event.type);
    const nextIndex = row.currentIndex + 1;
    if (nextIndex >= queue.length) {
      await persistSession(row, "context_audio_input", emptyState(), nextIndex, "completed");
    } else {
      await persistSession(row, "context_audio_input", emptyState(), nextIndex);
    }
  }

  await db.insert(learningEvents).values({
    id: randomUUID(),
    clientEventId: event.clientEventId,
    sessionId,
    eventType: event.type,
    payloadJson: JSON.stringify(event),
  });
  return getSessionView(sessionId);
}
