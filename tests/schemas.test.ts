import { describe, expect, it } from "vitest";
import { splitSentences } from "@pipeline/src/stages/parse_questions";
import {
  chunkCandidateBatchOutputSchema,
  contentEnrichmentBatchOutputSchema,
  dedupBatchOutputSchema,
  questionBlueprintOutputSchema,
  qualityBatchOutputSchema,
  pronunciationEnrichmentBatchOutputSchema,
  topicDomainsOutputSchema,
} from "@pipeline/src/lib/schemas";

describe("splitSentences", () => {
  it("基础分句", () => {
    const out = splitSentences("I like it. It makes me happy! Really?");
    expect(out).toEqual(["I like it.", "It makes me happy!", "Really?"]);
  });

  it("缩写保护", () => {
    const out = splitSentences("Mr. Smith went to Washington. He liked it.");
    expect(out).toEqual(["Mr. Smith went to Washington.", "He liked it."]);
  });

  it("省略号保护", () => {
    const out = splitSentences("Well... I guess so. Let me think.");
    expect(out).toHaveLength(2);
  });

  it("小写续行不分句（缩写人名等）", () => {
    const out = splitSentences("I visited NYC last year. It was fun.");
    expect(out).toHaveLength(2);
  });
});

describe("schemas：LLM 批次输出校验", () => {
  it("questionBlueprintOutput 接受合法蓝图", () => {
    const ok = questionBlueprintOutputSchema.safeParse({
      questionId: "q_1h1l5dkw2qdr",
      dimensions: [
        { dimId: "major", dimZh: "专业", dimEn: "major / subject" },
        { dimId: "year-of-study", dimZh: "年级", dimEn: "year of study" },
      ],
    });
    expect(ok.success).toBe(true);
  });

  it("questionBlueprintOutput 拒绝空维度与坏 dimId", () => {
    expect(
      questionBlueprintOutputSchema.safeParse({ questionId: "q_1h1l5dkw2qdr", dimensions: [] }).success,
    ).toBe(false);
    expect(
      questionBlueprintOutputSchema.safeParse({
        questionId: "q_1h1l5dkw2qdr",
        dimensions: [{ dimId: "Bad Id!", dimZh: "专业", dimEn: "major" }],
      }).success,
    ).toBe(false);
  });

  it("chunkCandidate 输出：noNewUnit 或 chunks 至少其一", () => {
    const ok = chunkCandidateBatchOutputSchema.safeParse({
      items: [
        {
          unitKey: "u1",
          chunks: [
            {
              displayChunk: "do an internship",
              unitType: "lexical_chunk",
              meaningZh: "参加实习",
              englishGloss: "to work as an intern for a period of time",
              exampleEn: "I'm hoping to do an internship during my summer break.",
              exampleZh: "我希望暑假期间去实习。",
              difficulty: "intermediate",
              variants: [],
              tags: ["work"],
            },
          ],
        },
        { unitKey: "u2", chunks: [], noNewUnitReason: "纯应答词，无学习价值" },
      ],
    });
    expect(ok.success).toBe(true);
  });

  it("chunkCandidate 拒绝非法 unitType", () => {
    expect(
      chunkCandidateBatchOutputSchema.safeParse({
        items: [
          {
            unitKey: "u1",
            chunks: [
              {
                displayChunk: "x",
                unitType: "sentence",
                meaningZh: "x",
                englishGloss: "x",
                exampleEn: "xxxx",
                exampleZh: "x",
                difficulty: "basic",
              },
            ],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("dedup / quality 输出结构", () => {
    expect(
      dedupBatchOutputSchema.safeParse({
        verdicts: [{ pairKey: "p1", verdict: "separate", reason: "get 与 do 表达不同阶段" }],
      }).success,
    ).toBe(true);
    expect(
      qualityBatchOutputSchema.safeParse({
        reviewer: {
          role: "independent_reviewer",
          provider: "test-provider",
          model: "review-model",
          runId: "run-0001",
        },
        verdicts: [{ chunkId: "c_abcdef123456", verdict: "approved", reason: "自然口语" }],
      }).success,
    ).toBe(true);
    expect(
      qualityBatchOutputSchema.safeParse({
        verdicts: [{ chunkId: "c_abcdef123456", verdict: "approved", reason: "自然口语" }],
      }).success,
    ).toBe(false);
    expect(
      contentEnrichmentBatchOutputSchema.safeParse({
        items: [
          {
            chunkId: "c_abcdef123456",
            englishGloss: "to take part in a planned activity",
            exampleTranslations: [{ exampleId: "ce_abcdef123456", textZh: "我参加了这项活动。" }],
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      pronunciationEnrichmentBatchOutputSchema.safeParse({
        items: [{ chunkId: "c_abcdef123456", ipa: "/teɪk pɑːt/", accent: "en-GB" }],
      }).success,
    ).toBe(true);
    expect(
      topicDomainsOutputSchema.safeParse({
        topicId: "t1_ab12cd34",
        domains: [{ domainId: "location", nameZh: "位置", nameEn: "location" }],
      }).success,
    ).toBe(false); // domains 最少 4 个
  });
});
