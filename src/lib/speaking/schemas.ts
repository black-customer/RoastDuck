import { z } from "zod";
import { personalChunkCandidateSchema } from "@/lib/answers/ai-schemas";
import { gapCandidateSchema } from "@/lib/answers/gap-contract";

export const runtimeGlossaryEntrySchema = z.object({
  surface: z.string().trim().min(1).max(160),
  meaningZh: z.string().trim().min(1).max(240),
  ipa: z.string().trim().max(160).default(""),
});

export const createSpeakingSessionSchema = z.object({
  clientRequestId: z.string().uuid(),
  questionId: z.string().trim().min(1).max(120),
  answerId: z.string().trim().min(1).max(120).nullable().default(null),
});

export const createSpeakingMessageSchema = z.object({
  clientMessageId: z.string().uuid(),
  text: z.string().trim().min(1).max(8000),
  inputLanguage: z.enum(["zh", "en", "mixed"]).default("mixed"),
  messageKind: z.enum(["text", "voice"]).default("text"),
  retry: z.boolean().default(false),
});

export const teacherMessageOutputSchema = z.object({
  messages: z.array(z.object({
    text: z.string().trim().min(1).max(1200),
    purpose: z.enum(["natural_response", "key_issue", "natural_expression", "retry_request", "follow_up"]),
  })).min(1).max(4),
  retryRequested: z.boolean(),
  conversationComplete: z.boolean(),
  glossary: z.array(runtimeGlossaryEntrySchema).max(500),
});

export const speakingGapCandidateSchema = gapCandidateSchema;

export const speakingGapGenerationSchema = z.object({
  candidates: z.array(speakingGapCandidateSchema).max(30),
});

export const speakingGapReviewSchema = z.object({
  items: z.array(z.object({
    key: z.string().trim().min(2).max(120),
    verdict: z.enum(["approved", "edited", "rejected"]),
    reason: z.string().trim().min(1).max(800),
    candidate: speakingGapCandidateSchema,
  })).max(30),
});

export const reattemptComparisonSchema = z.object({
  items: z.array(z.object({
    subjectGapId: z.string().trim().min(3).max(160),
    comparison: z.enum(["improved", "repeated", "new", "uncertain"]),
    relatedGapId: z.string().trim().min(3).max(160).nullable(),
    reason: z.string().trim().min(1).max(800),
  })).max(60),
});

export const learningScenarioCandidateSchema = z.object({
  settingZh: z.string().trim().min(1).max(500),
  relationshipZh: z.string().trim().min(1).max(300),
  purposeZh: z.string().trim().min(1).max(500),
  register: z.enum(["casual", "neutral", "formal"]),
  accent: z.literal("en-US"),
  lines: z.array(z.object({
    speaker: z.string().trim().min(1).max(80),
    textEn: z.string().trim().min(1).max(800),
    textZh: z.string().trim().min(1).max(800),
    target: z.boolean(),
  })).min(2).max(4),
});

export const learningMaterialCandidateSchema = z.object({
  gapId: z.string().trim().min(3).max(160),
  chunk: personalChunkCandidateSchema,
  commonUsage: learningScenarioCandidateSchema,
  questionRepair: learningScenarioCandidateSchema,
  glossary: z.array(runtimeGlossaryEntrySchema).min(1).max(500),
});

export const learningMaterialGenerationSchema = z.object({
  materials: z.array(learningMaterialCandidateSchema).max(20),
});

export const learningMaterialReviewSchema = z.object({
  items: z.array(z.object({
    gapId: z.string().trim().min(3).max(160),
    verdict: z.enum(["approved", "edited", "rejected"]),
    reason: z.string().trim().min(1).max(1000),
    material: learningMaterialCandidateSchema,
  })).max(20),
});

export const speakingHintOutputSchema = z.object({
  aiChineseIdea: z.string().trim().min(1).max(3000),
  keywords: z.array(z.string().trim().min(1).max(80)).min(3).max(12),
  chunks: z.array(z.object({ text: z.string().trim().min(2).max(160), meaningZh: z.string().trim().min(1).max(200) })).min(1).max(10),
  fullAnswer: z.string().trim().min(1).max(5000),
  glossary: z.array(runtimeGlossaryEntrySchema).min(1).max(300),
});

export const speakingFeedbackOutputSchema = z.object({
  summaryZh: z.string().trim().min(1).max(1000),
  correctedAnswer: z.string().trim().min(1).max(8000),
  correctedTranslationZh: z.string().trim().min(1).max(8000),
  correctedSentences: z.array(z.object({ textEn: z.string().trim().min(1).max(1500), textZh: z.string().trim().min(1).max(1500) })).min(1).max(40),
  items: z.array(z.object({
    originalSentence: z.string().trim().min(1).max(1500),
    problemType: z.enum(["grammar", "wording", "chinglish", "collocation", "missing_expression", "fluency"]),
    reasonZh: z.string().trim().min(1).max(800),
    recommendedSentence: z.string().trim().min(1).max(1500),
    gapExpression: z.string().trim().min(1).max(160),
    gapMeaningZh: z.string().trim().min(1).max(240),
  })).max(20),
  glossary: z.array(runtimeGlossaryEntrySchema).min(1).max(500),
});

export const speakingRetryOutputSchema = z.object({
  passed: z.boolean(),
  feedbackZh: z.string().trim().min(1).max(500),
  acceptedSentence: z.string().trim().min(1).max(1500),
});

export const speakingEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("reveal_hint"), clientEventId: z.string().uuid(), level: z.number().int().min(1).max(3) }),
  z.object({ type: z.literal("submit_response"), clientEventId: z.string().uuid(), text: z.string().trim().min(1).max(8000) }),
  z.object({ type: z.literal("submit_retry"), clientEventId: z.string().uuid(), itemId: z.string().min(3).max(160), text: z.string().trim().min(1).max(1500) }),
  z.object({ type: z.literal("complete_conversation"), clientEventId: z.string().uuid() }),
]);

export type SpeakingEvent = z.infer<typeof speakingEventSchema>;
export type SpeakingHintOutput = z.infer<typeof speakingHintOutputSchema>;
export type SpeakingFeedbackOutput = z.infer<typeof speakingFeedbackOutputSchema>;
export type CreateSpeakingMessage = z.infer<typeof createSpeakingMessageSchema>;
export type TeacherMessageOutput = z.infer<typeof teacherMessageOutputSchema>;
export type SpeakingGapCandidate = z.infer<typeof speakingGapCandidateSchema>;
export type SpeakingGapGeneration = z.infer<typeof speakingGapGenerationSchema>;
export type SpeakingGapReview = z.infer<typeof speakingGapReviewSchema>;
export type ReattemptComparison = z.infer<typeof reattemptComparisonSchema>;
export type LearningScenarioCandidate = z.infer<typeof learningScenarioCandidateSchema>;
export type LearningMaterialCandidate = z.infer<typeof learningMaterialCandidateSchema>;
export type LearningMaterialGeneration = z.infer<typeof learningMaterialGenerationSchema>;
export type LearningMaterialReview = z.infer<typeof learningMaterialReviewSchema>;
export type RuntimeGlossaryEntry = z.infer<typeof runtimeGlossaryEntrySchema>;

export const storedSpeakingFeedbackSchema = z.object({
  summaryZh: z.string(),
  correctedAnswer: z.string(),
  correctedTranslationZh: z.string(),
  items: z.array(z.object({
    id: z.string(),
    originalSentence: z.string(),
    problemType: z.string(),
    reasonZh: z.string(),
    recommendedSentence: z.string(),
    gapExpression: z.string(),
    gapMeaningZh: z.string().default(""),
    resolved: z.boolean(),
    retryCount: z.number().int().nonnegative(),
    lastRetryFeedback: z.string(),
  })),
  gapStatus: z.enum(["pending", "completed", "failed"]).default("pending"),
  gapError: z.string().default(""),
  glossary: z.array(runtimeGlossaryEntrySchema).default([]),
});

export const storedHintsSchema = z.object({
  keywords: z.array(z.string()),
  chunks: z.array(z.object({ text: z.string(), meaningZh: z.string() })),
  fullAnswer: z.string(),
  glossary: z.array(runtimeGlossaryEntrySchema).default([]),
});
