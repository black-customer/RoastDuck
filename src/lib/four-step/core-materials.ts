import type {DatabasePort,SqlWriter} from "@/lib/platform/database";
import {query as sql} from "@/lib/platform/sql";
import {RuntimeRequestError,type RuntimeCalls} from "@/lib/ai/runtime-ledger";
import {AiProviderError} from "@/lib/ai/errors";
import type {MaterialInput,MaterialRow} from "./material-types";
import {runCoreDiagnosticPipeline,type MaterialGuard} from "./core-diagnostic-pipeline";
import {validateMaterial} from "./material-validation";
import {publishReviewedItems} from "./publication";
import {hash,TrainingError} from "./shared";
import {auditPracticeMaterials} from "./audit";
import {speakingAttemptAnalysisSchema} from "@/lib/speaking-practice/schemas";
import {assertLocalOwnership} from '@/lib/device-sync/ownership';

export interface MaterialPlatform {database:DatabasePort;runtime:RuntimeCalls;loadPrompt:(filename:string)=>string|Promise<string>;now:()=>Date;newId:()=>string;bootId:string;allowMock?:boolean}
export interface MaterialProcessOptions {retry?:boolean;retryUnknown?:boolean}
export async function prepareMaterialIn(tx:SqlWriter,input:MaterialInput,timestamp:string){
  const snapshot=JSON.stringify(input),inputHash=hash('four-step-material-evidence-v2',snapshot),id=`pm_${hash(input.sourceType,input.sourceId,inputHash).slice(0,24)}`;
  await tx.run(sql`INSERT INTO practice_materials(id,source_type,source_id,question_id,input_json,input_hash,created_at,updated_at,contract_version) VALUES(${id},${input.sourceType},${input.sourceId},${input.question?.id??null},${snapshot},${inputHash},${timestamp},${timestamp},'evidence_v2') ON CONFLICT DO NOTHING`);
  return (await tx.all<MaterialRow>(sql`SELECT * FROM practice_materials WHERE id=${id}`))[0];
}
export function createMaterialService(platform:MaterialPlatform){
  const {database,now}=platform;
  const active=new Map<string,Promise<MaterialRow>>();
  async function getFrom(tx:Pick<SqlWriter,"all">,id:string){
    const [row]=await tx.all<MaterialRow>(sql`SELECT * FROM practice_materials WHERE id=${id}`);
    if(!row)throw new TrainingError("学习材料不存在",404,"material_not_found");return row;
  }
  const get=(id:string)=>database.read(tx=>getFrom(tx,id));
  const inspect=(id:string)=>database.read(async tx=>{
    const material=await getFrom(tx,id);let parsed:unknown=null;try{parsed=JSON.parse(material.analysis_json);}catch{/* Retain the original and show a broken-material state. */}
    const analysis=speakingAttemptAnalysisSchema.safeParse(parsed);
    const audit=material.status==="ready"?await auditPracticeMaterials({execute:async statement=>({rows:await tx.all<Record<string,unknown>>(typeof statement==="string"?{sql:statement}:statement)})},platform.allowMock,[id]):null;
    return {material,analysis:analysis.success?analysis.data:null,verified:!!audit?.ok,audit};
  });
  async function prepareIn(tx:SqlWriter,input:MaterialInput){
    return prepareMaterialIn(tx,input,now().toISOString());
  }
  const prepare=(input:MaterialInput)=>database.write(tx=>prepareIn(tx,input));
  async function run(id:string,options:MaterialProcessOptions):Promise<MaterialRow>{
    let material=await get(id);
    if(material.status==="ready")return material;
    if(material.contract_version!=="evidence_v2")throw new TrainingError("保留旧材料；请显式创建新版分析，不覆盖历史",409,"legacy_material");
    if(!["queued","generating","reviewing","failed"].includes(material.status))throw new TrainingError("材料已隐藏或移除，不会自动恢复",409,"material_unavailable");
    if(material.source_type==="ielts_practice"&&(await database.read(tx=>tx.all(sql`SELECT 1 FROM practice_answer_sources WHERE attempt_id=${material.source_id}`))).length){
      throw new TrainingError("历史资料使用离线处理，不自动消耗Runtime余额",409,"historical_offline_required");
    }
    const token=`native.${platform.bootId}.${platform.newId()}`,timestamp=now().toISOString();
    const claimed=await database.write(async tx=>{
      await assertLocalOwnership(tx,'practice_materials',id);
      const row=await getFrom(tx,id);
      if(row.lease_until&&row.lease_until>timestamp)return false;
      await tx.run(sql`UPDATE practice_materials SET lease_token=${token},lease_until=${new Date(now().getTime()+600_000).toISOString()},status='generating',error_code=NULL,updated_at=${timestamp} WHERE id=${id}`);
      return true;
    });
    if(!claimed)return get(id);
    const source=JSON.parse(material.input_json) as MaterialInput;
    const jobId=material.job_id??`job_${hash("material-runtime-v1",id).slice(0,24)}`;
    const guard:MaterialGuard=work=>database.write(async tx=>{
      if((await getFrom(tx,id)).lease_token!==token)throw new TrainingError("任务已由其他操作接手",409,"material_lease_lost");
      return work(tx);
    });
    try{
      await guard(async tx=>{
        await tx.run(sql`INSERT INTO ai_jobs(id,kind,status,target_type,target_id,idempotency_key,prompt_version,schema_version,payload_json,created_at,updated_at)
          VALUES(${jobId},'four_step_material','generating','practice_material',${id},${hash("material-runtime-v1",id)},'four-step-evidence-v2','four-step-evidence-v2',${material.input_json},${timestamp},${timestamp}) ON CONFLICT DO NOTHING`);
        await tx.run(sql`UPDATE ai_jobs SET status='generating',last_error_code=NULL,updated_at=${timestamp} WHERE id=${jobId}`);
        await tx.run(sql`UPDATE practice_materials SET job_id=${jobId} WHERE id=${id}`);
        if(source.sourceType==="ielts_practice")await tx.run(sql`UPDATE speaking_question_attempts SET status='processing',updated_at=${timestamp} WHERE id=${source.sourceId}`);
      });
      const generated=await runCoreDiagnosticPipeline(material,{...platform,guard,callOptions:{jobId,retryFailed:options.retry,retryUnknown:options.retryUnknown}});
      validateMaterial(generated.analysis,source);
      await guard(async tx=>{
        await tx.run(sql`INSERT INTO practice_material_revisions(material_id,generator_run_id,analysis_json,reviewer_run_id,review_json,created_at)
          VALUES(${id},${generated.generatorRunId},${JSON.stringify(generated.analysis)},${generated.reviewed.runId},${JSON.stringify(generated.reviewed.data)},${now().toISOString()}) ON CONFLICT DO NOTHING`);
        await tx.run(sql`UPDATE practice_materials SET analysis_json=${JSON.stringify(generated.analysis)},generator_run_id=${generated.generatorRunId},reviewer_run_id=${generated.reviewed.runId},review_json=${JSON.stringify(generated.reviewed.data)} WHERE id=${id}`);
        await publishReviewedItems(tx,material,source,generated.analysis,now());
        await tx.run(sql`UPDATE ai_jobs SET status='completed',last_error_code=NULL,updated_at=${now().toISOString()} WHERE id=${jobId}`);
      });
    }catch(error){
      const code=error instanceof TrainingError||error instanceof RuntimeRequestError?error.code:error instanceof AiProviderError?`material_ai_${error.code}`:"material_service_failed";
      await database.write(async tx=>{
        if((await getFrom(tx,id)).lease_token!==token)return;
        const waiting=code==="request_pending";
        await tx.run(sql`UPDATE practice_materials SET status=${waiting?"queued":"failed"},lease_token=NULL,lease_until=NULL,error_code=${code},updated_at=${now().toISOString()} WHERE id=${id}`);
        await tx.run(sql`UPDATE ai_jobs SET status=${waiting?"queued":"retryable_failure"},last_error_code=${code},updated_at=${now().toISOString()} WHERE id=${jobId}`);
        if(source.sourceType==="ielts_practice")await tx.run(sql`UPDATE speaking_question_attempts SET status=${waiting?"processing":"failed"},updated_at=${now().toISOString()} WHERE id=${source.sourceId}`);
      });
    }
    material=await get(id);return material;
  }
  function process(id:string,options:MaterialProcessOptions={}){
    const current=active.get(id);if(current)return current;
    const task=run(id,options);active.set(id,task);
    void task.finally(()=>{if(active.get(id)===task)active.delete(id);}).catch(()=>undefined);return task;
  }
  return {get,inspect,prepare,prepareIn,process};
}
export type MaterialService=ReturnType<typeof createMaterialService>;
