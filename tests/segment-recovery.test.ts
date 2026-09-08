import { describe, expect, it } from "vitest";
import { sha256 } from "../src/lib/imports/personal-import";
import { segmentRecoveryFixture } from "./helpers/segment-recovery-fixture";

describe("独立切分修复契约", () => {
  it("插话不增加 attempt，原文保留而整理版本排除；重复编译 ID 不变", () => {
    const fixture = segmentRecoveryFixture(), output = fixture.compile();
    expect(output.attempts).toHaveLength(2);
    expect(output.attempts[0]).toMatchObject({ rawText: "I cook. [aside] I bake. ", normalizedText: "I cook. I bake.", excludedTypes: ["self_comment"] });
    expect(output.attempts[1].rawText).toBe("I bake daily.");
    expect(output.segments.map((s) => s.rawText).join("")).toBe(fixture.text);
    expect(fixture.compile()).toEqual(output);
  });
  it("源文本漂移、审核输入漂移都拒绝", () => {
    const f = segmentRecoveryFixture();
    f.input.inputSnapshotSha256 = sha256("changed");
    expect(f.compile).toThrow(/输入哈希/);
    f.input.inputSnapshotSha256 = f.review.inputSha256;
    f.review.sourceSnapshots[0].sha256 = sha256("changed source");
    expect(f.compile).toThrow(/源快照哈希/);
  });
  it("拒绝遗漏、越界、重复或非连续替代", () => {
    const f = segmentRecoveryFixture();
    f.review.cases[0].pieces[1].startOffset += 1;
    expect(f.compile).toThrow(/遗漏/);
    f.review.cases[0].pieces[1].startOffset -= 1;
    f.review.cases[0].replacesSegmentIds.push(f.segment.id);
    expect(f.compile).toThrow(/不连续/);
  });
  it("题目与 Part 不一致或凭空造原题时阻断", () => {
    const f = segmentRecoveryFixture();
    f.review.cases[0].pieces[0].part = 3;
    expect(f.compile).toThrow(/Part/);
    f.review.cases[0].pieces[0].part = 1;
    f.review.cases[0].pieces[0].questionTextOrigin = "source";
    f.review.cases[0].pieces[0].questionText = "Invented question?";
    expect(f.compile).toThrow(/未出现在源文本/);
  });
  it("疑似 ASR 独立留存，不作为正式回答片段拼接", () => {
    const f = segmentRecoveryFixture();
    f.review.cases[0].pieces[1].type = "asr_uncertain";
    expect(f.compile().attempts[0]).toMatchObject({ normalizedText: "I cook. I bake.", excludedTypes: ["asr_uncertain"] });
    expect(f.compile().segments[1].rawText).toBe("[aside] ");
  });
  it("缺失问句保留中文描述与 Part 标签，不补写英文", () => {
    const f = segmentRecoveryFixture();
    f.input.questions = [];
    for (const p of f.review.cases[0].pieces) {
      if (!p.questionId) continue;
      p.questionId = null; p.part = 3; p.questionText = "Part 3 原问句缺失：烹饪与文化";
    }
    const output = f.compile();
    expect(output.attempts[0].questionId).toMatch(/^q_personal_/);
    expect(output.attempts[0].questionId).toBe(output.attempts[1].questionId);
  });
  it("不允许跨指令或换题合并回答；未分类/待确认阻断", () => {
    const f = segmentRecoveryFixture();
    f.review.cases[0].pieces[4].answerGroupKey = "initial";
    expect(f.compile).toThrow(/跨越/);
    f.review.cases[0].pieces[4].answerGroupKey = "retry";
    f.review.cases[0].pieces[1].type = "unclassified";
    expect(f.compile).toThrow(/未分类/);
    f.review.cases[0].decision = "needs_attention";
    expect(f.compile).toThrow(/待确认/);
  });
});
