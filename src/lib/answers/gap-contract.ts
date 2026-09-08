import { z } from "zod";

/** Runtime 与离线诊断共用；诊断证据不等于发布学习材料。 */
export const gapCandidateSchema = z.object({
  key: z.string().trim().min(2).max(120),
  gapType: z.enum(["lexical_gap", "grammar_construction", "discourse_gap", "question_understanding", "content_gap", "asr_uncertain", "pronunciation_unknown"]),
  evidenceText: z.string().trim().min(1).max(1500),
  intentZh: z.string().trim().max(800),
  recommendedExpression: z.string().trim().max(800),
  explanationZh: z.string().trim().min(1).max(800),
  confidence: z.number().min(0).max(1),
  impactLevel: z.enum(["low", "medium", "high"]),
  learningFit: z.boolean(),
}).superRefine((gap, ctx) => {
  if (gap.learningFit && !["lexical_gap", "grammar_construction"].includes(gap.gapType)) {
    ctx.addIssue({ code: "custom", path: ["learningFit"], message: "非表达/构式问题不得制卡" });
  }
  if (["asr_uncertain", "pronunciation_unknown"].includes(gap.gapType) && gap.recommendedExpression) {
    ctx.addIssue({ code: "custom", path: ["recommendedExpression"], message: "转写或发音不确定项不得伪造正确表达" });
  }
  if (gap.learningFit && (!gap.intentZh || !gap.recommendedExpression)) {
    ctx.addIssue({ code: "custom", message: "制卡候选必须保留中文意图及推荐表达" });
  }
});

export type GapCandidate = z.infer<typeof gapCandidateSchema>;
