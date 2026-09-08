import {z} from 'zod';
import type {DatabasePort} from '@/lib/platform/database';
import {query as sql} from '@/lib/platform/sql';
import type {RuntimeCalls,RuntimeCallOptions} from '@/lib/ai/runtime-ledger';
import {speakingAttemptAnalysisSchema} from '@/lib/speaking-practice/schemas';
import {hash,TrainingError} from '@/lib/four-step/shared';
import type {AppAttempt,AnswerDraft} from './answers';
import {AiProviderError} from '@/lib/ai/errors';
export const comparisonSchema=z.object({comparisons:z.array(z.object({index:z.number().int().nonnegative(),state:z.enum(['improved','repeated','uncertain']),evidenceQuote:z.string().max(2000),reasonZh:z.string().min(1).max(1000)})).max(100),newItemIndexes:z.array(z.number().int().nonnegative()).max(100)});
export type PracticeComparison=z.infer<typeof comparisonSchema>;
export function assertComparisonOutput(raw:unknown,input:unknown){
  const result=comparisonSchema.parse(raw),payload=z.object({currentEnglish:z.string(),oldItems:z.array(z.unknown()),currentItems:z.array(z.unknown())}).parse(input),indices=result.comparisons.map(c=>c.index);
  if(indices.length!==payload.oldItems.length||new Set(indices).size!==indices.length||indices.some(i=>i>=payload.oldItems.length)||result.newItemIndexes.some(i=>i>=payload.currentItems.length)||result.comparisons.some(r=>r.state!=='uncertain'&&(!r.evidenceQuote.trim()||!payload.currentEnglish.includes(r.evidenceQuote))))throw new AiProviderError('比较缺少有效原句依据','invalid_output',false);
}
const version='practice-reanswer-comparison-v1';
export function createPracticeComparison(database:DatabasePort,runtime:RuntimeCalls,loadPrompt:(name:string)=>string|Promise<string>){
  async function source(id:string){return database.read(async tx=>{
    const [origin]=await tx.all<AnswerDraft>(sql`SELECT * FROM answer_drafts WHERE submitted_attempt_id=${id}`);
    if(!origin?.source_attempt_id||origin.kind!=='independent'||!origin.english_committed_at)return null;
    const [current]=await tx.all<AppAttempt>(sql`SELECT * FROM speaking_question_attempts WHERE id=${id}`),[previous]=await tx.all<AppAttempt>(sql`SELECT * FROM speaking_question_attempts WHERE id=${origin.source_attempt_id}`);
    if(!current||!previous||current.question_id!==previous.question_id)throw new TrainingError('重答来源不完整',409,'comparison_source');
    if(current.status!=='completed')return {status:'waiting_materials' as const};
    const old=speakingAttemptAnalysisSchema.safeParse(JSON.parse(previous.analysis_json)),next=speakingAttemptAnalysisSchema.safeParse(JSON.parse(current.analysis_json));
    if(!old.success||!next.success)return {status:'source_unavailable' as const};
    const payload={previousId:previous.id,currentId:current.id,previousEnglish:previous.answer_text,currentEnglish:current.answer_text,previousChinese:previous.intended_meaning_zh,currentChinese:current.intended_meaning_zh,
      oldItems:old.data.learningMaterials.map((r,index)=>({index,intentZh:r.chineseChunk,target:r.englishChunk,evidence:r.originalEnglish??''})),currentItems:next.data.learningMaterials.map((r,index)=>({index,intentZh:r.chineseChunk,target:r.englishChunk,evidence:r.originalEnglish??''}))};
    const jobId=`comparison_${hash(version,JSON.stringify(payload)).slice(0,24)}`;
    return {status:'ready' as const,origin,previous,current,payload,jobId};
  });}
  async function get(id:string){
    const data=await source(id);if(!data||data.status!=='ready')return data;
    return database.read(async tx=>{
      const [job]=await tx.all<{status:string;last_error_code:string|null}>(sql`SELECT status,last_error_code FROM ai_jobs WHERE id=${data.jobId}`);
      const [receipt]=await tx.all<{response_json:string;run_id:string}>(sql`SELECT r.response_json,r.run_id FROM runtime_requests r JOIN ai_runs a ON a.run_id=r.run_id WHERE a.job_id=${data.jobId} AND r.state='completed' ORDER BY a.created_at DESC LIMIT 1`);
      const result=job?.status==='completed'&&receipt?comparisonSchema.parse(JSON.parse(receipt.response_json).data):null;
      const day=(date:string)=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date(date));
      return {status:job?.status??'not_started',errorCode:job?.last_error_code??null,result,payload:data.payload,independent:true,sameDay:day(data.previous.created_at)===day(data.origin.english_committed_at!),runId:receipt?.run_id??null};
    });
  }
  async function process(id:string,options:RuntimeCallOptions={}){
    const data=await source(id);if(!data||data.status!=='ready')return get(id);
    const timestamp=new Date().toISOString();
    await database.write(tx=>tx.run(sql`INSERT INTO ai_jobs(id,kind,status,target_type,target_id,idempotency_key,prompt_version,schema_version,payload_json,created_at,updated_at) VALUES(${data.jobId},'practice_reanswer_comparator','queued','speaking_question_attempt',${id},${data.jobId},${version},${version},${JSON.stringify(data.payload)},${timestamp},${timestamp}) ON CONFLICT DO NOTHING`));
    try{
      const result=await runtime.call({role:'reattempt_comparator',instructions:await loadPrompt('practice_reanswer_comparison.v1.md'),input:JSON.stringify(data.payload),schema:comparisonSchema,schemaName:'practice_reanswer_comparison_v1',promptVersion:version,schemaVersion:version,idempotencyKey:data.jobId},{...options,jobId:data.jobId});
      const indices=result.data.comparisons.map(c=>c.index);
      if(indices.length!==data.payload.oldItems.length||new Set(indices).size!==indices.length||indices.some(i=>!data.payload.oldItems[i])||result.data.newItemIndexes.some(i=>!data.payload.currentItems[i]))throw new TrainingError('对照未覆盖实际问题，保留原回答',422,'comparison_invalid');
      for(const row of result.data.comparisons)if(row.state!=='uncertain'&&(!row.evidenceQuote.trim()||!data.current.answer_text.includes(row.evidenceQuote)))throw new TrainingError('对照缺少本次英文原句依据',422,'comparison_no_evidence');
      await database.write(tx=>tx.run(sql`UPDATE ai_jobs SET status='completed',last_error_code=NULL,updated_at=${new Date().toISOString()} WHERE id=${data.jobId}`));
    }catch(error){const code=error&&typeof error==='object'&&'code' in error?String(error.code):'comparison_failed';await database.write(tx=>tx.run(sql`UPDATE ai_jobs SET status='retryable_failure',last_error_code=${code},updated_at=${new Date().toISOString()} WHERE id=${data.jobId}`));}
    return get(id);
  }
  return {get,process};
}
