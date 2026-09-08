import { z } from "zod";

export const answerTransformOutputSchema = z.object({
  revisedEnglish: z.string().trim().min(1).max(8000),
  translationZh: z.string().trim().min(1).max(8000),
  changes: z.array(z.object({
    type: z.enum(["translation", "grammar", "wording", "gap", "fluency"]),
    original: z.string().max(1000),
    revised: z.string().max(1000),
    reasonZh: z.string().min(1).max(500),
  })).max(40),
  gaps: z.array(z.object({
    originalZh: z.string().min(1).max(500),
    recommendedEnglish: z.string().min(1).max(500),
  })).max(30),
  sentences: z.array(z.object({
    textEn: z.string().trim().min(1).max(1500),
    textZh: z.string().trim().min(1).max(1500),
  })).min(1).max(40),
});

export type AnswerTransformOutput = z.infer<typeof answerTransformOutputSchema>;

export const personalChunkCandidateSchema = z.object({
  sentenceIndex: z.number().int().min(0).max(39),
  displayChunk: z.string().trim().min(2).max(160),
  canonicalChunk: z.string().trim().min(2).max(160),
  unitType: z.enum(["collocation", "lexical_chunk", "phrasal_verb", "sentence_frame", "construction", "functional_expression", "idiom"]),
  meaningZh: z.string().trim().min(1).max(300),
  englishGloss: z.string().trim().min(1).max(500),
  pattern: z.string().trim().min(1).max(300),
  ipa: z.string().trim().min(1).max(300),
  exampleEn: z.string().trim().min(1).max(1500),
  exampleZh: z.string().trim().min(1).max(1500),
  lexemes: z.array(z.object({
    surface: z.string().trim().min(1).max(100),
    meaningZh: z.string().trim().min(1).max(200),
    ipa: z.string().trim().max(120),
  })).min(1).max(100),
});

export type PersonalChunkCandidate = z.infer<typeof personalChunkCandidateSchema>;

export const personalChunkGenerationSchema = z.object({
  candidates: z.array(personalChunkCandidateSchema).max(60),
});

export const personalChunkReviewSchema = z.object({
  items: z.array(z.object({
    sentenceIndex: z.number().int().min(0).max(39),
    canonicalChunk: z.string().trim().min(2).max(160),
    verdict: z.enum(["approved", "edited", "rejected"]),
    reason: z.string().trim().min(1).max(500),
    candidate: personalChunkCandidateSchema,
  })).max(60),
});

export type PersonalChunkReview = z.infer<typeof personalChunkReviewSchema>;
