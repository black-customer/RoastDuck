import { describe, expect, it } from "vitest";
import { gapCandidateSchema } from "../src/lib/answers/gap-contract";
import { validateGapBatch } from "../src/lib/imports/personal-gap-batch";
import { personalGapFixture } from "./helpers/personal-gap-fixture";

describe("离线个人 Gap 契约", () => {
  it("完整独立审核可用，保留偏移与聚类，不提前发布 Chunk", () => {
    const f = personalGapFixture();
    expect(f.validate().review.answers[0].items).toHaveLength(2);
  });
  it("Runtime / 离线共用七类定义，非表达不得制卡，不确定项不得猜正确表达", () => {
    const gap = personalGapFixture().generated.answers[0].candidates[0].gap;
    for (const type of ["asr_uncertain", "pronunciation_unknown", "discourse_gap", "question_understanding", "content_gap"]) {
      expect(gapCandidateSchema.safeParse({ ...gap, gapType: type }).success).toBe(false);
    }
    expect(gapCandidateSchema.safeParse({ ...gap, gapType: "pronunciation_unknown", learningFit: false, recommendedExpression: "" }).success).toBe(true);
    expect(gapCandidateSchema.safeParse({ ...gap, gapType: "asr_uncertain", learningFit: false }).success).toBe(false);
  });
  it("同一上下文或同一 runId 拒绝", () => {
    const f = personalGapFixture(); f.review.sessionId = f.generated.sessionId;
    expect(f.validate).toThrow(/独立/);
    f.review.sessionId = "other"; f.review.runId = f.generated.runId;
    expect(f.validate).toThrow(/独立/);
  });
  it("修改输入、Prompt、Generator 文件后旧 Reviewer 失效", () => {
    const f = personalGapFixture(), texts = f.serialize();
    expect(() => validateGapBatch(f.input, texts.generationText + " ", texts.reviewText, texts.inputText)).toThrow(/当前 Generator/);
    f.review.promptSha256 = "a".repeat(64);
    expect(f.validate).toThrow(/哈希/);
  });
  it("缺少回答或候选裁决、重复 key 都阻断", () => {
    const f = personalGapFixture(); f.review.answers[0].items.pop();
    expect(f.validate).toThrow(/完整覆盖/);
    const duplicate = personalGapFixture(); duplicate.generated.answers[0].candidates.push(duplicate.generated.answers[0].candidates[0]);
    expect(duplicate.validate).toThrow(/重复/);
  });
  it("原文覆盖不能漏字、重叠、未分类或假引用", () => {
    for (const bad of ["hole", "overlap", "unclassified", "missing-key"] as const) {
      const f = personalGapFixture(), c = f.review.answers[0].coverage;
      if (bad === "hole") c[1].start += 1;
      if (bad === "overlap") c[1].start -= 1;
      if (bad === "unclassified") c[1].status = "unclassified";
      if (bad === "missing-key") c[1].gapKeys = ["not-a-gap"];
      expect(f.validate).toThrow();
    }
  });
  it("润色后的证据、错偏移、没有当前证据的理由都拒绝", () => {
    const f = personalGapFixture(); f.review.answers[0].items[0].candidate.start += 1;
    expect(f.validate).toThrow(/偏移/);
    const quote = personalGapFixture(); quote.review.answers[0].items[0].evidenceQuote = "fabricated";
    expect(quote.validate).toThrow(/引用/);
  });
  it("不能暗改 approved、伪造 edited 或整批全部零修改", () => {
    const hidden = personalGapFixture(); hidden.review.answers[0].items[0].verdict = "approved";
    expect(hidden.validate).toThrow(/edited/);
    const fake = personalGapFixture(); fake.review.answers[0].items[1].verdict = "edited";
    expect(fake.validate).toThrow(/零改动/);
    const all = personalGapFixture(); all.review.answers[0].items[0].candidate = structuredClone(all.generated.answers[0].candidates[0]); all.review.answers[0].items[0].verdict = "approved";
    expect(all.validate).toThrow(/整批全量零修改/);
  });
  it("Reviewer 报告遗漏会阻断，拒绝项不能留在覆盖里", () => {
    const f = personalGapFixture(); f.review.answers[0].coverageDecision = "needs_revision";
    expect(f.validate).toThrow(/遗漏/);
    const rejected = personalGapFixture(); rejected.review.answers[0].items[0].verdict = "rejected";
    expect(rejected.validate).toThrow(/不存在/);
  });
});
