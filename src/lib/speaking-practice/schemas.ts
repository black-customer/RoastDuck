import { z } from "zod";
import { materialEvidenceSchema } from "@/lib/four-step/selection-contracts";

export const gapItemSchema = z.object({
  learningBasis:z.enum(['confirmed_error','preparation']).optional(),
  key: z.string().trim().min(1).max(120),
  intentZh: z.string().trim().min(1).max(800),
  targetEnglish: z.string().trim().min(1).max(800),
  gapType: z.enum(["lexical_gap", "grammar_gap", "unexpressed_intention", "natural_phrase", "discourse_gap", "question_understanding", "content_gap", "asr_uncertain", "pronunciation_unknown"]),
  evidence: z.string().trim().min(1).max(1500),
  explanationZh: z.string().trim().min(1).max(1000),
});
export type GapItem = z.infer<typeof gapItemSchema>;

export const correctionItemSchema = z.object({
  original: z.string().trim().min(1).max(1500),
  corrected: z.string().trim().min(1).max(1500),
  reasonZh: z.string().trim().min(1).max(1000),
});
export type CorrectionItem = z.infer<typeof correctionItemSchema>;

export const learningItemCandidateSchema = z.object({
  canonicalKey: z.string().trim().min(1).max(160),
  targetEnglish: z.string().trim().min(1).max(800),
  intentionZh: z.string().trim().min(1).max(800),
  itemType: z.enum(["lexical_chunk", "collocation", "sentence_frame", "grammar_pattern", "personal_expression"]).default("lexical_chunk"),
  example: z.string().trim().min(1).max(1500),
});
export type LearningItemCandidate = z.infer<typeof learningItemCandidateSchema>;

export const clozeItemSchema = z.object({
  gapKey: z.string().trim().min(1).max(120),
  originalSentence: z.string().trim().min(1).max(1500),
  clozeSentence: z.string().trim().min(1).max(1500),
  answer: z.string().trim().min(1).max(800),
  hintZh: z.string().trim().min(1).max(800),
  acceptableAnswers: z.array(z.string().trim().min(1).max(800)).default([]),
});
export type ClozeItem = z.infer<typeof clozeItemSchema>;

export const examFeedbackSchema = z.object({
  transcriptBasedNotice: z.string().trim().default("本反馈基于答题文本与发音转写，未对实际语音声学指标进行评分。"),
  lexicalResource: z.string().trim().min(1).max(2000),
  grammaticalRange: z.string().trim().min(1).max(2000),
  coherence: z.string().trim().min(1).max(2000),
  paraphrasing: z.string().trim().min(1).max(2000),
  strengths: z.array(z.string().trim().min(1).max(500)).default([]),
  weaknesses: z.array(z.string().trim().min(1).max(500)).default([]),
  approximateBand: z.string().trim().max(40).nullable().default(null),
});
export type ExamFeedback = z.infer<typeof examFeedbackSchema>;

export const learningMaterialRowSchema = z.object({
  learningBasis:z.enum(['confirmed_error','preparation']).optional(),senseKey:z.string().optional(),
  gapId:z.string().optional(), sentenceId:z.string().optional(), intentUnitIds:z.array(z.string()).optional(),
  surfaceInSentence:z.string().optional(), originalEnglish:z.string().optional(), originalChinese:z.string().optional(), inclusionReasonZh:z.string().optional(),
  chineseChunk: z.string().trim().min(1).max(500),
  englishChunk: z.string().trim().min(1).max(500),
  acceptableVariants: z.array(z.string().trim().min(1).max(500)).default([]),
  yourChineseSentence: z.string().trim().min(1).max(1500),
  naturalEnglishSentence: z.string().trim().min(1).max(1500),
});
export type LearningMaterialRow = z.infer<typeof learningMaterialRowSchema>;

export const speakingAttemptAnalysisSchema = z.object({
  learningTargetCount:z.number().int().min(0).optional(),needsAttention:z.array(z.object({intentZh:z.string(),reasonZh:z.string()})).optional(),
  contractVersion:z.literal("evidence_v2").optional(), evidence:materialEvidenceSchema.optional(), answerIntentZh:z.string().max(16000).optional(),
  naturalVersion: z.string().trim().max(8000),
  gaps: z.array(gapItemSchema).default([]),
  corrections: z.array(correctionItemSchema).default([]),
  learningItems: z.array(learningItemCandidateSchema).default([]),
  learningMaterials: z.array(learningMaterialRowSchema).default([]),
  gapCount: z.number().int().min(0),
  clozeItems: z.array(clozeItemSchema).default([]),
  examFeedback: examFeedbackSchema.nullable().default(null),
});
export type SpeakingAttemptAnalysis = z.infer<typeof speakingAttemptAnalysisSchema>;

export const translationEvaluationSchema = z.object({
  passed: z.boolean(),
  feedbackZh: z.string().trim().min(1).max(1500),
  communicatedIntention: z.boolean(),
  naturalness: z.string().trim().min(1).max(500),
  suggestedAlternative: z.string().trim().max(1000).default(""),
});
export type TranslationEvaluation = z.infer<typeof translationEvaluationSchema>;

export const createAttemptInputSchema = z.object({
  clientRequestId: z.string().min(8).max(120).optional(),
  questionId: z.string().trim().min(1).max(120),
  mode: z.enum(["practice", "exam_style"]),
  answerText: z.string().trim().min(1).max(8000),
  intendedMeaningZh: z.string().trim().max(8000).default(""),
});
export type CreateAttemptInput = z.infer<typeof createAttemptInputSchema>;

export const evaluateTranslationInputSchema = z.object({
  userEnglish: z.string().trim().min(1).max(8000),
});
export type EvaluateTranslationInput = z.infer<typeof evaluateTranslationInputSchema>;
