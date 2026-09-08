import { describe, expect, it } from "vitest";
import {
  detectInputLanguage,
  matchQuestion,
  normalizeForMatch,
  normalizeTranscript,
  PersonalReviewCheckpointSchema,
  segmentTranscript,
  sha256,
  splitAnswerSentences,
  stableId,
  type QuestionForMatch,
} from "../src/lib/imports/personal-import";

const questions: QuestionForMatch[] = [
  { id: "q1", text: "Do you like science?", normText: "do you like science", part: 1, topicId: "t1" },
  { id: "q2", text: "Do you think technology has changed our lives?", normText: "do you think technology has changed our lives", part: 3, topicId: "t2" },
  { id: "q3", text: "Do you wear a watch?", normText: "do you wear a watch", part: 1, topicId: "t3" },
];

describe("personal import parser", () => {
  it("规范化题目但保留语义词序", () => {
    expect(normalizeForMatch("  Do you LIKE science?! ")).toBe("do you like science");
  });

  it("支持精确匹配", () => {
    expect(matchQuestion("Do you like science?", questions, [])).toMatchObject({ questionId: "q1", method: "exact", confidence: 1 });
  });

  it("支持已知别名匹配", () => {
    expect(matchQuestion("Has tech changed daily life?", questions, [{
      questionId: "q2",
      aliasText: "Has tech changed daily life?",
      normalizedAlias: "has tech changed daily life",
    }])).toMatchObject({ questionId: "q2", method: "alias" });
  });

  it("只有高置信且有候选差距时才模糊匹配", () => {
    expect(matchQuestion("Do you think technology has changed our life?", questions, [])).toMatchObject({ questionId: "q2", method: "fuzzy" });
  });

  it("低置信题目进入 personal_import 而不强绑", () => {
    expect(matchQuestion("Why do artists change society?", questions, [])).toMatchObject({ questionId: null, method: "personal_import" });
  });

  it("连续文本切分覆盖每一个源字符", () => {
    const source = "The first question is Do you like science? Yes, but I didn't get good grades. The next question is Do you wear a watch? Yes.";
    const segments = segmentTranscript("imp_test", source, questions, []);
    expect(segments.map((segment) => segment.rawText).join("")).toBe(source);
    expect(segments.filter((segment) => segment.type === "question")).toHaveLength(2);
    expect(segments.some((segment) => segment.type === "answer")).toBe(true);
  });

  it("同题再次出现时保留 retry_answer", () => {
    const source = "Do you like science? Yes. Do you like science? Let me answer again: yes, I do.";
    const segments = segmentTranscript("imp_retry", source, questions, []);
    expect(segments.some((segment) => segment.type === "retry_answer")).toBe(true);
  });

  it("AI 指令不会被归为正式回答", () => {
    const source = "Do you like science? Please give me a score and correct my answer. Do you wear a watch? Yes.";
    const segments = segmentTranscript("imp_instruction", source, questions, []);
    expect(segments.some((segment) => segment.type === "self_comment" || segment.type === "instruction")).toBe(true);
  });

  it("临场换题片段标记 abandoned", () => {
    const source = "Do you like science? I don't have an idea. Let's change the question. Do you wear a watch? Yes.";
    const segments = segmentTranscript("imp_abandoned", source, questions, []);
    expect(segments.some((segment) => segment.type === "abandoned")).toBe(true);
  });

  it("缺少开场题目的长回答使用个人题目而不丢弃", () => {
    const source = "I study computer science because I enjoy building useful things, and I have spent several years learning how software works. Do you like science? Yes.";
    const segments = segmentTranscript("imp_opening", source, questions, []);
    expect(segments[0]).toMatchObject({ type: "answer", matchMethod: "personal_import" });
    expect(segments[0].questionId).toMatch(/^q_personal_/);
  });

  it("审核检查点拒绝同一 Generator 与 Reviewer 会话", () => {
    const digest = sha256("checkpoint");
    const parsed = PersonalReviewCheckpointSchema.safeParse({
      version: "personal-review-checkpoint-v2",
      importId: "imp_test",
      inputSnapshotSha256: digest,
      counts: { approved: 0, edited: 0, rejected: 1 },
      verdicts: [{
        gapId: "gap_test",
        ruleId: "deterministic_prefilter",
        sourceSegmentId: "seg_test",
        startOffset: 0,
        endOffset: 4,
        evidenceSha256: sha256("test"),
        decision: "rejected",
        disposition: "drop",
        reason: "规则只能生成候选，不能批准发布。",
        candidate: null,
        generator: {
          runId: "same-run",
          sessionId: "same-session",
          promptVersion: "generator-v2",
          schemaVersion: "personal-import-v2",
          inputSha256: digest,
          outputSha256: digest,
        },
        gapReviewer: {
          runId: "same-run",
          sessionId: "same-session",
          promptVersion: "reviewer-v2",
          schemaVersion: "personal-import-v2",
          inputSha256: digest,
          outputSha256: digest,
        },
        scenarioReviewers: [],
      }],
    });
    expect(parsed.success).toBe(false);
  });

  it("只修复空白与标点，不改写英语水平", () => {
    expect(normalizeTranscript("people is  nice.I think")).toBe("people is nice. I think");
  });

  it("输入语言识别支持中文、英文和混合", () => {
    expect(detectInputLanguage("我想表达这个意思")).toBe("zh");
    expect(detectInputLanguage("I want to explain this.")).toBe("en");
    expect(detectInputLanguage("I think 这个很重要")).toBe("mixed");
  });

  it("句子切分和稳定 ID 可重复", () => {
    expect(splitAnswerSentences("First. Second?")).toEqual(["First.", "Second?"]);
    expect(stableId("x", "same")).toBe(stableId("x", "same"));
  });
});
