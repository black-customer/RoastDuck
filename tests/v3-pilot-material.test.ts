import { describe, expect, it } from "vitest";
import {
  V3_PILOT_VERSION,
  validateV3PilotArtifacts,
  v3PilotHash,
  type V3PilotMaterial,
} from "../src/lib/imports/v3-pilot-material";

function fixture() {
  const prompt = (version: string) => ({ version, sha256: v3PilotHash(version) });
  const selected = Array.from({ length: 10 }, (_, index) => ({
    gapId: `gap-${index}`, answerId: `answer-${index}`, answerVersionId: `version-${index}`, questionId: `question-${index}`,
    gapType: "grammar_construction" as const, clusterId: `cluster-${index}`, evidenceSha256: v3PilotHash(`evidence-${index}`),
    intentZh: "表达正在取得进步", recommendedExpression: "make progress", explanationZh: "使用固定搭配表达逐渐取得进步。",
    impactLevel: "medium" as const, diagnosisReviewerRunId: "diagnosis-reviewer",
  }));
  const input = {
    schemaVersion: V3_PILOT_VERSION, pilotId: "pilot-fixture", sourceBatchId: "batch-fixture", sourceReviewSha256: v3PilotHash("source-review"),
    prompts: { generator: prompt("generator-v1"), materialReviewer: prompt("material-reviewer-v1"), scenarioReviewer: prompt("scenario-reviewer-v1") }, selected,
  };
  const glossary = ["make", "progress", "used", "for", "steady", "change", "in", "topic", "i", "english", "how", "is", "your", "work", "going", "am", "making", "today", "are", "you", "improving"]
    .map((surface) => ({ surface, meaningZh: `释义-${surface}`, ipa: "/test/" }));
  const material = (index: number): V3PilotMaterial => ({
    gapId: `gap-${index}`, answerId: `answer-${index}`, questionId: `question-${index}`, evidenceSha256: selected[index].evidenceSha256,
    canonicalChunk: `make progress ${index}`, displayChunk: `make progress ${index}`, unitType: "lexical_chunk", meaningZh: "取得进步",
    englishGloss: "used for steady change", pattern: "make progress in topic", ipa: "/meɪk ˈprɑːɡres/",
    example: { en: "I make progress in English.", zh: "我的英语取得进步。" },
    commonUsage: { settingZh: "同事在办公室聊工作进度", relationshipZh: "同事", purposeZh: "说明工作正在推进", register: "casual", accent: "en-US", targetSurface: "making progress", lines: [
      { speaker: "A", en: "How is your work going?", zh: "工作进展如何？", target: false },
      { speaker: "B", en: "I am making progress today.", zh: "我今天有进展。", target: true },
    ] },
    questionRepair: { settingZh: "老师询问英语学习进度", relationshipZh: "老师与学生", purposeZh: "说明英语有所提升", register: "neutral", accent: "en-US", targetSurface: "making progress", lines: [
      { speaker: "Teacher", en: "Are you improving?", zh: "你有进步吗？", target: false },
      { speaker: "Student", en: "I am making progress in English.", zh: "我的英语正在进步。", target: true },
    ] }, glossary,
  });
  const inputText = JSON.stringify(input);
  const inputSha256 = v3PilotHash(inputText);
  const generation = { schemaVersion: V3_PILOT_VERSION, role: "material_generator", runId: "generator-run", sessionId: "generator-session", model: "development-agent", inputSha256, promptVersion: input.prompts.generator.version, promptSha256: input.prompts.generator.sha256, noExternalRuntimeApi: true, networkCalls: 0, items: selected.map((_, index) => material(index)) };
  const generationText = JSON.stringify(generation);
  const materialReview = { schemaVersion: V3_PILOT_VERSION, role: "material_reviewer", runId: "material-review-run", sessionId: "material-review-session", model: "development-agent", inputSha256, promptVersion: input.prompts.materialReviewer.version, promptSha256: input.prompts.materialReviewer.sha256, noExternalRuntimeApi: true, networkCalls: 0, generationSha256: v3PilotHash(generationText), items: generation.items.map((item, index) => ({ gapId: item.gapId, evidenceSha256: item.evidenceSha256, decision: index === 0 ? "edited" : "approved", reason: `逐项核对材料 ${index} 的原意、粒度、IPA 和示例。`, material: index === 0 ? { ...item, meaningZh: "逐步取得进展" } : structuredClone(item) })) };
  const scenarioReview = { schemaVersion: V3_PILOT_VERSION, role: "scenario_reviewer", runId: "scenario-review-run", sessionId: "scenario-review-session", model: "development-agent", inputSha256, promptVersion: input.prompts.scenarioReviewer.version, promptSha256: input.prompts.scenarioReviewer.sha256, noExternalRuntimeApi: true, networkCalls: 0, materialReviewSha256: "", items: materialReview.items.flatMap((reviewed, index) => (["common_usage", "question_repair"] as const).map((kind) => {
    const source = reviewed.material![kind === "common_usage" ? "commonUsage" : "questionRepair"];
    return { gapId: reviewed.gapId, kind, decision: index === 0 && kind === "common_usage" ? "edited" : "approved", reason: `逐句核对语境 ${index}-${kind} 的人物、目的和目标句。`, scenario: index === 0 && kind === "common_usage" ? { ...source, purposeZh: "自然说明今天工作有所推进" } : structuredClone(source) };
  })) };
  const serialize = () => {
    const materialReviewText = JSON.stringify(materialReview);
    scenarioReview.materialReviewSha256 = v3PilotHash(materialReviewText);
    return { inputText, generationText, materialReviewText, scenarioReviewText: JSON.stringify(scenarioReview) };
  };
  return { input, generation, materialReview, scenarioReview, serialize };
}

describe("V3 首批个人学习材料契约", () => {
  it("要求 10 项、三段独立证据、双语境和逐词注解覆盖", () => {
    const f = fixture();
    expect(validateV3PilotArtifacts(...Object.values(f.serialize()) as [string, string, string, string]).finalMaterials).toHaveLength(10);
  });

  it("拒绝三个角色复用上下文或审核旧产物", () => {
    const same = fixture();
    same.materialReview.sessionId = same.generation.sessionId;
    expect(() => validateV3PilotArtifacts(...Object.values(same.serialize()) as [string, string, string, string])).toThrow(/独立/);
    const stale = fixture(), texts = stale.serialize();
    stale.scenarioReview.materialReviewSha256 = "a".repeat(64);
    expect(() => validateV3PilotArtifacts(texts.inputText, texts.generationText, texts.materialReviewText, JSON.stringify(stale.scenarioReview))).toThrow(/上游/);
  });

  it("拒绝全量零修改审核和注解缺词", () => {
    const noCalibration = fixture();
    noCalibration.materialReview.items[0] = { ...noCalibration.materialReview.items[0], decision: "approved", material: structuredClone(noCalibration.generation.items[0]) };
    expect(() => validateV3PilotArtifacts(...Object.values(noCalibration.serialize()) as [string, string, string, string])).toThrow(/真实校准/);

    const missing = fixture();
    missing.materialReview.items[1].material!.glossary = missing.materialReview.items[1].material!.glossary.filter((item) => item.surface !== "improving");
    missing.materialReview.items[1].decision = "edited";
    expect(() => validateV3PilotArtifacts(...Object.values(missing.serialize()) as [string, string, string, string])).toThrow(/注解/);
  });
});
