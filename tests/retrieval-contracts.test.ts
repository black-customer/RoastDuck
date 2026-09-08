import { describe, expect, it } from "vitest";
import { AI_ROLE_CONFIG, AI_ROLES } from "@/lib/ai/contracts";
import {
  expressionVariantReviewOutputSchema,
  normalizeRetrievalExpression,
  retrievalJudgeOutputSchema,
} from "@/lib/learning/retrieval-contracts";

describe("Gap 提取 V3 判定契约", () => {
  it("本地规范化只忽略大小写、空格、弯引号和句末标点", () => {
    expect(normalizeRetrievalExpression("  I  CAN’T   rely on it！ ")).toBe("i can't rely on it");
    expect(normalizeRetrievalExpression("I rely on it")).not.toBe(normalizeRetrievalExpression("I relied on it"));
    expect(normalizeRetrievalExpression("make progress")).not.toBe(normalizeRetrievalExpression("achieve progress"));
  });

  it("Judge 输出区分自然等价、场景差异、错误和不确定", () => {
    for (const verdict of ["natural_equivalent", "context_difference", "incorrect", "uncertain"] as const) {
      expect(retrievalJudgeOutputSchema.safeParse({
        verdict,
        meaningPreserved: verdict !== "incorrect",
        naturalness: verdict === "natural_equivalent" ? "natural" : "unknown",
        explanationZh: "只说明当前最关键的判定依据。",
        recommendedExpression: "make steady progress",
        proposedVariant: null,
        glossary: [],
      }).success).toBe(true);
    }
  });

  it("个人变体 Reviewer 必须给出独立关系、频率和本地命中许可", () => {
    expect(expressionVariantReviewOutputSchema.parse({
      verdict: "approved",
      relation: "equivalent",
      expression: "make consistent progress",
      register: "neutral",
      contextConstraintZh: "适合描述长期学习进展",
      frequencyRelation: "similar",
      reasonZh: "该表达在这个场景中自然保留了持续取得进步的意思。",
      canUseForLocalMatch: true,
    })).toMatchObject({ verdict: "approved", canUseForLocalMatch: true });
  });

  it("四个 V3 AI 角色均有显式配置", () => {
    for (const role of ["retrieval_judge", "variant_reviewer", "companion_response", "memory_extractor"] as const) {
      expect(AI_ROLES).toContain(role);
      expect(AI_ROLE_CONFIG[role].maxOutputTokens).toBeGreaterThan(0);
    }
  });
});
