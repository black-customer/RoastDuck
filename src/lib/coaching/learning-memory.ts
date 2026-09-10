import type {DatabasePort,SqlWriter} from '@/lib/platform/database';
import {query as sql} from '@/lib/platform/sql';
import type {RuntimeCalls,RuntimeCallOptions} from '@/lib/ai/runtime-ledger';
import type {MemoryJob,AppMemory} from '@/lib/app-services/memory';
import {normalizeKey,parseJson,sensitiveMemory,stableId} from '@/lib/app-services/shared';
import {TrainingError} from '@/lib/four-step/shared';
import {learningErrorReviewSchema,type LearningErrorReviewInput} from './contracts';
import type {MaterialInput,MaterialRow} from '@/lib/four-step/material-types';
import {speakingAttemptAnalysisSchema} from '@/lib/speaking-practice/schemas';
import {auditPracticeMaterials} from '@/lib/four-step/audit';
import {evidenceReviewSchema,locateQuote} from '@/lib/four-step/selection-contracts';
import {normalizeExpression,findTargetSpan} from '@/lib/four-step/contracts';
import {sha256Text} from '@/lib/platform/hash';

type Control={generation:number;cutoffs_json:string};
export interface LearningOccurrence {
  occurrenceId?:string;messageId?:string;materialId?:string;sourceType?:string;sourceId?:string;sourceVersion?:string;sourceHash?:string;gapId?:string;
  quote:string;correction:string;reviewerReason:string;reviewerRunId:string;generatorRunId:string;
  assisted:boolean;assistance?:'assisted'|'independent'|'unknown';mode:string;at:string;intentZh?:string;
  kind?:'confirmed_error'|'correct_form_observed';
  reviewedVersions?:Array<{materialId:string;sourceVersion:string;reviewerRunId:string;generatorRunId:string}>;
}
export interface TeacherMemory {
  id:string;summary:string;category:string;
  learning?:{memoryKey:string;mistake:string;correction:string;reasonZh:string;intentZh:string;assisted:boolean;sourceId:string;observedAt:string;recentEvidenceKind:string};
}
/** Structured, bounded teacher context. No full private transcript or unrelated metadata enters the request. */
export function teacherMemory(memory:AppMemory):TeacherMemory{
  const base={id:memory.id,summary:memory.summary,category:memory.category};
  if(memory.category!=='learning')return base;
  const detail=parseJson<{memoryKey?:string;correction?:string;occurrences?:LearningOccurrence[]}>(memory.detail_json,{});
  const occurrences=[...detail.occurrences??[]].sort((a,b)=>a.at.localeCompare(b.at)),lastError=[...occurrences].reverse().find(e=>(e.kind??'confirmed_error')==='confirmed_error');
  if(!lastError||sensitiveMemory([lastError.quote,lastError.correction,lastError.reviewerReason].join(' ')))return base;
  return {...base,learning:{memoryKey:(detail.memoryKey??'').replace(/^language:/,''),mistake:lastError.quote.slice(0,1200),correction:lastError.correction.slice(0,1600),reasonZh:lastError.reviewerReason.slice(0,1000),intentZh:lastError.intentZh??'',assisted:lastError.assisted,sourceId:lastError.sourceId??lastError.messageId??memory.source_id,observedAt:lastError.at,recentEvidenceKind:occurrences.at(-1)?.kind??'confirmed_error'}};
}

async function appendLearningEvidenceIn(tx:SqlWriter,key:string,summary:string,correction:string,evidence:LearningOccurrence,sourceType:string,sourceId:string,confidence:number,at:string){
  const prior=await tx.all<AppMemory>(sql`SELECT * FROM companion_memories WHERE category='learning' AND json_extract(detail_json,'$.memoryKey')=${key} ORDER BY created_at DESC`);
  if(prior.some(m=>['deleted','dismissed'].includes(m.status)&&!prior.some(a=>a.status==='active'&&parseJson<{userRestored?:boolean}>(a.detail_json,{}).userRestored)))return {state:'revoked' as const,memory:null};
  const current=prior.find(m=>m.status==='active');
  if(current){
    const detail=parseJson<{occurrences?:LearningOccurrence[]} & Record<string,unknown>>(current.detail_json,{}),occurrences=detail.occurrences??[];
    const same=occurrences.find(e=>evidence.occurrenceId?e.occurrenceId===evidence.occurrenceId:e.messageId===evidence.messageId&&e.kind===evidence.kind);
    if(same){
      if(evidence.materialId&&evidence.sourceVersion&&same.materialId!==evidence.materialId&&!same.reviewedVersions?.some(v=>v.materialId===evidence.materialId)){
        same.reviewedVersions=[...same.reviewedVersions??[],{materialId:evidence.materialId,sourceVersion:evidence.sourceVersion,reviewerRunId:evidence.reviewerRunId,generatorRunId:evidence.generatorRunId}];
        await tx.run(sql`UPDATE companion_memories SET detail_json=${JSON.stringify({...detail,occurrences})},updated_at=${at} WHERE id=${current.id} AND status='active'`);
      }
      return {state:'unchanged' as const,memory:current};
    }
    const ids=[...new Set([...parseJson<string[]>(current.evidence_json,[]),evidence.messageId??sourceId])];
    await tx.run(sql`UPDATE companion_memories SET detail_json=${JSON.stringify({...detail,occurrences:[...occurrences,evidence]})},evidence_json=${JSON.stringify(ids)},updated_at=${at} WHERE id=${current.id} AND status='active'`);
    return {state:'updated' as const,memory:current};
  }
  const id=stableId('learning_memory',key,normalizeKey(correction));
  if((await tx.all(sql`SELECT id FROM companion_memories WHERE id=${id}`)).length)return {state:'unchanged' as const,memory:null};
  await tx.run(sql`INSERT INTO companion_memories(id,category,summary,detail_json,confidence,source_type,source_id,evidence_json,status,created_at,updated_at)
    VALUES(${id},'learning',${summary},${JSON.stringify({memoryKey:key,correction,occurrences:[evidence]})},${confidence},${sourceType},${sourceId},${JSON.stringify([evidence.messageId??sourceId])},'active',${at},${at})`);
  return {state:'created' as const,memory:(await tx.all<AppMemory>(sql`SELECT * FROM companion_memories WHERE id=${id}`))[0]};
}

/** Call after publication, inside that transaction. Reuses the already completed independent review, never calls AI. */
export async function recordReviewedAnswerMemoriesIn(tx:SqlWriter,materialId:string,at:Date,options:{allowMock?:boolean;expectedGeneration?:number}={}){
  const result={created:0,updated:0,skipped:0,cutoffBlocked:false};
  const [material]=await tx.all<MaterialRow>(sql`SELECT * FROM practice_materials WHERE id=${materialId}`);
  if(!material||material.status!=='ready')throw new TrainingError('只有已发布的审核材料可以进入学习记忆',409,'memory_material_not_ready');
  const input=JSON.parse(material.input_json) as MaterialInput;
  const [control]=await tx.all<Control>(sql`SELECT * FROM companion_memory_control WHERE singleton=1`);
  const cutoffs=parseJson<Record<string,number>>(control?.cutoffs_json??'{}',{});
  const revokedSource=cutoffs['@material:'+material.id]||cutoffs['@answer:'+input.sourceId]||(input.sourceType==='free_talk'&&input.sourceMessages?.filter(m=>m.role==='user').every(m=>cutoffs['@free-talk:'+m.id]));
  if(revokedSource||options.expectedGeneration!==undefined&&options.expectedGeneration!==(control?.generation??0)){result.cutoffBlocked=true;return result;}
  const audit=await auditPracticeMaterials({execute:async command=>({rows:await tx.all<Record<string,unknown>>(typeof command==='string'?{sql:command}:command)})},options.allowMock===true,[materialId]);
  if(!audit.ok||audit.checked!==1)throw new TrainingError('学习记忆缺少当前来源的独立审核证据',422,'memory_material_unverified');
  const analysis=speakingAttemptAnalysisSchema.parse(JSON.parse(material.analysis_json));
  if(!analysis.evidence){result.skipped=analysis.gaps.length;return result;}
  const [stage]=await tx.all<{run_id:string;output_json:string}>(sql`SELECT run_id,output_json FROM practice_material_stages WHERE material_id=${materialId} AND run_id=${material.reviewer_run_id} AND stage='review' AND status='completed'`);
  if(!stage||!material.generator_run_id||stage.run_id===material.generator_run_id)throw new TrainingError('学习记忆必须引用独立审核请求',422,'memory_material_unverified');
  const finalReview=evidenceReviewSchema.parse(JSON.parse(stage.output_json));
  const [draft]=input.sourceType==='ielts_practice'?await tx.all<{kind:string;english_committed_at:string|null}>(sql`SELECT kind,english_committed_at FROM answer_drafts WHERE submitted_attempt_id=${input.sourceId} ORDER BY created_at DESC LIMIT 1`):[];
  const assisted=!(draft?.kind==='independent'&&draft.english_committed_at);
  const [sourceDate]=input.sourceType==='ielts_practice'?await tx.all<{created_at:string}>(sql`SELECT created_at FROM speaking_question_attempts WHERE id=${input.sourceId}`):[];
  for(const unit of analysis.evidence.diagnosis.units)for(const gap of unit.gaps){
    const selection=analysis.evidence.selection.gaps.find(g=>g.gapId===gap.id),unitReview=analysis.evidence.selection.units.find(u=>u.unitId===unit.id),review=finalReview.rows.find(r=>r.gapId===gap.id);
    const row=analysis.learningMaterials.find(r=>r.gapId===gap.id);
    const englishQuote=gap.evidenceQuote.trim(),normalQuote=normalizeExpression(englishQuote);
    const isEnglish=/[A-Za-z]/.test(englishQuote)&&!/[\u3400-\u9fff]/.test(englishQuote);
    const sourceHasQuote=input.actualAnswer.includes(englishQuote)&&unit.english.some(ref=>ref.text.includes(englishQuote));
    const existingNaturalVariant=[gap.targetEnglish,...gap.acceptableVariants].some(v=>normalizeExpression(v)===normalQuote);
    if(unit.status!=='repair'||unitReview?.status!=='repair'||selection?.decision!=='train'||gap.kind==='unexpressed_intention'||row?.learningBasis!=='confirmed_error'||!review?.approved||!review.repairNeeded||!review.meaningPreserved||!isEnglish||!sourceHasQuote||existingNaturalVariant||sensitiveMemory(englishQuote+' '+gap.whyNeededZh)) {result.skipped++;continue;}
    const rowIndex=analysis.learningMaterials.indexOf(row),[link]=await tx.all<{learning_item_id:string}>(sql`SELECT learning_item_id FROM practice_material_items WHERE material_id=${materialId} AND row_index=${rowIndex}`);
    if(!link){result.skipped++;continue;}
    let userMessage:{id:string;role:string;text:string}|undefined;
    if(input.sourceType==='free_talk'){
      const ref=unit.english.find(q=>q.text.includes(englishQuote))!,start=locateQuote(input.actualAnswer,ref).start+ref.text.indexOf(englishQuote);
      let offset=0;
      for(const message of input.sourceMessages?.filter(m=>m.role==='user')??[]){
        if(start>=offset&&start+englishQuote.length<=offset+message.text.length){userMessage=message;break;}
        offset+=message.text.length+1;
      }
      if(!userMessage){result.skipped++;continue;}
    }
    if(userMessage&&cutoffs['@free-talk:'+userMessage.id]){result.skipped++;continue;}
    const key='language:'+stableId('answer_error',link.learning_item_id),sourceId=userMessage?.id??input.sourceId;
    const occurrenceId=stableId('reviewed_answer_error',input.sourceType,sourceId,link.learning_item_id,normalQuote);
    const occurrence:LearningOccurrence={occurrenceId,materialId,sourceType:input.sourceType,sourceId,sourceVersion:sha256Text(material.analysis_json),sourceHash:material.input_hash,gapId:gap.id,
      quote:englishQuote,correction:row.surfaceInSentence??gap.targetEnglish,reviewerReason:review.reasonZh,generatorRunId:material.generator_run_id,reviewerRunId:stage.run_id,
      assisted,assistance:!assisted?'independent':draft?.kind==='edit'?'assisted':'unknown',mode:draft?.kind??input.mode,intentZh:gap.cueZh,at:sourceDate?.created_at??material.created_at,kind:'confirmed_error'};
    const written=await appendLearningEvidenceIn(tx,key,gap.whyNeededZh,occurrence.correction,occurrence,'reviewed_answer',input.sourceId,.9,at.toISOString());
    if(written.state==='created')result.created++;else if(written.state==='updated')result.updated++;else result.skipped++;
  }
  return result;
}

/** Records positive observable use only; no mention is not improvement, and this never changes mastery/FSRS. */
export async function recordCoachingUseEvidenceIn(tx:SqlWriter,input:{messageId:string;text:string;memoryIds:string[];verdict:string;extent:string;assisted:boolean;mode:string;runId:string;at:string}){
  if(input.verdict!=='natural'||input.extent==='uncertain'||!/[A-Za-z]/.test(input.text)||sensitiveMemory(input.text))return 0;
  const [source]=await tx.all<{text:string}>(sql`SELECT text FROM companion_messages WHERE id=${input.messageId} AND role='user'`);
  const [control]=await tx.all<Control>(sql`SELECT * FROM companion_memory_control WHERE singleton=1`);
  if(source?.text!==input.text||parseJson<Record<string,number>>(control?.cutoffs_json??'{}',{})['@'+input.messageId])return 0;
  let count=0;
  for(const id of [...new Set(input.memoryIds)].slice(0,input.mode==='sentence_guided'?1:2)){
    const [memory]=await tx.all<AppMemory>(sql`SELECT * FROM companion_memories WHERE id=${id} AND category='learning' AND status='active'`);if(!memory)continue;
    const detail=parseJson<{memoryKey?:string;correction?:string;occurrences?:LearningOccurrence[]}>(memory.detail_json,{}),correction=detail.correction??'';
    if((correction.match(/[A-Za-z]+/g)??[]).length<2||/(?:\.{3}|…|\b(?:something|someone)\b|\[[^\]]+\])/.test(correction))continue;
    const span=findTargetSpan(input.text,[correction]);if(!span)continue;
    const enclosingQuote=/(?:["“‘][^"”’]*$|(?:^|\s)'[^']*$)/.test(input.text.slice(0,span.start))&&/["”’']/.test(input.text.slice(span.end));
    const metaComment=/\b(?:phrase|expression|grammar|wording|sentence|quote)\b|这个表达|这个句子|这个词|应该说|英文是/i.test(input.text);
    // Merely naming or quoting the correction is not proof of using it to answer the task.
    if(enclosingQuote||metaComment)continue;
    const priorError=[...detail.occurrences??[]].reverse().find(e=>(e.kind??'confirmed_error')==='confirmed_error');if(!priorError)continue;
    const evidence:LearningOccurrence={occurrenceId:stableId('correct_form_observed',input.messageId,id),messageId:input.messageId,quote:span.surface,correction,
      reviewerReason:'本次文本出现了已审核的正确表达，且本轮反馈判为自然；只证明此处使用，不代表已掌握全部意思。',reviewerRunId:priorError.reviewerRunId,generatorRunId:input.runId,assisted:input.assisted,mode:input.mode,at:input.at,kind:'correct_form_observed'};
    const outcome=await appendLearningEvidenceIn(tx,detail.memoryKey??'',memory.summary,correction,evidence,memory.source_type,memory.source_id,memory.confidence,input.at);
    if(outcome.state==='updated')count++;
  }
  return count;
}
/** Queue in the same transaction as the teacher reply. A lost HTTP response cannot lose the review. */
export async function queueLearningReviewIn(tx:SqlWriter,input:LearningErrorReviewInput,at:string){
  if(!input.findings.length||sensitiveMemory(input.text))return null;
  const [control]=await tx.all<Control>(sql`SELECT * FROM companion_memory_control WHERE singleton=1`);
  const [source]=await tx.all<{sequence_no:number}>(sql`SELECT sequence_no FROM companion_messages WHERE id=${input.messageId} AND thread_id=${input.threadId} AND role='user'`);
  const cutoffs=parseJson<Record<string,number>>(control?.cutoffs_json??'{}',{});
  if(!source||cutoffs['@'+input.messageId]||(cutoffs[input.threadId]??0)>=source.sequence_no)return null;
  const id=stableId('learning_review',input.messageId,'v1');
  await tx.run(sql`INSERT INTO companion_memory_jobs(id,thread_id,generation,input_json,status,created_at,updated_at)
    VALUES(${id},${input.threadId},${control?.generation??0},${JSON.stringify(input)},'pending',${at},${at}) ON CONFLICT DO NOTHING`);
  return id;
}

export async function processLearningReview(database:DatabasePort,runtime:RuntimeCalls,platform:{now:()=>Date;loadPrompt:(name:string)=>string|Promise<string>},job:MemoryJob,input:LearningErrorReviewInput,options:RuntimeCallOptions):Promise<AppMemory[]>{
  const active=await database.read(async tx=>{
    const [control]=await tx.all<Control>(sql`SELECT * FROM companion_memory_control WHERE singleton=1`);
    const [current]=await tx.all<MemoryJob>(sql`SELECT * FROM companion_memory_jobs WHERE id=${job.id}`);
    return current&&['pending','failed'].includes(current.status)&&job.generation===(control?.generation??0);
  });
  if(!active)return [];
  const result=await runtime.call({role:'gap_reviewer',instructions:await platform.loadPrompt('coaching_error.reviewer.v1.md'),
    input:JSON.stringify({text:input.text,intentZh:input.intentZh,questionEn:input.questionEn,mode:input.mode,assisted:input.assisted,candidates:input.findings}),
    schema:learningErrorReviewSchema,schemaName:'coaching_error_reviewer_v1',promptVersion:'coaching-error-reviewer-v1',schemaVersion:'coaching-error-reviewer-v1',idempotencyKey:job.id},options);
  if(result.runId===input.generatorRunId)throw new TrainingError('问题审核必须由独立请求完成',422,'coaching_review_not_independent');
  const indices=result.data.decisions.map(d=>d.index);
  if(indices.length!==input.findings.length||new Set(indices).size!==indices.length||indices.some(i=>!input.findings[i]))throw new TrainingError('问题审核未覆盖本次输出',422,'coaching_review_coverage');
  return database.write(async tx=>{
    const [control]=await tx.all<Control>(sql`SELECT * FROM companion_memory_control WHERE singleton=1`);
    const [current]=await tx.all<MemoryJob>(sql`SELECT * FROM companion_memory_jobs WHERE id=${job.id}`);
    if(!current||!['pending','failed'].includes(current.status)||job.generation!==(control?.generation??0))return [];
    const [source]=await tx.all<{text:string;metadata_json:string}>(sql`SELECT text,metadata_json FROM companion_messages WHERE id=${input.messageId} AND role='user' AND thread_id=${input.threadId}`);
    if(source?.text!==input.text)throw new TrainingError('原输出已变化，不能写入旧问题',409,'coaching_source_changed');
    const added:AppMemory[]=[];
    for(const decision of result.data.decisions){
      const candidate=input.findings[decision.index];
      if(!decision.confirmed||decision.confidence<.8||candidate.kind!=='confirmed_error'||decision.sourceQuote!==candidate.sourceQuote||!input.text.includes(candidate.sourceQuote))continue;
      if(!candidate.correction||sensitiveMemory(candidate.explanationZh+' '+candidate.correction))continue;
      const context=parseJson<{payload?:{relevantMemories?:TeacherMemory[]}}>(source.metadata_json,{});
      // A reoccurring mistake may reuse a supplied reviewed identity only when both the exact
      // mistake and its established correction agree. Similar topics alone never merge senses.
      const matches=(context.payload?.relevantMemories??[]).filter(m=>m.learning&&normalizeExpression(m.learning.mistake)===normalizeExpression(candidate.sourceQuote)
        &&(m.learning.correction.match(/[A-Za-z]+/g)??[]).length>=2&&findTargetSpan(candidate.correction,[m.learning.correction]));
      const revoked=await tx.all<AppMemory>(sql`SELECT * FROM companion_memories WHERE category='learning' AND status IN ('deleted','dismissed')`);
      if(revoked.some(memory=>{
        const detail=parseJson<{occurrences?:LearningOccurrence[]}>(memory.detail_json,{});
        return detail.occurrences?.some(e=>(e.kind??'confirmed_error')==='confirmed_error'&&normalizeExpression(e.quote)===normalizeExpression(candidate.sourceQuote)
          &&(e.correction.match(/[A-Za-z]+/g)??[]).length>=2&&findTargetSpan(candidate.correction,[e.correction]));
      }))continue;
      const key=matches.length===1?'language:'+matches[0].learning!.memoryKey:'language:'+candidate.memoryKey;
      const evidence:LearningOccurrence={occurrenceId:stableId('confirmed_coaching_error',input.messageId,key),messageId:input.messageId,quote:candidate.sourceQuote,correction:candidate.correction,reviewerReason:decision.reasonZh,reviewerRunId:result.runId,generatorRunId:input.generatorRunId,assisted:input.assisted,mode:input.mode,intentZh:input.intentZh,at:platform.now().toISOString(),kind:'confirmed_error'};
      const written=await appendLearningEvidenceIn(tx,key,candidate.explanationZh,candidate.correction,evidence,'coaching_output',input.messageId,decision.confidence,platform.now().toISOString());
      if(written.state==='created'&&written.memory)added.push(written.memory);
    }
    await tx.run(sql`UPDATE companion_memory_jobs SET status='completed',error_code=NULL,updated_at=${platform.now().toISOString()} WHERE id=${job.id}`);
    return added;
  });
}
