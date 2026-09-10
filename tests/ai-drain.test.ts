import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONSERVATIVE_FLASH_PRICING,
  DRAIN_STAGE_ORDER,
  STAGE_DEFINITIONS,
  calculateUsageCost,
  estimateTextTokens,
} from "@pipeline/src/ai/drain";

describe("AI Drain 预算与阶段契约", () => {
  it("用保守峰时价格计算缓存/非缓存输入和输出成本", () => {
    const cost = calculateUsageCost({ inputTokens: 1_000_000, cachedTokens: 250_000, outputTokens: 100_000 });
    const expected = 0.75 * CONSERVATIVE_FLASH_PRICING.inputMissUsdPerMillion
      + 0.25 * CONSERVATIVE_FLASH_PRICING.inputCacheUsdPerMillion
      + 0.1 * CONSERVATIVE_FLASH_PRICING.outputUsdPerMillion;
    expect(cost).toBeCloseTo(expected, 8);
    expect(estimateTextTokens("12345678")).toBe(2);
    expect(estimateTextTokens("")).toBe(1);
  });

  it("七个 AI 阶段都有版本化 Prompt、Schema、角色与输出上限", () => {
    expect(DRAIN_STAGE_ORDER).toHaveLength(7);
    for (const stage of DRAIN_STAGE_ORDER) {
      const definition = STAGE_DEFINITIONS[stage];
      expect(["generator", "reviewer"]).toContain(definition.role);
      expect(definition.schemaVersion).toMatch(/\.v\d+$/);
      expect(definition.maxOutputTokens).toBeGreaterThan(0);
      expect(fs.existsSync(path.resolve("pipeline/prompts", definition.promptFile))).toBe(true);
    }
  });

  it("Quality Reviewer 的 provider/model/runId 由运行器注入，模型不自报审计身份", () => {
    const output = STAGE_DEFINITIONS.quality_review.postprocess({
      verdicts: [{ chunkId: "c_abcdef", verdict: "approved", reason: "自然且可复用" }],
    }, {
      provider: "deepseek",
      model: "deepseek-flash",
      runId: "run-independent-1",
    });
    expect(output).toMatchObject({
      reviewer: {
        role: "independent_reviewer",
        provider: "deepseek",
        model: "deepseek-flash",
        runId: "run-independent-1",
      },
    });
  });
});
