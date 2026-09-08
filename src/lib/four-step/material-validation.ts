import { speakingAttemptAnalysisSchema, type SpeakingAttemptAnalysis } from "@/lib/speaking-practice/schemas";
import { buildTasks, normalizeExpression } from "./contracts";
import { compileEvidence } from "./selection-contracts";
import { TrainingError } from "./shared";
import type { MaterialInput } from "./material-types";

export function validateMaterial(analysis: SpeakingAttemptAnalysis, source?: MaterialInput) {
  if (analysis.contractVersion === "evidence_v2") {
    if (!analysis.evidence || !source) throw new TrainingError("材料证据链缺失",422,"material_missing_evidence");
    const compiled = speakingAttemptAnalysisSchema.parse(compileEvidence(source,analysis.evidence));
    if (JSON.stringify(compiled)!==JSON.stringify(speakingAttemptAnalysisSchema.parse(analysis))) throw new TrainingError("四列材料与审核证据不一致",422,"material_evidence_drift");
  }
  if (analysis.gapCount !== analysis.gaps.length) throw new TrainingError("问题数与账本不一致", 422, "material_coverage");
  if (!analysis.gaps.length) {
    if (analysis.learningItems.length) throw new TrainingError("没有确认问题却生成必练项", 422, "material_coverage");
    return;
  }
  const rows = analysis.learningMaterials;
  if (analysis.learningItems.length && !rows.length) throw new TrainingError("四列材料尚不完整", 422, "material_coverage");
  for (const item of analysis.learningItems) {
    if (!analysis.gaps.some((g) => normalizeExpression(g.targetEnglish) === normalizeExpression(item.targetEnglish) && ["lexical_gap", "grammar_gap", "unexpressed_intention"].includes(g.gapType))) throw new TrainingError("必练项缺少可确认的表达问题证据", 422, "material_gap_evidence");
    if (!rows.some((r) => normalizeExpression(r.englishChunk) === normalizeExpression(item.targetEnglish))) throw new TrainingError("必练表达没有对应材料行", 422, "material_coverage");
  }
  for (const row of rows) {
    if (!analysis.learningItems.some((i) => normalizeExpression(i.targetEnglish) === normalizeExpression(row.englishChunk)) || !analysis.naturalVersion.includes(row.naturalEnglishSentence)) {
      throw new TrainingError("材料行与回答全文不对应", 422, "material_alignment");
    }
  }
  if (rows.length && buildTasks(rows, analysis.naturalVersion, "")[2].length !== rows.length) throw new TrainingError("部分表达无法在全文准确挖空", 422, "material_cloze_span");
}
