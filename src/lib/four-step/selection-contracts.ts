import { z } from "zod";
import { normalizeExpression, findTargetSpan } from "./contracts";
import { TrainingError } from "./shared";

const text = z.string().trim().min(1).max(8000);
const id = z.string().trim().min(1).max(100);
const quote = z.object({ text, occurrence: z.number().int().min(0).default(0) });
export const unitStatusSchema = z.enum(["natural", "repair", "missing", "uncertain", "non_answer"]);
export const diagnosisSchema = z.object({
  units: z.array(z.object({
    id, intentZh: text, english: z.array(quote), chinese: z.array(quote), raw:z.array(quote).optional(),
    status: unitStatusSchema, reasonZh: text,
    gaps: z.array(z.object({
      id, kind: z.enum(["lexical_gap", "grammar_gap", "unexpressed_intention"]),
      cueZh: text, targetEnglish: text, acceptableVariants: z.array(text),senseKey:z.string().trim().min(1).max(100).optional(),
      evidenceQuote: text, whyNeededZh: text,
    })),
  })).min(1),
});
export type Diagnosis = z.infer<typeof diagnosisSchema>;
export const selectionReviewSchema = z.object({
  approved: z.boolean(), reasonZh: text,
  units: z.array(z.object({ unitId: id, status: unitStatusSchema, evidenceQuote: text, reasonZh: text })),
  gaps: z.array(z.object({ gapId: id, decision: z.enum(["train", "exclude", "uncertain"]), evidenceQuote: text, reasonZh: text })),
});
export type SelectionReview = z.infer<typeof selectionReviewSchema>;
export const materialDraftSchema = z.object({
  sentences: z.array(z.object({ id, intentUnitIds: z.array(id).min(1), english: text })),
  rows: z.array(z.object({ gapId: id, sentenceId: id, surfaceInSentence: text })),
  examFeedback: z.object({
    transcriptBasedNotice: text, lexicalResource:text, grammaticalRange:text, coherence:text, paraphrasing:text,
    strengths:z.array(text), weaknesses:z.array(text), approximateBand:z.string().nullable(),
  }).nullable().default(null),
});
export type MaterialDraft = z.infer<typeof materialDraftSchema>;
export const evidenceReviewSchema = z.object({
  approved: z.boolean(), reasonZh: text,
  rows: z.array(z.object({
    gapId: id, approved: z.boolean(), evidenceQuote: text, reasonZh: text,
    repairNeeded: z.boolean(), meaningPreserved: z.boolean(), minimalRepair: z.boolean(),
    learningTargetNeeded:z.boolean().optional(),
    cueUnambiguous: z.boolean(), sentenceAligned: z.boolean(), clozeValid: z.boolean(),
  })),
});
export const spokenEvidenceReviewSchema=evidenceReviewSchema.extend({
  wholeAnswer:z.object({
    meaningPreserved:z.boolean(),voicePreserved:z.boolean(),stancePreserved:z.boolean(),
    discourseFunctionsPreserved:z.boolean(),metaphorsPreserved:z.boolean(),spokenNaturalness:z.boolean(),
    noInventedPersonalStyle:z.boolean(),reasonZh:text,
    evidence:z.array(z.object({
      sourceField:z.enum(['actualAnswer','intendedMeaningZh','rawInput']),sourceQuote:z.string().trim().min(1).max(1500),
      rendering:z.string().max(1500),treatment:z.enum(['retained','adapted','condensed']),reasonZh:text,
    })).max(24),
  }),
});
export const materialEvidenceSchema = z.object({ diagnosis: diagnosisSchema, selection: selectionReviewSchema, draft: materialDraftSchema });
export type MaterialEvidence = z.infer<typeof materialEvidenceSchema>;
export interface SelectionSource { actualAnswer: string; intendedMeaningZh: string; spokenStyleVersion?:'personal-spoken-v1';inputFormat?:'mixed-v1';rawInput?:string }
function fail(code: string, message: string): never { throw new TrainingError(message, 422, `material_${code}`); }
function unique(ids: string[]) { return new Set(ids).size === ids.length; }
function sourceQuotes(unit: Diagnosis["units"][number]) { return [...unit.english,...unit.chinese,...unit.raw??[]].map((q) => q.text); }
function hasQuote(unit: Diagnosis["units"][number], value: string) { return sourceQuotes(unit).some((q) => q.includes(value)); }

/** 引用由服务端解析位置；AI 不需要猜中文字符偏移。 */
export function locateQuote(source: string, ref: z.infer<typeof quote>) {
  let start = -1;
  for (let i = 0; i <= ref.occurrence; i++) {
    start = source.indexOf(ref.text, start + 1);
    if (start < 0) fail("source_quote", "诊断引用不在原文中，不能发布");
  }
  return { start, end: start + ref.text.length };
}
export function validateDiagnosis(source: SelectionSource, diagnosis: Diagnosis) {
  if (!unique(diagnosis.units.map((u) => u.id)) || !unique(diagnosis.units.flatMap((u) => u.gaps.map((g) => g.id)))) fail("duplicate_evidence_id", "诊断标识重复");
  const mixed=source.inputFormat==='mixed-v1';
  if(mixed&&(!source.rawInput||source.rawInput!==source.actualAnswer))fail('raw_source','混合输入原文必须与保存的回答一致');
  const fields: Array<['english'|'chinese'|'raw',string]>=mixed?[['raw',source.rawInput!]]:[['english',source.actualAnswer],['chinese',source.intendedMeaningZh]];
  for (const [field, original] of fields) {
    const covered = new Uint8Array(original.length);
    for (const ref of diagnosis.units.flatMap((u) => u[field]??[])) {
      const span = locateQuote(original,ref);
      covered.fill(1,span.start,span.end);
    }
    for (let i=0;i<original.length;i++) if (!covered[i] && !/[\s\p{P}]/u.test(original[i])) fail("source_coverage", `部分原文没有诊断归属（${field} 偏移 ${i}），不能静默遗漏`);
  }
  for (const unit of diagnosis.units) {
    if(!mixed&&unit.raw?.length)fail('raw_source','双字段输入不能引用未绑定来源的raw片段');
    if(mixed)for(const ref of [...unit.english,...unit.chinese])locateQuote(source.rawInput!,ref);
    if (!sourceQuotes(unit).length) fail("missing_evidence", "意思单元没有原文证据");
    if (["natural","uncertain","non_answer"].includes(unit.status) && unit.gaps.length) fail("unsupported_gap", "已自然表达或不确定内容不能生成必练项");
    for (const gap of unit.gaps) {
      if (!hasQuote(unit,gap.evidenceQuote)) fail("gap_quote", "问题证据不属于当前意思单元");
      if(source.spokenStyleVersion&&!gap.senseKey)fail('sense_missing','新学习目标需要明确的意思/用途键');
    }
  }
}
export function validateSelection(diagnosis: Diagnosis, selection: SelectionReview,source?:SelectionSource) {
  if (!selection.approved) fail("selection_rejected", "缺口诊断未通过独立审核");
  if (selection.units.length !== diagnosis.units.length || !unique(selection.units.map((u) => u.unitId))) fail("selection_coverage", "意思单元审核不完整");
  const gaps = diagnosis.units.flatMap((u) => u.gaps);
  if (gaps.length !== selection.gaps.length || !unique(selection.gaps.map((g) => g.gapId))) fail("selection_coverage", "候选表达审核不完整");
  for (const unit of diagnosis.units) {
    const review = selection.units.find((u) => u.unitId === unit.id);
    if (!review || !hasQuote(unit,review.evidenceQuote)) fail("selection_evidence", "审核未引用当前原文");
    if(source?.spokenStyleVersion){
      if(review.status==='natural'&&(!unit.english.some(q=>/[a-z]/i.test(q.text)&&!/[\u3400-\u9fff]/u.test(q.text))))fail('natural_without_english','没有英文表达成功证据，不能以已会排除');
      if(review.status==='repair'&&!unit.english.some(q=>/[a-z]/i.test(q.text)))fail('repair_without_english','没有英文尝试证据，只能作为准备项，不能确认犯错');
      if(['repair','missing'].includes(review.status)&&!unit.gaps.some(g=>selection.gaps.some(r=>r.gapId===g.id&&r.decision==='train')))fail('intent_not_covered','明确但尚未展示英文能力的意思必须有学习目标');
    }
    for (const gap of unit.gaps) {
      const verdict = selection.gaps.find((g) => g.gapId === gap.id);
      if (!verdict || !hasQuote(unit,verdict.evidenceQuote)) fail("selection_evidence", "Gap 裁决缺少原文证据");
      if (verdict.decision === "train") {
        if (!["repair","missing"].includes(review.status)) fail("natural_selected", "已经表达或未确认的意思不能列为必练");
      }
    }
  }
}
export function selectedGaps(diagnosis: Diagnosis, selection: SelectionReview) {
  return diagnosis.units.flatMap((unit) => unit.gaps.filter((gap) => selection.gaps.some((r) => r.gapId === gap.id && r.decision === "train")).map((gap) => ({ unit, gap })));
}
export function compileEvidence(source: SelectionSource, evidence: MaterialEvidence) {
  const { diagnosis,selection,draft } = evidence;
  validateDiagnosis(source,diagnosis); validateSelection(diagnosis,selection,source);
  const included = diagnosis.units.filter((u) => !["uncertain","non_answer"].includes(selection.units.find((r) => r.unitId===u.id)!.status));
  const selected = selectedGaps(diagnosis,selection);
  const represented = draft.sentences.flatMap((s) => s.intentUnitIds);
  if (!unique(draft.sentences.map((s) => s.id)) || !unique(represented) || represented.length !== included.length || included.some((u) => !represented.includes(u.id))) fail("sentence_coverage", "训练全文与已确认中文意思没有一一归属");
  if (draft.rows.length !== selected.length || !unique(draft.rows.map((r) => r.gapId))) fail("row_coverage", "四列行数与确认的学习目标不一致");
  for (const unit of included) {
    const sentence = draft.sentences.find((s) => s.intentUnitIds.includes(unit.id))!;
    if (selection.units.find((r) => r.unitId===unit.id)!.status === "natural" && unit.english.some((q) => !normalizeExpression(sentence.english).includes(normalizeExpression(q.text)))) fail("natural_rewritten", "已经自然表达的内容不能为了润色而重写");
  }
  const rows = draft.rows.map((row) => {
    const found = selected.find((s) => s.gap.id === row.gapId);
    const sentence = draft.sentences.find((s) => s.id === row.sentenceId);
    if (!found || !sentence?.intentUnitIds.includes(found.unit.id) || !findTargetSpan(sentence.english,[row.surfaceInSentence])) fail("row_alignment", "训练行没有关联正确意思或可用填空范围");
    if (selection.units.find((r)=>r.unitId===found.unit.id)!.status === "repair" && normalizeExpression(found.unit.english.map((q)=>q.text).join(" "))===normalizeExpression(sentence.english)) fail("no_op_repair", "推荐句与原句相同，没有可证明的修复");
    return {
      gapId: found.gap.id, sentenceId: sentence.id, intentUnitIds: sentence.intentUnitIds,
      chineseChunk: found.gap.cueZh, englishChunk: found.gap.targetEnglish, acceptableVariants: found.gap.acceptableVariants,
      yourChineseSentence: sentence.intentUnitIds.map((id) => included.find((u) => u.id===id)!.intentZh).join("\n"),
      naturalEnglishSentence: sentence.english, surfaceInSentence: row.surfaceInSentence,
      originalEnglish: found.unit.english.map((q) => q.text).join("\n"), originalChinese: found.unit.chinese.map((q) => q.text).join("\n"),
      inclusionReasonZh: selection.gaps.find((r) => r.gapId===found.gap.id)!.reasonZh,
      ...(source.spokenStyleVersion?{learningBasis:selection.units.find(u=>u.unitId===found.unit.id)!.status==='repair'&&found.gap.kind!=='unexpressed_intention'?'confirmed_error' as const:'preparation' as const,senseKey:found.gap.senseKey}:{}),
    };
  });
  return {
    contractVersion: "evidence_v2" as const, evidence,
    answerIntentZh: included.map((u) => u.intentZh).join("\n"),
    naturalVersion: draft.sentences.map((s) => s.english).join("\n"),
    gaps: selected.map(({gap}) => ({ key: gap.id,intentZh:gap.cueZh,targetEnglish:gap.targetEnglish,gapType:gap.kind,evidence:gap.evidenceQuote,explanationZh:gap.whyNeededZh,...(source.spokenStyleVersion?{learningBasis:rows.find(r=>r.gapId===gap.id)!.learningBasis}:{}) })),
    gapCount: source.spokenStyleVersion?rows.filter(r=>r.learningBasis==='confirmed_error').length:selected.length, learningMaterials:rows,
    ...(source.spokenStyleVersion?{learningTargetCount:rows.length,needsAttention:diagnosis.units.filter(u=>selection.units.find(r=>r.unitId===u.id)!.status==='uncertain').map(u=>({intentZh:u.intentZh,reasonZh:selection.units.find(r=>r.unitId===u.id)!.reasonZh}))}:{}),
    learningItems: rows.map((r) => ({ canonicalKey:source.spokenStyleVersion?`${normalizeExpression(r.englishChunk).slice(0,65)}::${normalizeExpression(r.senseKey??r.chineseChunk).slice(0,90)}`:normalizeExpression(r.englishChunk),targetEnglish:r.englishChunk,intentionZh:r.chineseChunk,itemType:"personal_expression" as const,example:r.naturalEnglishSentence })),
    corrections: selected.filter(({unit,gap}) => unit.english.length&&(!source.spokenStyleVersion||rows.find(r=>r.gapId===gap.id)!.learningBasis==='confirmed_error')).map(({unit,gap}) => ({ original:unit.english.map((q)=>q.text).join("\n"),corrected:rows.find((r)=>r.gapId===gap.id)!.naturalEnglishSentence,reasonZh:gap.whyNeededZh })),
    clozeItems: rows.map((r) => { const span=findTargetSpan(r.naturalEnglishSentence,[r.surfaceInSentence])!; return { gapKey:r.gapId, originalSentence:r.naturalEnglishSentence,clozeSentence:r.naturalEnglishSentence.slice(0,span.start)+"____"+r.naturalEnglishSentence.slice(span.end),answer:span.surface,hintZh:r.chineseChunk,acceptableAnswers:[] }; }),
    examFeedback:draft.examFeedback,
  };
}
export function validateEvidenceReview(evidence: MaterialEvidence, review: z.infer<typeof evidenceReviewSchema>,source?:SelectionSource) {
  const selected = selectedGaps(evidence.diagnosis,evidence.selection);
  if (!review.approved || review.rows.length!==selected.length || !unique(review.rows.map((r)=>r.gapId))) fail("review_rejected", "材料未通过独立审核");
  for (const {unit,gap} of selected) {
    const row=review.rows.find((r)=>r.gapId===gap.id);
    const confirmed=evidence.selection.units.find(u=>u.unitId===unit.id)?.status==='repair'&&gap.kind!=='unexpressed_intention';
    const necessary=source?.spokenStyleVersion?row?.learningTargetNeeded===true&&row.repairNeeded===confirmed:row?.repairNeeded;
    if (!row || !row.approved || !necessary || !row.meaningPreserved || !row.minimalRepair || !row.cueUnambiguous || !row.sentenceAligned || !row.clozeValid || !hasQuote(unit,row.evidenceQuote)) fail("review_rejected", "材料必要性、原意或填空审核未通过");
  }
  if(source?.spokenStyleVersion==='personal-spoken-v1'){
    const parsed=spokenEvidenceReviewSchema.safeParse(review);
    if(!parsed.success)fail('voice_review_missing','完整自然表达缺少个人说话风格审核');
    const whole=parsed.data.wholeAnswer;
    if(!whole.meaningPreserved||!whole.voicePreserved||!whole.stancePreserved||!whole.discourseFunctionsPreserved||!whole.metaphorsPreserved||!whole.spokenNaturalness||!whole.noInventedPersonalStyle)fail('voice_review_rejected','自然全文没有保留用户原意或说话方式，请按原文修订');
    const full=evidence.draft.sentences.map(s=>s.english).join('\n');
    if(full.trim()&&!whole.evidence.length)fail('voice_review_evidence','全文审核必须引用本次原话，即使没有训练项');
    for(const item of whole.evidence){
      if(!source[item.sourceField]?.includes(item.sourceQuote))fail('voice_review_evidence','说话风格审核引用不属于本次原文');
      if(item.rendering&&!full.includes(item.rendering))fail('voice_review_evidence','说话风格审核未引用实际生成的英文');
      if(item.treatment!=='condensed'&&!item.rendering.trim())fail('voice_review_evidence','保留或适配的说话方式需要对应英文');
    }
  }
}
