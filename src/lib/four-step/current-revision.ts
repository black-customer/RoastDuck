import type {DatabasePort,SqlReader,SqlWriter} from '@/lib/platform/database';
import {query as sql} from '@/lib/platform/sql';
import {prepareMaterialIn} from './core-materials';
import type {MaterialInput,MaterialRow} from './material-types';
import {TrainingError} from './shared';
import {SPOKEN_STYLE_VERSION,SELECTION_POLICY_VERSION,SENTENCE_STUDY_VERSION} from './stage-contracts';
import {SPOKEN_REGISTER_VERSION} from '@/lib/ai/spoken-register';
import {materialDiagnostic} from './material-status';
import {materialSourceHash} from './revision-source';

export interface MaterialTransition {fromMaterialId:string;toMaterialId:string;message:string}
export interface CurrentMaterialRetry {material:MaterialRow;requestedMaterialId:string;transition:MaterialTransition|null;created:boolean}
const notice=(from:string,to:string):MaterialTransition=>({fromMaterialId:from,toMaterialId:to,message:'已保留原回答和旧分析，接下来按当前的中英文原意对齐与自然美式表达规则重新整理。'});
const isCurrent=(source:MaterialInput)=>source.spokenStyleVersion===SPOKEN_STYLE_VERSION&&source.selectionPolicyVersion===SELECTION_POLICY_VERSION&&source.sentenceStudyVersion===SENTENCE_STUDY_VERSION&&source.registerProfileVersion===SPOKEN_REGISTER_VERSION;
function sourceOf(material:MaterialRow){try{return JSON.parse(material.input_json) as MaterialInput;}catch{throw new TrainingError('原材料快照无法读取，原回答仍保留',409,'material_snapshot_invalid');}}

/** Follows only previously saved successors. Safe for GET: never prepares, retries or repairs anything. */
export async function resolveCurrentMaterialIn(tx:SqlReader,requestedMaterialId:string):Promise<CurrentMaterialRetry>{
  const [requested]=await tx.all<MaterialRow>(sql`SELECT * FROM practice_materials WHERE id=${requestedMaterialId}`);
  if(!requested)throw new TrainingError('学习材料不存在',404,'material_not_found');
  let current=requested;
  const seen=new Set([current.id]);
  for(let depth=0;depth<8;depth++){
    const [child]=await tx.all<MaterialRow>(sql`SELECT * FROM practice_materials WHERE source_type=${current.source_type} AND source_id=${current.source_id} AND json_extract(input_json,'$.runtimeRevision.parentMaterialId')=${current.id} AND json_extract(input_json,'$.runtimeRevision.parentInputHash')=${current.input_hash} ORDER BY julianday(created_at) DESC,id DESC LIMIT 1`);
    if(!child)break;
    const parent=sourceOf(current),next=sourceOf(child);
    if(seen.has(child.id)||materialSourceHash(next)!==materialSourceHash(parent))throw new TrainingError('材料版本关联不一致，原记录保留',409,'material_successor_conflict');
    seen.add(child.id);current=child;
  }
  // A newer contract may have been explicitly prepared by an earlier application entrypoint.
  // Reuse its exact source snapshot rather than creating a second equivalent generation task.
  if(current.status==='failed'&&!isCurrent(sourceOf(current))){
    const candidates=await tx.all<MaterialRow>(sql`SELECT * FROM practice_materials WHERE source_type=${current.source_type} AND source_id=${current.source_id} AND json_extract(input_json,'$.registerProfileVersion')=${SPOKEN_REGISTER_VERSION} ORDER BY julianday(created_at) DESC,id DESC`);
    const existing=candidates.find(candidate=>isCurrent(sourceOf(candidate))&&materialSourceHash(sourceOf(candidate))===materialSourceHash(sourceOf(current)));
    if(existing)current=existing;
  }
  return {material:current,requestedMaterialId,transition:current.id===requested.id?null:notice(requested.id,current.id),created:false};
}

async function assertSource(tx:SqlReader,input:MaterialInput){
  if(input.sourceType==='ielts_practice'){
    const [original]=await tx.all<{answer_text:string;intended_meaning_zh:string;question_id:string}>(sql`SELECT answer_text,intended_meaning_zh,question_id FROM speaking_question_attempts WHERE id=${input.sourceId}`);
    if(!original||original.answer_text!==input.actualAnswer||original.intended_meaning_zh!==input.intendedMeaningZh||original.question_id!==input.question?.id)throw new TrainingError('原回答与材料快照不一致，请保留原记录后检查',409,'material_source_changed');
    if((await tx.all(sql`SELECT 1 FROM practice_answer_sources WHERE attempt_id=${input.sourceId}`)).length)throw new TrainingError('历史导入回答使用离线处理，不会自动消耗 Runtime',409,'historical_offline_required');
  }else{
    if(!input.sourceMessages?.some(m=>m.role==='user')||input.actualAnswer!==input.sourceMessages.filter(m=>m.role==='user').map(m=>m.text).join('\n'))throw new TrainingError('对话复盘来源不完整',409,'material_source_changed');
    const rows=await tx.all<{id:string;role:string;text:string}>(sql`SELECT id,role,text FROM free_talk_messages WHERE conversation_id=${input.sourceId}`);
    if(input.sourceMessages.some(m=>!rows.some(r=>r.id===m.id&&r.role===m.role&&r.text===m.text)))throw new TrainingError('原对话与复盘快照不一致，原记录保留',409,'material_source_changed');
  }
}

/** Explicit retry only: current contracts keep their checkpoints; failed old contracts get one append-only successor. */
export async function prepareCurrentMaterialRetryIn(tx:SqlWriter,requestedMaterialId:string,at:Date,options:{retryUnknown?:boolean}={}):Promise<CurrentMaterialRetry>{
  const resolved=await resolveCurrentMaterialIn(tx,requestedMaterialId),material=resolved.material,source=sourceOf(material);
  if(!['ready','queued','generating','reviewing','failed'].includes(material.status))throw new TrainingError('材料已隐藏或撤销，不能通过重试恢复发布',409,'material_unavailable');
  if(material.status!=='failed'||isCurrent(source))return resolved;
  if(source.offlineRevision)throw new TrainingError('离线材料修订仍通过独立审核的离线入口继续',409,'offline_revision_required');
  const [lease]=await tx.all<{id:string}>(sql`SELECT id FROM practice_materials WHERE source_type=${material.source_type} AND source_id=${material.source_id} AND lease_until>${at.toISOString()} LIMIT 1`);
  if(lease)throw new TrainingError('原分析仍在运行，请等它结束后继续；原回答已保留',409,'material_analysis_running');
  const [run]=material.job_id?await tx.all<{error_code:string|null;role:string;error_details_json:string}>(sql`SELECT error_code,role,error_details_json FROM ai_runs WHERE job_id=${material.job_id} ORDER BY created_at DESC,run_id DESC LIMIT 1`):[];
  const diagnostic=materialDiagnostic(['material_service_failed','request_failed'].includes(material.error_code??'')?run?.error_code:material.error_code,run?.role,run?.error_details_json);
  if(!diagnostic.canRetry)throw new TrainingError(diagnostic.message,409,'request_configuration_required');
  if(diagnostic.requiresConfirmation&&!options.retryUnknown)throw new TrainingError('上次结果未知，请确认可能再次计费后再继续',409,'result_unknown');
  const previouslyPublished=(await tx.all(sql`SELECT 1 FROM practice_material_items WHERE material_id=${material.id} LIMIT 1`)).length
    ||(await tx.all(sql`SELECT 1 FROM sentence_learning_units WHERE material_id=${material.id} LIMIT 1`)).length;
  if(previouslyPublished)throw new TrainingError('这份材料曾进入学习，保留原学习记录；请从回答页另建修订版本',409,'material_previously_published');
  await assertSource(tx,source);
  // Preserve every original field, including mixed input and source lineage. Only generation policy changes.
  const updated:MaterialInput={...source,spokenStyleVersion:SPOKEN_STYLE_VERSION,selectionPolicyVersion:SELECTION_POLICY_VERSION,sentenceStudyVersion:SENTENCE_STUDY_VERSION,registerProfileVersion:SPOKEN_REGISTER_VERSION,
    runtimeRevision:{parentMaterialId:material.id,parentInputHash:material.input_hash,policyVersion:SPOKEN_REGISTER_VERSION}};
  const [latest]=await tx.all<{created_at:string}>(sql`SELECT created_at FROM practice_materials WHERE source_type=${material.source_type} AND source_id=${material.source_id} ORDER BY julianday(created_at) DESC,id DESC LIMIT 1`);
  const previousTime=Date.parse(latest?.created_at??'');
  const timestamp=new Date(Math.max(at.getTime(),Number.isFinite(previousTime)?previousTime+1:0)).toISOString();
  const successor=await prepareMaterialIn(tx,updated,timestamp);
  if(source.sourceType==='ielts_practice')await tx.run(sql`UPDATE speaking_question_attempts SET status='processing',updated_at=${timestamp} WHERE id=${source.sourceId}`);
  return {material:successor,requestedMaterialId,created:true,transition:notice(requestedMaterialId,successor.id)};
}

export const prepareCurrentMaterialRetry=(database:DatabasePort,materialId:string,at=new Date(),options:{retryUnknown?:boolean}={})=>database.write(tx=>prepareCurrentMaterialRetryIn(tx,materialId,at,options));
export const resolveCurrentMaterial=(database:DatabasePort,materialId:string)=>database.read(tx=>resolveCurrentMaterialIn(tx,materialId));
