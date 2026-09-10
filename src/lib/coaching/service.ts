import {SPOKEN_REGISTER_VERSION,spokenInstructions} from '@/lib/ai/spoken-register';
import type {DatabasePort,SqlWriter} from '@/lib/platform/database';
import {query as sql} from '@/lib/platform/sql';
import type {RuntimeCalls,RuntimeCallOptions} from '@/lib/ai/runtime-ledger';
import type {MemoryService} from '@/lib/app-services/memory';
import {credentialValue,parseJson,stableId} from '@/lib/app-services/shared';
import {TrainingError} from '@/lib/four-step/shared';
import {coachingContextSchema,coachingSubmitSchema,coachingFeedbackSchema,type CoachingContext,type CoachingMaterial,type CoachingSubmit,type CoachingFeedback,type CoachingView} from './contracts';
import {queueLearningReviewIn,recordCoachingUseEvidenceIn,type TeacherMemory} from './learning-memory';

interface Message {id:string;thread_id:string;sequence_no:number;role:'user'|'teacher';text:string;status:string;client_message_id:string;metadata_json:string;created_at:string}
interface Payload {registerProfileVersion?:string;currentTask:{mode:CoachingContext['mode'];questionEn:string;intentZh:string;referenceEnglish?:string;notes?:unknown};latestUserMessage:string;correctionHint:boolean;recentHistory:Array<{role:string;text:string}>;relevantMemories:TeacherMemory[];memoryUsePolicy?:{maxOldIssues:number;onlyWhenRelevant:boolean;absenceIsNotImprovement:boolean}}
interface Meta {context:CoachingContext;assisted:boolean;correctionHint?:boolean;delivery?:'pending'|'completed'|'failed'|'skipped';payload?:Payload;leaseToken?:string|null;leaseUntil?:string|null;errorCode?:string;replyTo?:string;feedback?:CoachingFeedback;reviewJobId?:string|null;runId?:string}
const metadata=(m:Message)=>parseJson<Meta>(m.metadata_json,{context:{} as CoachingContext,assisted:true});
const contextKey=(c:CoachingContext)=>[c.materialId,c.sentenceId??'',c.mode,c.practiceId].join('|');
const idFor=(c:CoachingContext)=>stableId('companion','coaching:'+c.materialId);
type Platform={now:()=>Date;newId:()=>string;bootId:string;loadPrompt:(name:string)=>string|Promise<string>;loadMaterial:(context:CoachingContext)=>Promise<CoachingMaterial>};

/** Optional coaching writes into the existing Companion history. It never creates learning materials or grades FSRS. */
export function createCoachingService(database:DatabasePort,runtime:RuntimeCalls,memory:MemoryService,platform:Platform){
  const active=new Map<string,{signature:string;task:Promise<CoachingView>}>();
  const now=()=>platform.now().toISOString();
  const history=(id:string)=>database.read(tx=>tx.all<Message>(sql`SELECT * FROM companion_messages WHERE thread_id=${id} ORDER BY sequence_no`));
  async function material(raw:CoachingContext){
    const c=coachingContextSchema.parse(raw),m=await platform.loadMaterial(c);
    if(c.questionId&&c.questionId!==m.questionId)throw new TrainingError('题目与材料不一致',400,'coaching_question_mismatch');
    if(c.sentenceId&&!m.sentences.some(s=>s.id===c.sentenceId))throw new TrainingError('句子不属于本次材料',404,'coaching_sentence_missing');
    return m;
  }
  async function view(raw:CoachingContext):Promise<CoachingView>{
    const c=coachingContextSchema.parse(raw),m=await material(c),threadId=idFor(c);
    const rows=await history(threadId),visible=rows.filter(row=>contextKey(metadata(row).context)===contextKey(c));
    const [thread]=await database.read(tx=>tx.all<{id:string}>(sql`SELECT id FROM companion_threads WHERE id=${threadId} AND status!='deleted'`));
    const jobs=await database.read(tx=>tx.all<{n:number}>(sql`SELECT COUNT(*) n FROM companion_memory_jobs WHERE thread_id=${threadId} AND status IN ('pending','failed')`));
    return {threadId:thread?.id??null,context:c,questionEn:m.questionEn,questionZh:m.questionZh,
      chinese:c.mode==='answer_independent'?null:c.sentenceId?m.sentences.find(s=>s.id===c.sentenceId)!.chinese:m.sentences.map(s=>s.chinese).join('\n'),
      messages:visible.map(row=>{const meta=metadata(row);return {id:row.id,role:row.role,text:row.text,status:meta.delivery??row.status,clientMessageId:row.client_message_id,createdAt:row.created_at,feedback:meta.feedback,replyTo:meta.replyTo,errorCode:meta.errorCode,assisted:meta.assisted,correctionHint:meta.correctionHint};}),pendingMemoryJobs:jobs[0]?.n??0};
  }
  async function prepare(raw:CoachingSubmit){
    const input=coachingSubmitSchema.parse(raw),c=input.context;
    if(credentialValue(input.text))throw new TrainingError('内容包含凭证，请先去除再提交',400,'sensitive_message');
    const m=await material(c),threadId=idFor(c),userId=stableId('coaching_user',threadId,input.clientMessageId);
    const prior=await database.read(tx=>tx.all<Message>(sql`SELECT * FROM companion_messages WHERE id=${userId}`));
    if(prior[0]){assertSame(prior[0],input);return prior[0];}
    const memoryLimit=c.mode==='sentence_guided'?1:2;
    const related=await memory.relevantForTeacher(m.questionEn+' '+input.text,memoryLimit,memoryLimit);
    return database.write(async tx=>{
      const [again]=await tx.all<Message>(sql`SELECT * FROM companion_messages WHERE id=${userId}`);
      if(again){assertSame(again,input);return again;}
      const rows=await tx.all<Message>(sql`SELECT * FROM companion_messages WHERE thread_id=${threadId} ORDER BY sequence_no`);
      if(rows.some(r=>r.role==='user'&&['pending','failed'].includes(metadata(r).delivery??'')))throw new TrainingError('上一条输出已保存，请先恢复回复或跳过',409,'coaching_previous_unresolved');
      const [thread]=await tx.all<{status:string}>(sql`SELECT status FROM companion_threads WHERE id=${threadId}`);
      if(thread?.status==='deleted')throw new TrainingError('这段教学对话已删除',409,'coaching_thread_deleted');
      const sentence=c.sentenceId?m.sentences.find(s=>s.id===c.sentenceId):null;
      // Independent output receives neither old intended facts nor prior guided answers.
      const recent=c.mode==='answer_independent'?rows.filter(r=>contextKey(metadata(r).context)===contextKey(c)):rows.filter(r=>metadata(r).context.practiceId===c.practiceId);
      const payload:Payload={registerProfileVersion:SPOKEN_REGISTER_VERSION,currentTask:{mode:c.mode,questionEn:m.questionEn,intentZh:c.mode==='answer_independent'?'':sentence?.chinese??m.sentences.map(s=>s.chinese).join('\n'),
        ...(c.mode==='answer_independent'?{}:{referenceEnglish:sentence?.english??m.referenceText,notes:sentence?.notes})},
        latestUserMessage:input.text,correctionHint:input.correctionHint,recentHistory:recent.filter(r=>r.status==='sent').slice(-12).map(r=>({role:r.role,text:r.text})),
        relevantMemories:related,memoryUsePolicy:{maxOldIssues:memoryLimit,onlyWhenRelevant:true,absenceIsNotImprovement:true}};
      await tx.run(sql`INSERT INTO companion_threads(id,scope_key,scope_type,scope_id,title,created_at,updated_at)
        VALUES(${threadId},${'coaching:'+c.materialId},${m.questionId?'question':'general'},${m.questionId},${m.questionEn||'表达练习 · Chloe'},${now()},${now()}) ON CONFLICT DO NOTHING`);
      await tx.run(sql`INSERT INTO companion_messages(id,thread_id,sequence_no,role,text,status,client_message_id,source_type,source_id,metadata_json,created_at)
        VALUES(${userId},${threadId},${(rows.at(-1)?.sequence_no??0)+1},'user',${input.text},'pending',${input.clientMessageId},'coaching_output',${c.materialId},${JSON.stringify({context:c,assisted:c.mode!=='answer_independent'||input.correctionHint||recent.some(r=>r.role==='teacher'),correctionHint:input.correctionHint,delivery:'pending',payload} satisfies Meta)},${now()})`);
      await tx.run(sql`UPDATE companion_threads SET updated_at=${now()} WHERE id=${threadId}`);
      return (await tx.all<Message>(sql`SELECT * FROM companion_messages WHERE id=${userId}`))[0];
    });
  }
  function assertSame(prior:Message,input:CoachingSubmit){
    const meta=metadata(prior);
    if(prior.text!==input.text||contextKey(meta.context)!==contextKey(input.context)||!!meta.correctionHint!==input.correctionHint)throw new TrainingError('提交编号已用于其他输出，原文保持不变',409,'coaching_message_conflict');
  }
  async function updateDelivery(tx:SqlWriter,user:Message,meta:Meta){
    await tx.run(sql`UPDATE companion_messages SET status=${meta.delivery==='completed'||meta.delivery==='skipped'?'sent':meta.delivery==='failed'?'failed':'pending'},metadata_json=${JSON.stringify(meta)} WHERE id=${user.id}`);
  }
  async function run(input:CoachingSubmit,options:RuntimeCallOptions){
    const user=await prepare(input),original=metadata(user),c=original.context;
    if(original.delivery==='completed'||original.delivery==='skipped')return view(c);
    const token=platform.bootId+':'+platform.newId();
    const claimed=await database.write(async tx=>{
      const [current]=await tx.all<Message>(sql`SELECT * FROM companion_messages WHERE id=${user.id}`),meta=metadata(current);
      if(meta.delivery==='completed'||meta.delivery==='skipped')return null;
      if(meta.leaseUntil&&meta.leaseUntil>now()&&meta.leaseToken?.startsWith(platform.bootId+':'))throw new TrainingError('回复仍在处理，你的输出已保存',409,'coaching_busy');
      const next={...meta,delivery:'pending' as const,leaseToken:token,leaseUntil:new Date(platform.now().getTime()+180000).toISOString(),errorCode:undefined};
      await updateDelivery(tx,current,next);return next;
    });
    if(!claimed)return view(c);
    try{
      const result=await runtime.call({role:'companion_response',instructions:await spokenInstructions(platform.loadPrompt,claimed.payload?.registerProfileVersion?'sentence_coaching.chloe.v2.md':'sentence_coaching.chloe.v1.md',claimed.payload?.registerProfileVersion),input:JSON.stringify(claimed.payload),
        schema:coachingFeedbackSchema,schemaName:'sentence_coaching_v1',promptVersion:claimed.payload?.registerProfileVersion?'sentence-coaching-chloe-v2-young-us-v1':'sentence-coaching-chloe-v1',schemaVersion:'sentence-coaching-v1',idempotencyKey:user.id},options);
      const payload=claimed.payload!,limit=c.mode==='sentence_guided'?1:2;
      if(result.data.usedMemoryIds.length>limit||result.data.usedMemoryIds.some(id=>!payload.relevantMemories.some(m=>m.id===id)))throw new TrainingError('回复使用了未提供的学习记忆',422,'coaching_memory_reference');
      if(result.data.findings.some(f=>!user.text.includes(f.sourceQuote)))throw new TrainingError('反馈证据不属于本次输出，请重试',422,'coaching_invalid_evidence');
      if(result.data.verdict==='natural'&&result.data.findings.some(f=>f.kind==='confirmed_error'))throw new TrainingError('反馈结论与问题证据矛盾，请重试',422,'coaching_inconsistent_feedback');
      if(input.correctionHint&&result.data.extent==='full_answer')throw new TrainingError('局部修正不能当作整题回答评价',422,'coaching_wrong_extent');
      const jobId=await database.write(async tx=>{
        const [current]=await tx.all<Message>(sql`SELECT * FROM companion_messages WHERE id=${user.id}`);
        if(metadata(current).leaseToken!==token)throw new TrainingError('本次练习已切换，旧回复只保留请求记录',409,'coaching_lease_lost');
        const [last]=await tx.all<{seq:number}>(sql`SELECT MAX(sequence_no) seq FROM companion_messages WHERE thread_id=${user.thread_id}`);
        for(const [index,bubble] of result.data.messages.entries()){
          const replyId=stableId('coaching_reply',user.id,String(index));
          await tx.run(sql`INSERT INTO companion_messages(id,thread_id,sequence_no,role,text,status,client_message_id,source_type,source_id,ai_run_id,metadata_json,created_at)
            VALUES(${replyId},${user.thread_id},${(last?.seq??0)+index+1},'teacher',${bubble.text},'sent',${replyId},'coaching_output',${c.materialId},${result.runId},${JSON.stringify({context:c,assisted:claimed.assisted,replyTo:user.id,...(index===0?{feedback:result.data}:{})} satisfies Meta)},${now()}) ON CONFLICT DO NOTHING`);
        }
        const jobId=await queueLearningReviewIn(tx,{kind:'coaching_error_review_v1',threadId:user.thread_id,messageId:user.id,text:user.text,intentZh:payload.currentTask.intentZh,questionEn:payload.currentTask.questionEn,mode:c.mode,assisted:claimed.assisted,generatorRunId:result.runId,findings:result.data.findings.filter(f=>f.kind==='confirmed_error')},now());
        await recordCoachingUseEvidenceIn(tx,{messageId:user.id,text:user.text,memoryIds:payload.relevantMemories.filter(m=>m.category==='learning').map(m=>m.id),verdict:result.data.verdict,extent:result.data.extent,assisted:claimed.assisted,mode:c.mode,runId:result.runId,at:now()});
        await updateDelivery(tx,user,{...claimed,delivery:'completed',leaseToken:null,leaseUntil:null,runId:result.runId,reviewJobId:jobId});
        await tx.run(sql`UPDATE companion_threads SET updated_at=${now()} WHERE id=${user.thread_id}`);
        return jobId;
      });
      // Independent review has its own persisted checkpoint and never delays visible feedback.
      if(jobId)void memory.retry(jobId).catch(()=>undefined);
    }catch(error){
      await database.write(async tx=>{
        const [current]=await tx.all<Message>(sql`SELECT * FROM companion_messages WHERE id=${user.id}`);
        if(metadata(current).leaseToken!==token)return;
        const code=error&&typeof error==='object'&&'code' in error?String(error.code):'coaching_failed';
        await updateDelivery(tx,current,{...claimed,delivery:'failed',leaseToken:null,leaseUntil:null,errorCode:code});
      });throw error;
    }
    return view(c);
  }
  function submit(raw:CoachingSubmit){
    const input=coachingSubmitSchema.parse(raw),key=stableId('coaching_user',idFor(input.context),input.clientMessageId),pending=active.get(key);
    const signature=JSON.stringify([input.context,input.text,input.correctionHint]);
    if(pending){if(pending.signature!==signature)return Promise.reject(new TrainingError('提交编号已用于其他输出',409,'coaching_message_conflict'));return pending.task;}
    const task=run(input,{retryFailed:input.retryFailed,retryUnknown:input.retryUnknown});active.set(key,{signature,task});
    void task.finally(()=>{if(active.get(key)?.task===task)active.delete(key);}).catch(()=>undefined);return task;
  }
  async function skip(raw:CoachingContext,clientMessageId:string){
    const c=coachingContextSchema.parse(raw);
    await database.write(async tx=>{
      const [user]=await tx.all<Message>(sql`SELECT * FROM companion_messages WHERE thread_id=${idFor(c)} AND client_message_id=${clientMessageId} AND role='user'`);
      if(!user||contextKey(metadata(user).context)!==contextKey(c))throw new TrainingError('要跳过的输出不存在',404,'coaching_message_missing');
      const meta=metadata(user);if(meta.delivery==='completed')return;
      await updateDelivery(tx,user,{...meta,delivery:'skipped',leaseToken:null,leaseUntil:null});
    });return view(c);
  }
  async function retryReviews(raw:CoachingContext,options:RuntimeCallOptions={}){
    const c=coachingContextSchema.parse(raw);
    const jobs=await database.read(tx=>tx.all<{id:string}>(sql`SELECT id FROM companion_memory_jobs WHERE thread_id=${idFor(c)} AND status IN ('pending','failed') AND json_extract(input_json,'$.kind')='coaching_error_review_v1' ORDER BY created_at`));
    for(const job of jobs)await memory.retry(job.id,options);
    return view(c);
  }
  return {view,prepare,submit,skip,retryReviews};
}
