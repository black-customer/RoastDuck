import type {SqlReader} from '@/lib/platform/database';
import {query as sql} from '@/lib/platform/sql';
import {sha256Text} from '@/lib/platform/hash';
import {speakingAttemptAnalysisSchema} from '@/lib/speaking-practice/schemas';
import {normalizeUniqueQuoteOccurrences} from './quote-normalization';
import {diagnosisSchema,selectionSchemaForSource,recallMaterialDraftSchema,materialDraftSchema,compileEvidence,reviewSchemaForSource,validateEvidenceReview,validateDiagnosis,validateSelection} from './selection-contracts';
import {materialStageContracts,diagnosisRepairPrompt} from './stage-contracts';
import {matchesReviewedProjection} from './reviewed-projection';
import type {MaterialInput,MaterialRow} from './material-types';
import {hash} from './shared';
import {validateMaterial} from './material-validation';
import {teachingMaterialDraftSchema} from './selection-contracts';

type Stage={run_id:string;stage:string;status:string;prompt_version:string;input_hash:string;input_json:string;output_json:string;role:string;run_status:string;run_prompt:string;run_input_hash:string;receipt_state:string;response_json:string|null};
/** Replays existing real/Mock receipts against current rules. It performs no
 * network or writes and cannot turn a negative independent verdict positive. */
export async function recoverApprovedPipeline(tx:SqlReader,material:MaterialRow){
 try{
  const source=JSON.parse(material.input_json) as MaterialInput;if(!source.registerProfileVersion)return null;
  const stages=await tx.all<Stage>(sql`SELECT s.*,a.role,a.status run_status,a.prompt_version run_prompt,a.input_hash run_input_hash,r.state receipt_state,r.response_json FROM practice_material_stages s LEFT JOIN ai_runs a ON a.run_id=s.run_id LEFT JOIN runtime_requests r ON r.run_id=s.run_id WHERE s.material_id=${material.id} ORDER BY s.created_at DESC,s.run_id DESC`);
  const reviewStage=stages.find(row=>row.stage==='review'),latestDraft=stages.find(row=>row.stage==='material');if(!reviewStage||!latestDraft)return null;
  const reviewInput=JSON.parse(reviewStage.input_json);if(reviewInput.generatorRunId!==latestDraft.run_id)return null;
  const draftInput=JSON.parse(latestDraft.input_json),selectionStage=stages.find(row=>row.stage==='selection'&&row.run_id===draftInput.selectionRunId);if(!selectionStage)return null;
  const selectionInput=JSON.parse(selectionStage.input_json),diagnosisStage=stages.find(row=>row.stage==='diagnosis'&&row.run_id===selectionInput.diagnosisRunId);if(!diagnosisStage)return null;
  const used=[diagnosisStage,selectionStage,latestDraft,reviewStage],contracts=materialStageContracts(source);
  if(new Set(used.map(row=>row.run_id)).size!==4)return null;
  for(const row of used){
   const spec=contracts[row.stage as keyof typeof contracts],prompts=row.stage==='diagnosis'?[spec.prompt,diagnosisRepairPrompt(source)]:[spec.prompt];
   if(!['completed','rejected'].includes(row.status)||row.run_status!=='completed'||row.receipt_state!=='completed'||!row.response_json||row.role!==spec.role||!prompts.includes(row.prompt_version)||row.run_prompt!==row.prompt_version||row.input_hash!==hash(row.prompt_version,row.input_json)||row.run_input_hash!==sha256Text(row.input_json.normalize('NFKC')))return null;
   if(JSON.stringify(JSON.parse(row.response_json).data)!==JSON.stringify(JSON.parse(row.output_json))||JSON.stringify(JSON.parse(row.input_json).source)!==JSON.stringify(source))return null;
  }
  const diagnosis=normalizeUniqueQuoteOccurrences(source,diagnosisSchema.parse(JSON.parse(diagnosisStage.output_json))).diagnosis;
  const selection=selectionSchemaForSource(source).parse(JSON.parse(selectionStage.output_json));
  validateDiagnosis(source,diagnosis);validateSelection(diagnosis,selection,source);
  if(JSON.stringify(selectionInput.diagnosis)!==JSON.stringify(diagnosis)||JSON.stringify(draftInput.diagnosis)!==JSON.stringify(diagnosis)||JSON.stringify(draftInput.selection)!==JSON.stringify(selection))return null;
  const draft=(source.teachingVersion?teachingMaterialDraftSchema:source.spokenStyleVersion==='personal-spoken-v2'?recallMaterialDraftSchema:materialDraftSchema).parse(JSON.parse(latestDraft.output_json)),evidence={diagnosis,selection,draft};
  const analysis=speakingAttemptAnalysisSchema.parse(compileEvidence(source,evidence));validateMaterial(analysis,source);
  const reviewed=reviewSchemaForSource(source).parse(JSON.parse(reviewStage.output_json));validateEvidenceReview(evidence,reviewed,source);
  if(!matchesReviewedProjection(source,reviewInput.compiled,analysis,reviewed))return null;
  return {stageRunIds:used.map(row=>row.run_id),analysis,generatorRunId:latestDraft.run_id,reviewed:{runId:reviewStage.run_id,data:{approved:true,reasonZh:reviewed.reasonZh,rows:analysis.learningMaterials.map((row,index)=>({index,approved:true,reasonZh:reviewed.rows.find(item=>item.gapId===row.gapId)!.reasonZh}))}}};
 }catch{return null;}
}
