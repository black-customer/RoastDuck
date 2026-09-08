import { z } from "zod";

export const RETRIEVAL_JUDGE_PROMPT_VERSION = "gap-retrieval-judge-v1";
export const VARIANT_REVIEW_PROMPT_VERSION = "expression-variant-reviewer-v1";

export const retrievalVerdictSchema = z.enum([
  "natural_equivalent",
  "context_difference",
  "incorrect",
  "uncertain",
]);

export const retrievalGlossaryEntrySchema = z.object({
  surface: z.string().trim().min(1).max(160),
  meaningZh: z.string().trim().min(1).max(240),
  ipa: z.string().trim().max(160).default(""),
});

export const retrievalJudgeOutputSchema = z.object({
  verdict: retrievalVerdictSchema,
  meaningPreserved: z.boolean(),
  naturalness: z.enum(["natural", "understandable", "unnatural", "unknown"]),
  registerDifference: z.string().trim().max(300).default(""),
  frequencyDifference: z.string().trim().max(300).default(""),
  explanationZh: z.string().trim().min(1).max(600),
  recommendedExpression: z.string().trim().min(1).max(500),
  proposedVariant: z.object({
    expression: z.string().trim().min(1).max(500),
    contextConstraintZh: z.string().trim().max(500).default(""),
  }).nullable().default(null),
  glossary: z.array(retrievalGlossaryEntrySchema).max(200).default([]),
});

export const expressionVariantReviewOutputSchema = z.object({
  verdict: z.enum(["approved", "edited", "rejected"]),
  relation: z.enum(["equivalent", "register_variant", "context_variant", "not_equivalent"]),
  expression: z.string().trim().min(1).max(500),
  register: z.enum(["casual", "neutral", "formal", "mixed", "unknown"]),
  contextConstraintZh: z.string().trim().max(500).default(""),
  frequencyRelation: z.enum(["more_common", "similar", "less_common", "unknown"]),
  reasonZh: z.string().trim().min(1).max(800),
  canUseForLocalMatch: z.boolean(),
});

/**
 * 只消除不承载意义的书写差异。不能改词形、词序或缩写，因此本地命中不会
 * 把真正不同的表达误判成标准答案。
 */
export function normalizeRetrievalExpression(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?,;:]+$/g, "")
    .trim();
}

export type RetrievalJudgeOutput = z.infer<typeof retrievalJudgeOutputSchema>;
export type ExpressionVariantReviewOutput = z.infer<typeof expressionVariantReviewOutputSchema>;
