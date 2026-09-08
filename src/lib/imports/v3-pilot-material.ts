import { createHash } from "node:crypto";
import { z } from "zod";

export const V3_PILOT_VERSION = "v3-pilot-material-v1";
export const V3_PILOT_EXPERIMENT = "gap_retrieval_v3";
export const v3PilotHash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export const v3PilotId = (prefix: string, ...values: string[]) => `${prefix}_${v3PilotHash(values.join("\u001f")).slice(0, 24)}`;

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().min(2).max(180);
const prompt = z.object({ version: id, sha256: hash });
const offlineRun = z.object({
  runId: id,
  sessionId: id,
  model: z.literal("development-agent"),
  inputSha256: hash,
  promptVersion: id,
  promptSha256: hash,
  noExternalRuntimeApi: z.literal(true),
  networkCalls: z.literal(0),
});

export const v3PilotInputSchema = z.object({
  schemaVersion: z.literal(V3_PILOT_VERSION),
  pilotId: id,
  sourceBatchId: id,
  sourceReviewSha256: hash,
  prompts: z.object({ generator: prompt, materialReviewer: prompt, scenarioReviewer: prompt }),
  selected: z.array(z.object({
    gapId: id,
    answerId: id,
    answerVersionId: id,
    questionId: id,
    gapType: z.enum(["lexical_gap", "grammar_construction"]),
    clusterId: id,
    evidenceSha256: hash,
    intentZh: z.string().min(2),
    recommendedExpression: z.string().min(1),
    explanationZh: z.string().min(8),
    impactLevel: z.enum(["high", "medium", "low"]),
    diagnosisReviewerRunId: id,
  })).length(10),
});
export type V3PilotInput = z.infer<typeof v3PilotInputSchema>;

const lineSchema = z.object({
  speaker: z.string().min(1).max(40),
  en: z.string().min(2).max(500),
  zh: z.string().min(1).max(500),
  target: z.boolean(),
});

export const v3PilotScenarioSchema = z.object({
  settingZh: z.string().min(4).max(300),
  relationshipZh: z.string().min(2).max(120),
  purposeZh: z.string().min(4).max(300),
  register: z.enum(["casual", "neutral", "formal"]),
  accent: z.literal("en-US"),
  targetSurface: z.string().min(1).max(180),
  lines: z.array(lineSchema).min(2).max(4),
}).superRefine((value, context) => {
  const targets = value.lines.filter((line) => line.target);
  if (targets.length !== 1) context.addIssue({ code: "custom", message: "每个语境必须且只能有一个目标句" });
  if (targets[0] && !targets[0].en.toLowerCase().includes(value.targetSurface.toLowerCase())) {
    context.addIssue({ code: "custom", message: "目标句没有包含 targetSurface" });
  }
});
export type V3PilotScenario = z.infer<typeof v3PilotScenarioSchema>;

const glossaryEntrySchema = z.object({
  surface: z.string().regex(/^[A-Za-z]+(?:['’][A-Za-z]+)?$/),
  meaningZh: z.string().min(1).max(120),
  ipa: z.string().max(160),
});

export const v3PilotMaterialSchema = z.object({
  gapId: id,
  answerId: id,
  questionId: id,
  evidenceSha256: hash,
  canonicalChunk: z.string().min(1).max(180),
  displayChunk: z.string().min(1).max(180),
  unitType: z.enum(["lexical_chunk", "construction", "functional_expression"]),
  meaningZh: z.string().min(2).max(300),
  englishGloss: z.string().min(3).max(500),
  pattern: z.string().min(3).max(300),
  ipa: z.string().min(2).max(300),
  example: z.object({ en: z.string().min(3).max(500), zh: z.string().min(2).max(500) }),
  commonUsage: v3PilotScenarioSchema,
  questionRepair: v3PilotScenarioSchema,
  glossary: z.array(glossaryEntrySchema).min(1).max(180),
});
export type V3PilotMaterial = z.infer<typeof v3PilotMaterialSchema>;

export const v3PilotGenerationSchema = z.object({
  schemaVersion: z.literal(V3_PILOT_VERSION),
  role: z.literal("material_generator"),
  ...offlineRun.shape,
  items: z.array(v3PilotMaterialSchema).length(10),
});

export const v3PilotMaterialReviewSchema = z.object({
  schemaVersion: z.literal(V3_PILOT_VERSION),
  role: z.literal("material_reviewer"),
  ...offlineRun.shape,
  generationSha256: hash,
  items: z.array(z.object({
    gapId: id,
    evidenceSha256: hash,
    decision: z.enum(["approved", "edited", "rejected"]),
    reason: z.string().min(12).max(1500),
    material: v3PilotMaterialSchema.nullable(),
  })).length(10),
});

export const v3PilotScenarioReviewSchema = z.object({
  schemaVersion: z.literal(V3_PILOT_VERSION),
  role: z.literal("scenario_reviewer"),
  ...offlineRun.shape,
  materialReviewSha256: hash,
  items: z.array(z.object({
    gapId: id,
    kind: z.enum(["common_usage", "question_repair"]),
    decision: z.enum(["approved", "edited", "rejected"]),
    reason: z.string().min(12).max(1500),
    scenario: v3PilotScenarioSchema.nullable(),
  })).length(20),
});

function sameKeys(actual: string[], expected: string[], label: string) {
  if (new Set(actual).size !== actual.length || actual.length !== expected.length || expected.some((key) => !actual.includes(key))) {
    throw new Error(`${label} 没有完整、唯一地覆盖试验项`);
  }
}

const normalizeWord = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[’]/g, "'");
const englishWords = (value: string) => [...value.matchAll(/[A-Za-z]+(?:['’][A-Za-z]+)?/g)].map((match) => normalizeWord(match[0]));

export function assertV3PilotCoverage(material: V3PilotMaterial) {
  if (v3PilotHash(JSON.stringify(material.commonUsage)) === v3PilotHash(JSON.stringify(material.questionRepair))) {
    throw new Error("常见语境与原题修复语境不能重复");
  }
  const glossary = new Map(material.glossary.map((item) => [normalizeWord(item.surface), item]));
  if (glossary.size !== material.glossary.length) throw new Error("词汇表存在大小写归一后的重复项");
  const texts = [
    material.canonicalChunk,
    material.displayChunk,
    material.englishGloss,
    material.pattern,
    material.example.en,
    ...material.commonUsage.lines.map((line) => line.en),
    ...material.questionRepair.lines.map((line) => line.en),
  ];
  const missing = [...new Set(texts.flatMap(englishWords).filter((word) => !glossary.has(word)))];
  if (missing.length) throw new Error(`英文点击注解缺少 ${missing.length} 个词项`);
}

export function validateV3PilotArtifacts(inputText: string, generationText: string, materialReviewText: string, scenarioReviewText: string) {
  const input = v3PilotInputSchema.parse(JSON.parse(inputText));
  const generation = v3PilotGenerationSchema.parse(JSON.parse(generationText));
  const materialReview = v3PilotMaterialReviewSchema.parse(JSON.parse(materialReviewText));
  const scenarioReview = v3PilotScenarioReviewSchema.parse(JSON.parse(scenarioReviewText));
  const inputSha256 = v3PilotHash(inputText);
  const generationSha256 = v3PilotHash(generationText);
  const materialReviewSha256 = v3PilotHash(materialReviewText);
  const expectedGapIds = input.selected.map((item) => item.gapId);

  const runPromptPairs = [
    [generation, input.prompts.generator],
    [materialReview, input.prompts.materialReviewer],
    [scenarioReview, input.prompts.scenarioReviewer],
  ] as const;
  for (const [run, expectedPrompt] of runPromptPairs) {
    if (run.inputSha256 !== inputSha256 || run.promptVersion !== expectedPrompt.version || run.promptSha256 !== expectedPrompt.sha256) {
      throw new Error("离线运行的输入或 Prompt 版本发生漂移");
    }
  }
  const identities = runPromptPairs.map(([run]) => `${run.runId}\u001f${run.sessionId}`);
  if (new Set(identities).size !== identities.length || new Set(runPromptPairs.map(([run]) => run.runId)).size !== identities.length || new Set(runPromptPairs.map(([run]) => run.sessionId)).size !== identities.length) {
    throw new Error("Generator、材料 Reviewer 与语境 Reviewer 必须使用独立 run/session");
  }
  if (materialReview.generationSha256 !== generationSha256 || scenarioReview.materialReviewSha256 !== materialReviewSha256) {
    throw new Error("Reviewer 没有审核当前上游产物");
  }
  sameKeys(generation.items.map((item) => item.gapId), expectedGapIds, "Generator");
  sameKeys(materialReview.items.map((item) => item.gapId), expectedGapIds, "材料 Reviewer");

  const reviewedMaterials: V3PilotMaterial[] = [];
  let materialChanges = 0;
  const materialReasons: string[] = [];
  for (const selected of input.selected) {
    const generated = generation.items.find((item) => item.gapId === selected.gapId)!;
    const review = materialReview.items.find((item) => item.gapId === selected.gapId)!;
    if (generated.answerId !== selected.answerId || generated.questionId !== selected.questionId || generated.evidenceSha256 !== selected.evidenceSha256 || review.evidenceSha256 !== selected.evidenceSha256) {
      throw new Error("学习材料与当前 Gap 证据不一致");
    }
    const unchanged = review.material && JSON.stringify(review.material) === JSON.stringify(generated);
    if (review.decision === "approved" && !unchanged) throw new Error("approved 材料不得被修改或留空");
    if (review.decision === "edited" && (!review.material || unchanged)) throw new Error("edited 材料必须包含真实修订");
    if (review.decision === "rejected" && review.material) throw new Error("rejected 材料不得继续携带发布内容");
    if (review.decision !== "approved") materialChanges += 1;
    materialReasons.push(review.reason.replace(/\s+/g, ""));
    if (review.material) reviewedMaterials.push(review.material);
  }
  if (!materialChanges || new Set(materialReasons).size !== materialReasons.length) throw new Error("材料 Reviewer 必须包含真实校准且理由不能套用");

  const expectedScenarios = reviewedMaterials.flatMap((item) => (["common_usage", "question_repair"] as const).map((kind) => `${item.gapId}:${kind}`));
  sameKeys(scenarioReview.items.map((item) => `${item.gapId}:${item.kind}`), expectedScenarios, "语境 Reviewer");
  let scenarioChanges = 0;
  const scenarioReasons: string[] = [];
  const finalMaterials: V3PilotMaterial[] = [];
  for (const material of reviewedMaterials) {
    let rejected = false;
    const final = structuredClone(material);
    for (const kind of ["common_usage", "question_repair"] as const) {
      const review = scenarioReview.items.find((item) => item.gapId === material.gapId && item.kind === kind)!;
      const original = kind === "common_usage" ? material.commonUsage : material.questionRepair;
      const unchanged = review.scenario && JSON.stringify(review.scenario) === JSON.stringify(original);
      if (review.decision === "approved" && !unchanged) throw new Error("approved 语境不得被修改或留空");
      if (review.decision === "edited" && (!review.scenario || unchanged)) throw new Error("edited 语境必须包含真实修订");
      if (review.decision === "rejected" && review.scenario) throw new Error("rejected 语境不得继续携带发布内容");
      if (review.decision !== "approved") scenarioChanges += 1;
      scenarioReasons.push(review.reason.replace(/\s+/g, ""));
      if (!review.scenario) rejected = true;
      else if (kind === "common_usage") final.commonUsage = review.scenario;
      else final.questionRepair = review.scenario;
    }
    if (!rejected) {
      assertV3PilotCoverage(final);
      finalMaterials.push(final);
    }
  }
  if (!scenarioChanges || new Set(scenarioReasons).size !== scenarioReasons.length) throw new Error("语境 Reviewer 必须包含真实校准且理由不能套用");
  if (finalMaterials.length < 10) throw new Error("V3 首批完整可学材料不足 10 项");

  const canonical = finalMaterials.map((item) => item.canonicalChunk.normalize("NFKC").toLowerCase().trim());
  if (new Set(canonical).size !== canonical.length) throw new Error("V3 首批学习单位去重后不足 10 项");
  return { input, generation, materialReview, scenarioReview, finalMaterials, inputSha256, generationSha256, materialReviewSha256, scenarioReviewSha256: v3PilotHash(scenarioReviewText) };
}
