import { z } from "zod";

export const comprehensionRatingSchema = z.enum(["understood", "unsure", "not_understood"]);
export type ComprehensionRating = z.infer<typeof comprehensionRatingSchema>;

export interface InteractiveAnnotation {
  id: string;
  start: number;
  end: number;
  surface: string;
}

export interface InteractiveText {
  contentType: "sentence" | "example" | "question" | "scenario_line" | "speaking_hint" | "speaking_feedback" | "speaking_message";
  contentId: string;
  text: string;
  annotations: InteractiveAnnotation[];
}

export interface SessionMeta {
  sessionId: string;
  stepVersion: number;
  current: number;
  total: number;
  remaining: number;
  /** V3 当前学习目标；供 Chloe 任务侧栏使用，不包含隐藏答案。 */
  gapId?: string;
  chunkId?: string;
  questionId?: string;
}

export interface RetrievalScenePrompt {
  id: string;
  settingZh: string;
  relationshipZh: string;
  purposeZh: string;
  promptZh: string;
  intentZh: string;
}

export interface RetrievalPromptStep extends SessionMeta {
  type: "retrieval_prompt" | "review_prompt";
  scene: RetrievalScenePrompt;
  inputHint: "Windows 可按 Win + H；手机可用输入法麦克风。应用不会请求录音权限。";
  allowUnknown: true;
}

export interface RetrievalJudgementStep extends SessionMeta {
  type: "retrieval_judgement" | "review_judgement";
  status: "judging" | "failed";
  userExpression: string;
  message: string;
  canRetry: boolean;
  canViewInstruction: boolean;
}

export type RetrievalVerdict = "natural_equivalent" | "context_difference" | "incorrect" | "uncertain" | "unknown";

export interface RetrievalComparisonStep extends SessionMeta {
  type: "comparison";
  verdict: RetrievalVerdict;
  userExpression: string | null;
  recommendedExpression: string;
  explanationZh: string;
  registerDifference: string;
  frequencyDifference: string;
  detailCollapsed: boolean;
  accent: "en-US";
}

export interface AdaptiveInstructionStep extends SessionMeta {
  type: "adaptive_instruction" | "repair_instruction";
  detailMode: "compact" | "expanded";
  chunk: {
    id: string;
    display: string;
    meaningZh: string;
    ipa: string;
    accent: string;
    pattern: string | null;
  };
  keyExplanationZh: string;
  commonMistake: string;
  originalScene: RetrievalScenePrompt & { targetTextEn: string; targetTextZh: string };
  transferScene: RetrievalScenePrompt & { targetTextEn: string; targetTextZh: string };
  shadowingOptional: true;
  next: "active_recall" | "transfer_recall" | "repair_recall";
}

export interface RecallInputStep extends SessionMeta {
  type: "active_recall" | "transfer_recall" | "repair_recall" | "transfer_retry";
  scene: RetrievalScenePrompt;
  assistLevel: 0 | 1 | 2 | 3 | 4;
  assistText: string | null;
  feedbackZh: string | null;
  allowUnknown: true;
  inputHint: "Windows 可按 Win + H；手机可用输入法麦克风。应用不会请求录音权限。";
}

export interface ContextAudioInputStep extends SessionMeta {
  type: "context_audio_input";
  contextKind: "common_usage" | "ielts_question";
  audioUrl: string;
  accent: string;
  autoPlay: boolean;
  lineCount: number;
}

export interface ComprehensionRatingStep extends SessionMeta {
  type: "comprehension_rating";
  playback: "played" | "unavailable";
  comprehensionOptions: Array<{ value: ComprehensionRating; label: "理解" | "有点懵" | "没听懂" }>;
}

export interface ContextLine {
  id: string;
  speaker: string;
  text: InteractiveText;
  translationZh: string;
  target: boolean;
}

export interface TranscriptReplayStep extends SessionMeta {
  type: "transcript_replay";
  comprehension: ComprehensionRating;
  context: {
    kind: "common_usage" | "ielts_question";
    settingZh: string;
    relationshipZh: string;
    purposeZh: string;
    accent: string;
    generated: boolean;
    lines: ContextLine[];
  };
  audioUrl: string;
  support: { slowReplay: boolean; breakdown: boolean };
}

export interface ChunkRevealStep extends SessionMeta {
  type: "chunk_reveal";
  comprehension: ComprehensionRating;
  context: TranscriptReplayStep["context"];
  chunk: {
    id: string;
    display: string;
    meaningZh: string;
    englishGloss: string;
    ipa: string;
    accent: string;
    pattern: string | null;
    unitType: string;
  };
  example: InteractiveText & { translationZh: string; contextId: string; generated: boolean };
  support: { slowReplay: boolean; breakdown: boolean; automaticNote: boolean };
}

export interface ShadowingStep extends SessionMeta {
  type: "shadowing";
  targetLine: ContextLine;
  accent: string;
  instructions: string[];
  microphoneFallbackAllowed: true;
}

export interface ContextualRecallStep extends SessionMeta {
  type: "contextual_recall";
  scene: {
    settingZh: string;
    relationshipZh: string;
    purposeZh: string;
    promptZh: string;
    targetMeaningZh: string;
  };
  accent: string;
  microphoneFallbackAllowed: true;
}

export type PracticeKind =
  | "meaning_recognition"
  | "listening_discrimination"
  | "chunk_reconstruction"
  | "sentence_reconstruction"
  | "cloze"
  | "translation_reconstruction";

export interface PracticeStep extends SessionMeta {
  type: "guided_practice";
  practice: {
    id: string;
    kind: PracticeKind;
    title: string;
    instruction: string;
    prompt: InteractiveText | null;
    promptZh: string | null;
    options: Array<{ id: string; label: string }>;
    tiles: Array<{ id: string; label: string }>;
    audioText: string | null;
    attempt: number;
    feedback: { status: "incorrect"; message: string; expectedHint: string | null } | null;
  };
  practiceNumber: number;
  practiceTotal: number;
}

export interface OutcomeStep extends SessionMeta {
  type: "outcome";
  result: {
    rating: "again" | "hard" | "good" | "easy";
    label: string;
    errors: number;
    assists: number;
    shadowingAttempts: number;
    message: string;
    retrievalSummary?: {
      initialVerdict: RetrievalVerdict;
      transferPassed: boolean;
      assistanceLevel: number;
      independent: boolean;
    };
  };
}

export interface ScheduledStep extends SessionMeta {
  type: "scheduled";
  result: OutcomeStep["result"];
  nextAction: "next_item" | "complete_session";
}

export interface CompleteStep {
  type: "complete";
  sessionId: string | null;
  total: number;
  completed: number;
  message: string;
}

export type LearningStep =
  | RetrievalPromptStep
  | RetrievalJudgementStep
  | RetrievalComparisonStep
  | AdaptiveInstructionStep
  | RecallInputStep
  | ContextAudioInputStep
  | ComprehensionRatingStep
  | TranscriptReplayStep
  | ChunkRevealStep
  | ShadowingStep
  | ContextualRecallStep
  | PracticeStep
  | OutcomeStep
  | ScheduledStep
  | CompleteStep;

export interface LearningSessionView {
  id: string | null;
  status: "active" | "completed";
  mode: "learn" | "review";
  experienceVersion?: "context_audio_v2" | "gap_retrieval_v3";
  step: LearningStep;
}

export const learningEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("mark_audio_heard"),
    clientEventId: z.string().uuid(),
    stepVersion: z.number().int().positive().optional(),
    playback: z.enum(["played", "unavailable"]),
  }),
  z.object({
    type: z.literal("rate_comprehension"),
    clientEventId: z.string().uuid(),
    stepVersion: z.number().int().positive().optional(),
    rating: comprehensionRatingSchema,
  }),
  z.object({
    type: z.literal("request_assist"),
    clientEventId: z.string().uuid(),
    stepVersion: z.number().int().positive().optional(),
    assist: z.enum(["slow_replay", "breakdown", "hint"]),
  }),
  z.object({ type: z.literal("continue_to_chunk"), clientEventId: z.string().uuid(), stepVersion: z.number().int().positive().optional() }),
  z.object({ type: z.literal("continue_to_shadowing"), clientEventId: z.string().uuid(), stepVersion: z.number().int().positive().optional() }),
  z.object({
    type: z.literal("complete_shadowing"),
    clientEventId: z.string().uuid(),
    stepVersion: z.number().int().positive().optional(),
    attempts: z.number().int().min(1).max(20),
    microphoneMode: z.enum(["recorded", "self_assessed"]),
    fallbackReason: z
      .enum(["permission_denied", "unsupported", "device_error", "timeout", "format_unsupported"])
      .nullable()
      .default(null),
  }),
  z.object({
    type: z.literal("complete_contextual_recall"),
    clientEventId: z.string().uuid(),
    stepVersion: z.number().int().positive().optional(),
    attempts: z.number().int().min(1).max(20),
    microphoneMode: z.enum(["recorded", "self_assessed"]),
    fallbackReason: z
      .enum(["permission_denied", "unsupported", "device_error", "timeout", "format_unsupported"])
      .nullable()
      .default(null),
  }),
  z.object({
    type: z.literal("submit_practice"),
    clientEventId: z.string().uuid(),
    stepVersion: z.number().int().positive().optional(),
    practiceId: z.string().min(3),
    answer: z.string().max(1000),
  }),
  z.object({ type: z.literal("continue_outcome"), clientEventId: z.string().uuid(), stepVersion: z.number().int().positive().optional() }),
  z.object({ type: z.literal("continue_scheduled"), clientEventId: z.string().uuid(), stepVersion: z.number().int().positive().optional() }),
  z.object({
    type: z.literal("submit_retrieval"),
    clientEventId: z.string().uuid(),
    stepVersion: z.number().int().positive().optional(),
    input: z.string().trim().min(1).max(8000),
  }),
  z.object({
    type: z.literal("mark_unknown"),
    clientEventId: z.string().uuid(),
    stepVersion: z.number().int().positive().optional(),
  }),
  z.object({ type: z.literal("retry_judgement"), clientEventId: z.string().uuid(), stepVersion: z.number().int().positive().optional() }),
  z.object({ type: z.literal("continue_comparison"), clientEventId: z.string().uuid(), stepVersion: z.number().int().positive().optional() }),
  z.object({ type: z.literal("continue_instruction"), clientEventId: z.string().uuid(), stepVersion: z.number().int().positive().optional() }),
  z.object({ type: z.literal("continue_transfer"), clientEventId: z.string().uuid(), stepVersion: z.number().int().positive().optional() }),
  z.object({
    type: z.literal("submit_transfer"),
    clientEventId: z.string().uuid(),
    stepVersion: z.number().int().positive().optional(),
    input: z.string().trim().min(1).max(8000),
  }),
]);

export type LearningEvent = z.infer<typeof learningEventSchema>;

export const createSessionSchema = z.object({
  mode: z.enum(["learn", "review"]).default("learn"),
  restart: z.boolean().default(false),
  scope: z.enum(["daily", "question"]).default("daily"),
  questionId: z.string().min(1).max(128).optional(),
}).superRefine((value, context) => {
  if (value.scope === "question" && !value.questionId) {
    context.addIssue({ code: "custom", path: ["questionId"], message: "按题学习必须提供 questionId" });
  }
});
