import {z} from 'zod';
import {diagnosisSchema,selectionReviewSchema,evidencedSelectionReviewSchema,selectionSchemaForSource,validateDiagnosis,validateSelection,type Diagnosis,type SelectionReview,type SelectionSource} from './selection-contracts';
import {materialStageContracts,diagnosisRepairPrompt} from './stage-contracts';
import type {MaterialInput} from './material-types';
import {normalizeUniqueQuoteOccurrences,type QuoteNormalizationChange} from './quote-normalization';
import {hash,TrainingError} from './shared';

interface IdentityIssue {field:'units'|'gaps';kind:'count'|'duplicate'|'unknown'|'missing';id?:string}
function selectionIdentityIssues(diagnosis:Diagnosis,selection:SelectionReview):IdentityIssue[]{
  const issues:IdentityIssue[]=[];
  const groups=[{field:'units' as const,expected:diagnosis.units.map(u=>u.id),actual:selection.units.map(u=>u.unitId)},
    {field:'gaps' as const,expected:diagnosis.units.flatMap(u=>u.gaps.map(g=>g.id)),actual:selection.gaps.map(g=>g.gapId)}];
  for(const {field,expected,actual} of groups){
    if(expected.length!==actual.length)issues.push({field,kind:'count'});
    const visited=new Set<string>();
    for(const id of actual){if(visited.has(id))issues.push({field,kind:'duplicate',id});visited.add(id);if(!expected.includes(id))issues.push({field,kind:'unknown',id});}
    for(const id of expected)if(!visited.has(id))issues.push({field,kind:'missing',id});
  }
  return issues;
}
/** Must run before approved: an unknown identity is a reviewer-format error, not a semantic verdict. */
export function assertSelectionIdentity(diagnosis:Diagnosis,selection:SelectionReview){
  if(selectionIdentityIssues(diagnosis,selection).length)throw new TrainingError('选材审核的意思或表达编号与当前诊断不一致，需要重新核对这一审核步骤',422,'material_selection_identity');
}

/** Same response fields as the existing reviewer contract; IDs and lengths are bound to this diagnosis. */
export function selectionSchemaForDiagnosis(source:SelectionSource,diagnosis:Diagnosis):z.ZodType<SelectionReview>{
  const unitIds=diagnosis.units.map(u=>u.id),gapIds=diagnosis.units.flatMap(u=>u.gaps.map(g=>g.id));
  if(!unitIds.length||new Set(unitIds).size!==unitIds.length||new Set(gapIds).size!==gapIds.length)throw new TrainingError('当前诊断编号不完整或重复，不能生成审核约束',422,'material_diagnosis_identity');
  const base=source.selectionPolicyVersion==='evidence-exclusion-v1'?evidencedSelectionReviewSchema:selectionReviewSchema;
  const unit=base.shape.units.element.extend({unitId:z.enum(unitIds as [string,...string[]])});
  const gap=gapIds.length?base.shape.gaps.element.extend({gapId:z.enum(gapIds as [string,...string[]])}):base.shape.gaps.element;
  return base.extend({
    approved:base.shape.approved.describe('表示当前诊断及这些选材裁决可安全进入材料编译。合法的 exclude 或 uncertain 裁决本身不必令全局为 false；如果原意、事实或确认错误仍未得到可靠处理，则必须为 false。保留独立判断，不能为通过检查而批准。'),
    units:z.array(unit).length(unitIds.length),gaps:z.array(gap).length(gapIds.length),
  }).superRefine((value,context)=>{
    for(const issue of selectionIdentityIssues(diagnosis,value))context.addIssue({code:'custom',path:[issue.field],message:`选材审核编号不完整：${issue.kind}${issue.id?` (${issue.id})`:''}`});
  });
}

export interface StoredReviewStage {
  run_id:string;material_id:string;stage:string;status:string;prompt_version:string;input_hash:string;input_json:string;output_json:string;
}
export interface ReusableDiagnosisForSelection {
  diagnosisRunId:string;rejectedSelectionRunId:string;rawDiagnosis:Diagnosis;diagnosis:Diagnosis;
  normalizations:QuoteNormalizationChange[];reason:'selection_identity_mismatch';
}
/**
 * Pure recovery proof. Caller may retry an independent selection with this diagnosis; it must not
 * restore the original diagnosis status until that new review has legal IDs and approved=true.
 * An ordinary, structurally valid approved=false is deliberately never eligible.
 */
export function recoverDiagnosisFromMalformedSelection(source:MaterialInput,rejectedSelection:StoredReviewStage,referencedDiagnosis:StoredReviewStage):ReusableDiagnosisForSelection|null{
  try{
    if(rejectedSelection.stage!=='selection'||rejectedSelection.status!=='rejected'||referencedDiagnosis.stage!=='diagnosis'||!['completed','rejected'].includes(referencedDiagnosis.status))return null;
    if(rejectedSelection.material_id!==referencedDiagnosis.material_id||rejectedSelection.run_id===referencedDiagnosis.run_id)return null;
    const contracts=materialStageContracts(source);
    if(rejectedSelection.prompt_version!==contracts.selection.prompt||![contracts.diagnosis.prompt,diagnosisRepairPrompt(source)].includes(referencedDiagnosis.prompt_version))return null;
    if(rejectedSelection.input_hash!==hash(rejectedSelection.prompt_version,rejectedSelection.input_json)||referencedDiagnosis.input_hash!==hash(referencedDiagnosis.prompt_version,referencedDiagnosis.input_json))return null;
    const selectionInput=JSON.parse(rejectedSelection.input_json),diagnosisInput=JSON.parse(referencedDiagnosis.input_json);
    if(selectionInput.diagnosisRunId!==referencedDiagnosis.run_id||JSON.stringify(selectionInput.source)!==JSON.stringify(source)||JSON.stringify(diagnosisInput.source)!==JSON.stringify(source))return null;
    const rawDiagnosis=diagnosisSchema.parse(JSON.parse(referencedDiagnosis.output_json));
    const normalized=source.registerProfileVersion?normalizeUniqueQuoteOccurrences(source,rawDiagnosis):{diagnosis:structuredClone(rawDiagnosis),changes:[]};
    validateDiagnosis(source,normalized.diagnosis);
    if(JSON.stringify(selectionInput.diagnosis)!==JSON.stringify(normalized.diagnosis))return null;
    const review=selectionSchemaForSource(source).parse(JSON.parse(rejectedSelection.output_json));
    if(!selectionIdentityIssues(normalized.diagnosis,review).length)return null;
    return {diagnosisRunId:referencedDiagnosis.run_id,rejectedSelectionRunId:rejectedSelection.run_id,rawDiagnosis,diagnosis:normalized.diagnosis,normalizations:normalized.changes,reason:'selection_identity_mismatch'};
  }catch{return null;}
}

export interface ReusableApprovedSelection {
  diagnosisRunId:string;selectionRunId:string;rawDiagnosis:Diagnosis;diagnosis:Diagnosis;selection:SelectionReview;
  normalizations:QuoteNormalizationChange[];reason:'approved_selection_revalidated';
}
/**
 * Revalidates an existing positive independent review after a validator correction. This is a pure
 * proof, not a status change or a new AI run. All source and raw output evidence must still agree.
 */
export function recoverApprovedSelection(source:MaterialInput,selectionStage:StoredReviewStage,diagnosisStage:StoredReviewStage):ReusableApprovedSelection|null{
  try{
    if(selectionStage.stage!=='selection'||!['completed','rejected'].includes(selectionStage.status)||diagnosisStage.stage!=='diagnosis'||!['completed','rejected'].includes(diagnosisStage.status))return null;
    if(selectionStage.material_id!==diagnosisStage.material_id||selectionStage.run_id===diagnosisStage.run_id)return null;
    const contracts=materialStageContracts(source);
    if(selectionStage.prompt_version!==contracts.selection.prompt||![contracts.diagnosis.prompt,diagnosisRepairPrompt(source)].includes(diagnosisStage.prompt_version))return null;
    if(selectionStage.input_hash!==hash(selectionStage.prompt_version,selectionStage.input_json)||diagnosisStage.input_hash!==hash(diagnosisStage.prompt_version,diagnosisStage.input_json))return null;
    const reviewInput=JSON.parse(selectionStage.input_json),diagnosisInput=JSON.parse(diagnosisStage.input_json);
    if(reviewInput.diagnosisRunId!==diagnosisStage.run_id||JSON.stringify(reviewInput.source)!==JSON.stringify(source)||JSON.stringify(diagnosisInput.source)!==JSON.stringify(source))return null;
    const rawDiagnosis=diagnosisSchema.parse(JSON.parse(diagnosisStage.output_json));
    const normalized=source.registerProfileVersion?normalizeUniqueQuoteOccurrences(source,rawDiagnosis):{diagnosis:structuredClone(rawDiagnosis),changes:[]};
    validateDiagnosis(source,normalized.diagnosis);
    if(JSON.stringify(reviewInput.diagnosis)!==JSON.stringify(normalized.diagnosis))return null;
    const selection=selectionSchemaForDiagnosis(source,normalized.diagnosis).parse(JSON.parse(selectionStage.output_json));
    if(selection.approved!==true)return null;
    validateSelection(normalized.diagnosis,selection,source);
    return {diagnosisRunId:diagnosisStage.run_id,selectionRunId:selectionStage.run_id,rawDiagnosis,diagnosis:normalized.diagnosis,selection,normalizations:normalized.changes,reason:'approved_selection_revalidated'};
  }catch{return null;}
}
