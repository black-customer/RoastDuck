import {query as sql} from "@/lib/platform/sql";
import type {DatabasePort,SqlWriter} from "@/lib/platform/database";
import { z } from "zod";
import type {RuntimeCalls,RuntimeCallOptions} from "@/lib/ai/runtime-ledger";
import { speakingAttemptAnalysisSchema } from "@/lib/speaking-practice/schemas";
import type { MaterialInput, MaterialRow } from "./material-types";
import { hash, TrainingError } from "./shared";
import { compileEvidence, diagnosisSchema, reviewSchemaForSource,recallMaterialDraftSchema,materialDraftSchema, selectionSchemaForSource, validateDiagnosis, validateEvidenceReview, validateSelection } from "./selection-contracts";

import { STAGE_CONTRACTS,materialStageContracts,diagnosisRepairPrompt,SPOKEN_STYLE_VERSION } from "./stage-contracts";
export { STAGE_CONTRACTS, DIAGNOSIS_REPAIR_PROMPT } from "./stage-contracts";
type Stage = keyof typeof STAGE_CONTRACTS;
export type MaterialGuard = (work:(tx:SqlWriter)=>Promise<unknown>)=>Promise<unknown>;
export interface DiagnosticPlatform {database:DatabasePort;runtime:RuntimeCalls;loadPrompt:(filename:string)=>string|Promise<string>;now:()=>Date;guard:MaterialGuard;callOptions:RuntimeCallOptions}

/** 每阶段有独立输入、版本和检查点；仅网络失败重试未完成阶段，拒绝证据不被覆盖。 */
export async function runCoreDiagnosticPipeline(material:MaterialRow,platform:DiagnosticPlatform) {
  const {database,runtime,loadPrompt,now,guard}=platform;
  const source=JSON.parse(material.input_json) as MaterialInput;
  const contracts=materialStageContracts(source),repairPrompt=diagnosisRepairPrompt(source),version=source.spokenStyleVersion===SPOKEN_STYLE_VERSION?'v4':source.spokenStyleVersion==='personal-spoken-v1'?'v3':'v2';
  let active:Stage="diagnosis";
  const stage = async <T>(name:Stage,schema:z.ZodType<T>,input:unknown,promptOverride?:string) => {
    active=name;
    const spec={...contracts[name],prompt:promptOverride??contracts[name].prompt};
    const inputJson=JSON.stringify(input);
    const inputHash=hash(spec.prompt,inputJson);
    const [cached]=await database.read(db=>db.all<{run_id:string;output_json:string}>(sql`SELECT run_id,output_json FROM practice_material_stages WHERE material_id=${material.id} AND stage=${name} AND input_hash=${inputHash} AND status='completed' ORDER BY created_at DESC LIMIT 1`));
    if(cached) return {data:schema.parse(JSON.parse(cached.output_json)),runId:cached.run_id};
    const [{rejected}]=await database.read(db=>db.all<{rejected:number}>(sql`SELECT count(*) rejected FROM practice_material_stages WHERE material_id=${material.id} AND stage=${name} AND input_hash=${inputHash} AND status='rejected'`));
    const result=await runtime.call({
      role:spec.role,instructions:await loadPrompt(spec.prompt),
      input:inputJson,schema,schemaName:`four_step_${name}_${version}`,schemaVersion:`four-step-${name}-${version}${name==='selection'&&source.selectionPolicyVersion?`-${source.selectionPolicyVersion}`:''}`,promptVersion:spec.prompt,
      idempotencyKey:rejected?`${inputHash}:revision-${rejected}`:inputHash,maxOutputTokens:12000,
    },platform.callOptions);
    const data=schema.parse(result.data);
    await guard(async tx=>tx.run(sql`INSERT INTO practice_material_stages(run_id,material_id,stage,prompt_version,input_hash,input_json,output_json,created_at)
      VALUES(${result.runId},${material.id},${name},${spec.prompt},${inputHash},${inputJson},${JSON.stringify(data)},${now().toISOString()})`));
    return {data,runId:result.runId};
  };
  try {
    const [completedDiagnosis]=await database.read(db=>db.all<{run_id:string;output_json:string;input_json:string}>(sql`SELECT run_id,output_json,input_json FROM practice_material_stages WHERE material_id=${material.id} AND stage='diagnosis' AND status='completed' AND prompt_version IN (${contracts.diagnosis.prompt},${repairPrompt}) ORDER BY created_at DESC LIMIT 1`));
    let diagnosis=completedDiagnosis&&JSON.stringify(JSON.parse(completedDiagnosis.input_json).source)===JSON.stringify(source)
      ?{data:diagnosisSchema.parse(JSON.parse(completedDiagnosis.output_json)),runId:completedDiagnosis.run_id}
      :await stage("diagnosis",diagnosisSchema,{source});
    try {validateDiagnosis(source,diagnosis.data);}
    catch(error){
      if(!(error instanceof TrainingError))throw error;
      // 一次有明确校验反馈的修复，不能放宽原文覆盖，也不能无限自动调用。
      const rejected=diagnosis;
      await guard(async tx=>tx.run(sql`UPDATE practice_material_stages SET status='rejected' WHERE run_id=${rejected.runId}`));
      diagnosis=await stage("diagnosis",diagnosisSchema,{source,correction:{previousRunId:rejected.runId,previousDiagnosis:rejected.data,validationIssue:error.message}},repairPrompt);
      validateDiagnosis(source,diagnosis.data);
    }
    const selection=await stage("selection",selectionSchemaForSource(source),{source,diagnosis:diagnosis.data,diagnosisRunId:diagnosis.runId});
    validateSelection(diagnosis.data,selection.data,source);
    const draft=await stage("material",version==='v4'?recallMaterialDraftSchema:materialDraftSchema,{source,diagnosis:diagnosis.data,selection:selection.data,selectionRunId:selection.runId});
    const evidence={diagnosis:diagnosis.data,selection:selection.data,draft:draft.data};
    // 在最终审核之前校验实际下游契约，避免长引用/句子导致审核后发布失败且永久复用坏检查点。
    const analysis=speakingAttemptAnalysisSchema.parse(compileEvidence(source,evidence));
    const review=await stage("review",reviewSchemaForSource(source),{source,compiled:analysis,generatorRunId:draft.runId});
    validateEvidenceReview(evidence,review.data,source);
    return { analysis,generatorRunId:draft.runId,reviewed:{runId:review.runId,data:{approved:true,reasonZh:review.data.reasonZh,rows:analysis.learningMaterials.map((row,index)=>({index,approved:true,reasonZh:review.data.rows.find((r)=>r.gapId===row.gapId)!.reasonZh}))}} };
  } catch(error) {
    if(error instanceof TrainingError || error instanceof z.ZodError) {
      const downstream:Stage[] = error instanceof z.ZodError || active==="diagnosis" || active==="selection" ? ["diagnosis","selection","material","review"] : ["material","review"];
      for(const name of downstream) await guard(async tx=>tx.run(sql`UPDATE practice_material_stages SET status='rejected' WHERE material_id=${material.id} AND stage=${name} AND status='completed'`));
    }
    if(error instanceof z.ZodError) throw new TrainingError("材料格式或长度不符合训练要求，可以重新生成；原文已保留",422,"material_invalid_output");
    throw error;
  }
}
