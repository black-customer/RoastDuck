import { GAP_BATCH_VERSION, gapHash, validateGapBatch, type GapBatchInput, type GapBatchGeneration, type GapBatchReview } from "../../src/lib/imports/personal-gap-batch";

/** 完全虚构文本，禁止从私人材料复制到 Git 测试。 */
export function personalGapFixture(suffix = "fixture") {
  const rawText = "I very like my city. I haven't saw that.";
  const input: GapBatchInput = {
    schemaVersion: GAP_BATCH_VERSION, batchId: `batch-${suffix}`,
    prompts: { generator: { version: "generator-v1", sha256: gapHash("generator") }, reviewer: { version: "reviewer-v1", sha256: gapHash("reviewer") } },
    answers: [{ answerId: `answer-${suffix}`, answerVersionId: `version-${suffix}`, questionId: `question-${suffix}`,
      question: { textEn: "Do you like this city?", textZh: "喜欢这个城市吗？", part: 1 }, rawText, rawSha256: gapHash(rawText), normalizedText: rawText, versionSha256: gapHash(JSON.stringify([rawText, ""])),
      source: { importId: `import-${suffix}`, revisionId: null, segmentId: `segment-${suffix}`, startOffset: 0, endOffset: rawText.length, textSha256: gapHash(rawText) } }],
  };
  const generated: GapBatchGeneration = {
    schemaVersion: GAP_BATCH_VERSION, role: "gap_generator", runId: `generator-${suffix}`, sessionId: "fixture-generator", model: "development-agent",
    inputSha256: "", promptVersion: input.prompts.generator.version, promptSha256: input.prompts.generator.sha256, noExternalRuntimeApi: true, networkCalls: 0,
    answers: [{ answerId: input.answers[0].answerId, candidates: [
      { start: 2, end: 11, clusterKey: "degree_modifier", clusterTitleZh: "程度修饰",
        gap: { key: "degree", gapType: "lexical_gap", evidenceText: "very like", intentZh: "很喜欢", recommendedExpression: "really like", explanationZh: "用 really 修饰 like", confidence: 0.8, impactLevel: "medium", learningFit: true } },
      { start: 22, end: 33, clusterKey: "perfect_participle", clusterTitleZh: "过去分词",
        gap: { key: "participle", gapType: "grammar_construction", evidenceText: "haven't saw", intentZh: "没见过", recommendedExpression: "haven't seen", explanationZh: "完成时用 seen", confidence: 1, impactLevel: "medium", learningFit: true } },
    ], coverage: [
      { start: 0, end: 20, status: "diagnosed", gapKeys: ["degree"], reason: "第一句程度修饰词搭配不正确。" },
      { start: 20, end: rawText.length, status: "diagnosed", gapKeys: ["participle"], reason: "第二句完成时的过去分词错误。" },
    ] }],
  };
  // 保持精确定位，避免测试本身依赖手算偏移。
  for (const c of generated.answers[0].candidates) { c.start = rawText.indexOf(c.gap.evidenceText); c.end = c.start + c.gap.evidenceText.length; }
  const review: GapBatchReview = {
    schemaVersion: GAP_BATCH_VERSION, role: "gap_reviewer", runId: `reviewer-${suffix}`, sessionId: "fixture-reviewer", model: "development-agent",
    inputSha256: "", generationSha256: "", promptVersion: input.prompts.reviewer.version, promptSha256: input.prompts.reviewer.sha256, noExternalRuntimeApi: true, networkCalls: 0,
    answers: [{ answerId: input.answers[0].answerId, coverage: structuredClone(generated.answers[0].coverage), coverageDecision: "complete", coverageReason: "逐句审核了所有文本，未发现其他确认的问题。",
      items: generated.answers[0].candidates.map((c, i) => ({ key: c.gap.key, verdict: i === 0 ? "edited" : "approved", evidenceQuote: c.gap.evidenceText,
        reason: i === 0 ? "very like 的搭配问题明确，调高可确认程度，保留原意。" : "haven't saw 里的 saw 是过去式，应在完成时使用 seen。", candidate: structuredClone(c) })) }],
  };
  review.answers[0].items[0].candidate.gap.confidence = 0.95;
  function serialize() {
    const inputText = JSON.stringify(input);
    generated.inputSha256 = review.inputSha256 = gapHash(inputText);
    const generationText = JSON.stringify(generated);
    review.generationSha256 = gapHash(generationText);
    return { inputText, generationText, reviewText: JSON.stringify(review) };
  }
  return { input, generated, review, serialize, validate: () => { const f = serialize(); return validateGapBatch(input, f.generationText, f.reviewText, f.inputText); } };
}
