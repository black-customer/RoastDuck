import {query as sql} from "@/lib/platform/sql";
import type {DatabasePort,SqlWriter} from "@/lib/platform/database";
import { z } from "zod";
import type {RuntimeCalls,RuntimeCallOptions} from "@/lib/ai/runtime-ledger";
import { speakingAttemptAnalysisSchema } from "@/lib/speaking-practice/schemas";
import type { MaterialInput, MaterialRow } from "./material-types";
import { hash, TrainingError } from "./shared";
import { compileEvidence, diagnosisSchema, reviewSchemaForSource,sentenceReviewSchemaForDraft,recallMaterialDraftSchema,materialDraftSchema, selectionSchemaForSource, validateDiagnosis, validateEvidenceReview, validateSelection,type Diagnosis } from "./selection-contracts";

import { STAGE_CONTRACTS,materialStageContracts,diagnosisRepairPrompt,SPOKEN_STYLE_VERSION } from "./stage-contracts";
import {spokenInstructions} from '@/lib/ai/spoken-register';
import {normalizeUniqueQuoteOccurrences} from './quote-normalization';
import {recoverApprovedSelection,recoverDiagnosisFromMalformedSelection,selectionSchemaForDiagnosis,type StoredReviewStage} from './selection-identity';
import {sha256Text} from '@/lib/platform/hash';
import {recoverApprovedPipeline} from './approved-pipeline';
import {teachingMaterialDraftSchema} from './selection-contracts';
export { STAGE_CONTRACTS, DIAGNOSIS_REPAIR_PROMPT } from "./stage-contracts";
type Stage = keyof typeof STAGE_CONTRACTS;
export type MaterialGuard = (work:(tx:SqlWriter)=>Promise<unknown>)=>Promise<unknown>;
export interface DiagnosticPlatform {database:DatabasePort;runtime:RuntimeCalls;loadPrompt:(filename:string)=>string|Promise<string>;now:()=>Date;guard:MaterialGuard;callOptions:RuntimeCallOptions}

/** 每阶段有独立输入、版本和检查点；仅网络失败重试未完成阶段，拒绝证据不被覆盖。 */
export async function runCoreDiagnosticPipeline(material:MaterialRow,platform:DiagnosticPlatform) {
  const {database,runtime,loadPrompt,now,guard}=platform;
  const source=JSON.parse(material.input_json) as MaterialInput;
  const contracts=materialStageContracts(source),repairPrompt=diagnosisRepairPrompt(source),version=source.teachingVersion?'v6':source.sentenceStudyVersion?'v5':source.spokenStyleVersion===SPOKEN_STYLE_VERSION?'v4':source.spokenStyleVersion==='personal-spoken-v1'?'v3':'v2';
  const canonicalDiagnosis=(value:Diagnosis)=>source.registerProfileVersion?normalizeUniqueQuoteOccurrences(source,value).diagnosis:value;
  const correctionDetails=(value:Diagnosis,issue:string)=>{
    const refs=value.units.flatMap(unit=>(['english','chinese','raw'] as const).flatMap(field=>(unit[field]??[]).map(ref=>{
      const original=source.inputFormat==='mixed-v1'?source.rawInput??'':field==='english'?source.actualAnswer:field==='chinese'?source.intendedMeaningZh:'';
      let count=0,pos=-1;while((pos=original.indexOf(ref.text,pos+1))>=0)count++;
      return {unitId:unit.id,field,text:ref.text,occurrence:ref.occurrence,validOccurrenceCount:count};
    }))).filter(ref=>ref.occurrence>=ref.validOccurrenceCount);
    return issue+'。引用text必须逐字复制；occurrence是相同引用全文的零起始出现序号，不是字符位置。只出现一次必须为0；重复引用必须选真正对应的第0/1/2…次，不能猜偏移。无效引用清单：'+JSON.stringify(refs);
  };
  let active:Stage="diagnosis";
  const stage = async <T>(name:Stage,schema:z.ZodType<T>,input:unknown,promptOverride?:string) => {
    active=name;
    const spec={...contracts[name],prompt:promptOverride??contracts[name].prompt};
    const inputJson=JSON.stringify(input);
    const inputHash=hash(spec.prompt,inputJson);
    const [cached]=await database.read(db=>db.all<{run_id:string;output_json:string}>(sql`SELECT run_id,output_json FROM practice_material_stages WHERE material_id=${material.id} AND stage=${name} AND input_hash=${inputHash} AND status='completed' ORDER BY created_at DESC LIMIT 1`));
    if(cached){const data=schema.parse(JSON.parse(cached.output_json));return {data:name==='diagnosis'?canonicalDiagnosis(data as Diagnosis) as T:data,runId:cached.run_id};}
    // Only the obsolete literal-copy/terminal-punctuation checks qualify. This
    // restores a generated draft checkpoint, never a content approval. A final
    // independent review still has to run before anything becomes learnable.
    if(name==='material'&&source.sentenceStudyVersion&&['material_natural_rewritten','material_recall_alignment'].includes(material.error_code??'')){
      const [candidate]=await database.read(tx=>tx.all<{run_id:string;input_json:string;output_json:string;response_json:string|null;receipt_state:string;run_input_hash:string;run_status:string;role:string;run_prompt:string}>(sql`SELECT s.run_id,s.input_json,s.output_json,r.response_json,r.state receipt_state,a.input_hash run_input_hash,a.status run_status,a.role,a.prompt_version run_prompt FROM practice_material_stages s JOIN ai_runs a ON a.run_id=s.run_id LEFT JOIN runtime_requests r ON r.run_id=s.run_id WHERE s.material_id=${material.id} AND s.stage='material' AND s.status='rejected' AND s.input_hash=${inputHash} AND s.prompt_version=${spec.prompt} ORDER BY s.created_at DESC LIMIT 1`));
      if(candidate?.response_json&&candidate.receipt_state==='completed'&&candidate.input_json===inputJson&&candidate.run_status==='completed'&&candidate.role===spec.role&&candidate.run_prompt===spec.prompt&&candidate.run_input_hash===sha256Text(inputJson.normalize('NFKC'))){
        const reviews=await database.read(tx=>tx.all(sql`SELECT 1 FROM practice_material_stages WHERE material_id=${material.id} AND stage='review' AND json_extract(input_json,'$.generatorRunId')=${candidate.run_id} LIMIT 1`));
        if(!reviews.length){
          const draft=schema.parse(JSON.parse(candidate.output_json)),receipt=schema.parse(JSON.parse(candidate.response_json).data);
          if(JSON.stringify(draft)===JSON.stringify(receipt)){
            const current=input as {diagnosis:Diagnosis;selection:z.infer<ReturnType<typeof selectionSchemaForSource>>};
            speakingAttemptAnalysisSchema.parse(compileEvidence(source,{diagnosis:current.diagnosis,selection:current.selection,draft:(source.teachingVersion?teachingMaterialDraftSchema:recallMaterialDraftSchema).parse(draft)}));
            await guard(tx=>tx.run(sql`UPDATE practice_material_stages SET status='completed' WHERE material_id=${material.id} AND run_id=${candidate.run_id} AND stage='material' AND status='rejected'`));
            return {data:draft,runId:candidate.run_id};
          }
        }
      }
    }
    await guard(tx=>tx.run(sql`UPDATE practice_materials SET lease_until=${new Date(now().getTime()+600000).toISOString()} WHERE id=${material.id}`));
    const [{rejected}]=await database.read(db=>db.all<{rejected:number}>(sql`SELECT count(*) rejected FROM practice_material_stages WHERE material_id=${material.id} AND stage=${name} AND input_hash=${inputHash} AND status='rejected'`));
    const result=await runtime.call({
      role:spec.role,instructions:await spokenInstructions(loadPrompt,spec.prompt,source.registerProfileVersion),
      input:inputJson,schema,schemaName:`four_step_${name}_${version}`,schemaVersion:`four-step-${name}-${version}${name==='selection'&&source.selectionPolicyVersion?`-${source.selectionPolicyVersion}`:''}${(name==='selection'||name==='review')&&source.registerProfileVersion?'-closed-ids-v1':''}`,promptVersion:spec.prompt,
      idempotencyKey:rejected?`${inputHash}:revision-${rejected}`:inputHash,maxOutputTokens:name==='diagnosis'||name==='review'?32768:24576,thinking:'low',timeoutMs:180000,
    },platform.callOptions);
    const data=schema.parse(result.data);
    await guard(async tx=>tx.run(sql`INSERT INTO practice_material_stages(run_id,material_id,stage,prompt_version,input_hash,input_json,output_json,created_at)
      VALUES(${result.runId},${material.id},${name},${spec.prompt},${inputHash},${inputJson},${JSON.stringify(data)},${now().toISOString()})`));
    // Preserve the original AI output in the stage/Runtime receipt. Only uniquely located quote
    // ordinals are canonicalized for downstream use; the publication audit reproduces this step.
    return {data:name==='diagnosis'?canonicalDiagnosis(data as Diagnosis) as T:data,runId:result.runId};
  };
  try {
    const approved=await database.read(tx=>recoverApprovedPipeline(tx,material));
    if(approved){
      await guard(async tx=>{for(const runId of approved.stageRunIds)await tx.run(sql`UPDATE practice_material_stages SET status='completed' WHERE material_id=${material.id} AND run_id=${runId} AND status='rejected'`);});
      return {analysis:approved.analysis,generatorRunId:approved.generatorRunId,reviewed:approved.reviewed};
    }
    const [completedDiagnosis]=await database.read(db=>db.all<{run_id:string;output_json:string;input_json:string}>(sql`SELECT run_id,output_json,input_json FROM practice_material_stages WHERE material_id=${material.id} AND stage='diagnosis' AND status='completed' AND prompt_version IN (${contracts.diagnosis.prompt},${repairPrompt}) ORDER BY created_at DESC LIMIT 1`));
    const [previousSelection]=!completedDiagnosis?await database.read(db=>db.all<StoredReviewStage>(sql`SELECT * FROM practice_material_stages WHERE material_id=${material.id} AND stage='selection' AND status='rejected' ORDER BY created_at DESC LIMIT 1`)):[];
    const previousInput=previousSelection?JSON.parse(previousSelection.input_json):null;
    const [referencedDiagnosis]=previousInput?.diagnosisRunId?await database.read(tx=>tx.all<StoredReviewStage>(sql`SELECT * FROM practice_material_stages WHERE material_id=${material.id} AND run_id=${previousInput.diagnosisRunId} AND stage='diagnosis'`)):[];
    const approvedCheckpoint=previousSelection&&referencedDiagnosis?recoverApprovedSelection(source,previousSelection,referencedDiagnosis):null;
    const reusedDiagnosis=previousSelection&&referencedDiagnosis?recoverDiagnosisFromMalformedSelection(source,previousSelection,referencedDiagnosis):null;
    const [previousDiagnosis]=!completedDiagnosis?await database.read(db=>db.all<{run_id:string;input_json:string;output_json:string}>(sql`SELECT run_id,input_json,output_json FROM practice_material_stages WHERE material_id=${material.id} AND stage='diagnosis' AND status='rejected' ORDER BY created_at DESC LIMIT 1`)):[];
    const feedbackRepair=previousSelection&&JSON.stringify(previousInput?.source)===JSON.stringify(source)?{source,correction:{previousRunId:previousInput.diagnosisRunId,previousDiagnosis:previousInput.diagnosis,validationIssue:'独立审核反馈：'+JSON.parse(previousSelection.output_json).reasonZh+'。必须按同一意思合并中英文证据，允许同一unit引用非连续raw片段；重复/自我修正也保留全部来源，但不重复制卡。中文重复不等于natural：将对应英文放入同一unit，按其真实错误或自然成功判断。',reviewRunId:previousSelection.run_id,review:JSON.parse(previousSelection.output_json)}}:null;
    if(feedbackRepair){
      const [referenced]=await database.read(tx=>tx.all<{output_json:string}>(sql`SELECT output_json FROM practice_material_stages WHERE material_id=${material.id} AND stage='diagnosis' AND status='rejected' AND run_id=${feedbackRepair.correction.previousRunId}`));
      if(referenced)feedbackRepair.correction.previousDiagnosis=JSON.parse(referenced.output_json);
    }
    const structuralRepair=!feedbackRepair&&previousDiagnosis&&JSON.stringify(JSON.parse(previousDiagnosis.input_json).source)===JSON.stringify(source)?{source,correction:{previousRunId:previousDiagnosis.run_id,previousDiagnosis:JSON.parse(previousDiagnosis.output_json),validationIssue:correctionDetails(diagnosisSchema.parse(JSON.parse(previousDiagnosis.output_json)),'上一份诊断未通过原文引用或覆盖校验，请按原文修订')}}:null;
    let diagnosis=approvedCheckpoint?{data:approvedCheckpoint.diagnosis,runId:approvedCheckpoint.diagnosisRunId}:reusedDiagnosis?{data:reusedDiagnosis.diagnosis,runId:reusedDiagnosis.diagnosisRunId}:completedDiagnosis&&JSON.stringify(JSON.parse(completedDiagnosis.input_json).source)===JSON.stringify(source)
      ?{data:canonicalDiagnosis(diagnosisSchema.parse(JSON.parse(completedDiagnosis.output_json))),runId:completedDiagnosis.run_id}
      :feedbackRepair||structuralRepair?await stage('diagnosis',diagnosisSchema,feedbackRepair??structuralRepair,repairPrompt):await stage("diagnosis",diagnosisSchema,{source});
    try {validateDiagnosis(source,diagnosis.data);}
    catch(error){
      if(!(error instanceof TrainingError))throw error;
      if(feedbackRepair||structuralRepair)throw error;
      // 一次有明确校验反馈的修复，不能放宽原文覆盖，也不能无限自动调用。
      const rejected=diagnosis;
      await guard(async tx=>tx.run(sql`UPDATE practice_material_stages SET status='rejected' WHERE run_id=${rejected.runId}`));
      const [rawPrevious]=await database.read(tx=>tx.all<{output_json:string}>(sql`SELECT output_json FROM practice_material_stages WHERE run_id=${rejected.runId}`));
      const prior=diagnosisSchema.parse(JSON.parse(rawPrevious.output_json));
      diagnosis=await stage("diagnosis",diagnosisSchema,{source,correction:{previousRunId:rejected.runId,previousDiagnosis:prior,validationIssue:correctionDetails(prior,error.message)}},repairPrompt);
      validateDiagnosis(source,diagnosis.data);
    }
    active='selection';
    const selection=approvedCheckpoint?{data:approvedCheckpoint.selection,runId:approvedCheckpoint.selectionRunId}:await stage("selection",source.registerProfileVersion?selectionSchemaForDiagnosis(source,diagnosis.data):selectionSchemaForSource(source),{source,diagnosis:diagnosis.data,diagnosisRunId:diagnosis.runId});
    validateSelection(diagnosis.data,selection.data,source);
    // Only a new, structurally valid and positive independent selection can re-accept
    // this exact original diagnostic run. All rejected review rows remain unchanged.
    if(reusedDiagnosis)await guard(tx=>tx.run(sql`UPDATE practice_material_stages SET status='completed' WHERE material_id=${material.id} AND run_id=${diagnosis.runId} AND stage='diagnosis' AND status='rejected'`));
    if(approvedCheckpoint)await guard(tx=>tx.run(sql`UPDATE practice_material_stages SET status='completed' WHERE material_id=${material.id} AND run_id IN (${diagnosis.runId},${selection.runId}) AND status='rejected'`));
    const draft=await stage("material",source.teachingVersion?teachingMaterialDraftSchema:version==='v4'||version==='v5'?recallMaterialDraftSchema:materialDraftSchema,{source,diagnosis:diagnosis.data,selection:selection.data,selectionRunId:selection.runId});
    const evidence={diagnosis:diagnosis.data,selection:selection.data,draft:draft.data};
    // 在最终审核之前校验实际下游契约，避免长引用/句子导致审核后发布失败且永久复用坏检查点。
    const analysis=speakingAttemptAnalysisSchema.parse(compileEvidence(source,evidence));
    const review=await stage("review",source.registerProfileVersion?sentenceReviewSchemaForDraft(draft.data,!!source.teachingVersion):reviewSchemaForSource(source),{source,compiled:analysis,generatorRunId:draft.runId});
    validateEvidenceReview(evidence,review.data,source);
    return { analysis,generatorRunId:draft.runId,reviewed:{runId:review.runId,data:{approved:true,reasonZh:review.data.reasonZh,rows:analysis.learningMaterials.map((row,index)=>({index,approved:true,reasonZh:review.data.rows.find((r)=>r.gapId===row.gapId)!.reasonZh}))}} };
  } catch(error) {
    if(error instanceof TrainingError || error instanceof z.ZodError) {
      const downstream:Stage[] = error instanceof TrainingError&&error.code==='material_selection_identity'?["selection","material","review"]:error instanceof z.ZodError || active==="diagnosis" || active==="selection" ? ["diagnosis","selection","material","review"] : ["material","review"];
      for(const name of downstream) await guard(async tx=>tx.run(sql`UPDATE practice_material_stages SET status='rejected' WHERE material_id=${material.id} AND stage=${name} AND status='completed'`));
    }
    if(error instanceof z.ZodError) throw new TrainingError("材料格式或长度不符合训练要求，可以重新生成；原文已保留",422,"material_invalid_output");
    throw error;
  }
}
