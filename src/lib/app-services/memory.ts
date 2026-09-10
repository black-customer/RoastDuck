import {z} from "zod";
import type {DatabasePort,SqlWriter} from "@/lib/platform/database";
import {query as sql} from "@/lib/platform/sql";
import type {RuntimeCalls,RuntimeCallOptions} from "@/lib/ai/runtime-ledger";
import {companionMemoryExtractionSchema} from "@/lib/companion/schemas";
import {TrainingError} from "@/lib/four-step/shared";
import {normalizeKey,parseJson,sensitiveMemory,stableId} from "./shared";
import {processLearningReview,teacherMemory,type LearningOccurrence} from '@/lib/coaching/learning-memory';
import type {LearningErrorReviewInput} from '@/lib/coaching/contracts';
type MemoryControl={generation:number;cutoffs_json:string};
export interface MemoryJob {id:string;thread_id:string;generation:number;input_json:string;status:string;error_code:string|null;updated_at:string}
export interface AppMemory {id:string;category:string;summary:string;detail_json:string;confidence:number;source_type:string;source_id:string;evidence_json:string;status:string;superseded_by_id:string|null;created_at:string;updated_at:string;deleted_at:string|null}
export function createMemoryService(database:DatabasePort,runtime:RuntimeCalls,platform:{now:()=>Date;loadPrompt:(name:string)=>string|Promise<string>}){
  const running=new Map<string,Promise<AppMemory[]>>();
  async function revokePending(tx:SqlWriter,clearAll=false){
    await tx.run(sql`INSERT INTO companion_memory_control(singleton,generation,updated_at) VALUES(1,0,${platform.now().toISOString()}) ON CONFLICT DO NOTHING`);
    const [control]=await tx.all<MemoryControl>(sql`SELECT * FROM companion_memory_control WHERE singleton=1`);
    let cutoffs:Record<string,number>|null=null;
    if(clearAll){
      cutoffs=parseJson<Record<string,number>>(control?.cutoffs_json??'{}',{});
      for(const row of await tx.all<{thread_id:string;seq:number}>(sql`SELECT thread_id,MAX(sequence_no) seq FROM companion_messages GROUP BY thread_id`))cutoffs[row.thread_id]=Math.max(cutoffs[row.thread_id]??0,row.seq);
      // Stable message cutoffs survive conversation branching/re-grouping on another device.
      for(const row of await tx.all<{id:string}>(sql`SELECT id FROM companion_messages`))cutoffs['@'+row.id]=1;
      // An already saved answer or queued material cannot repopulate cleared memory after late publication.
      for(const row of await tx.all<{id:string}>(sql`SELECT id FROM speaking_question_attempts`))cutoffs['@answer:'+row.id]=1;
      for(const row of await tx.all<{id:string}>(sql`SELECT id FROM practice_materials`))cutoffs['@material:'+row.id]=1;
      for(const row of await tx.all<{id:string}>(sql`SELECT id FROM free_talk_messages WHERE role='user'`))cutoffs['@free-talk:'+row.id]=1;
    }
    await tx.run(sql`UPDATE companion_memory_control SET generation=generation+1,cutoffs_json=${cutoffs?JSON.stringify(cutoffs):sql`cutoffs_json`},updated_at=${platform.now().toISOString()} WHERE singleton=1`);
    await tx.run(sql`UPDATE companion_memory_jobs SET status='cancelled',updated_at=${platform.now().toISOString()} WHERE status IN ('pending','failed')`);
  }
  const list=(query="",includeInactive=false)=>database.read(tx=>tx.all<AppMemory>(sql`SELECT * FROM companion_memories WHERE ${includeInactive?sql`1=1`:sql`status='active'`} AND summary LIKE ${`%${query.trim().slice(0,120)}%`} ORDER BY julianday(updated_at) DESC,id LIMIT 300`));
  async function relevant(context:string,limit=4,learningLimit=1){
    const rows=await list(),normalized=normalizeKey(context);
    const terms=new Set(normalized.match(/[a-z]{3,}/g)??[]);
    for(const run of normalized.match(/[\u4e00-\u9fff]+/g)??[])for(let i=0;i<run.length-1;i++)terms.add(run.slice(i,i+2));
    let learningCount=0;
    return rows.filter(row=>!sensitiveMemory(row.summary)).map(row=>{
      const detail=parseJson<{memoryKey?:string;correction?:string;occurrences?:LearningOccurrence[]}>(row.detail_json,{});
      const recent=detail.occurrences?.at(-1);
      const content=normalizeKey([row.summary,detail.memoryKey,detail.correction,recent?.quote,recent?.intentZh].filter(Boolean).join(' '));
      return {row,score:[...terms].filter(term=>content.includes(term)).length+(row.category==="goal"?1:0)};
    }).filter(item=>item.score>0).sort((a,b)=>b.score-a.score||b.row.updated_at.localeCompare(a.row.updated_at))
      .filter(item=>item.row.category!=='learning'||++learningCount<=Math.min(2,learningLimit)).slice(0,Math.min(4,limit)).map(item=>item.row);
  }
  const relevantForTeacher=async(context:string,limit=4,learningLimit=1)=>(await relevant(context,limit,learningLimit)).map(teacherMemory);
  async function edit(id:string,input:{clientEventId:string;summary:string;category:string}){
    z.string().min(2).max(300).parse(input.summary);z.enum(["goal","preference","interest","experience","opinion","learning"]).parse(input.category);
    if(sensitiveMemory(input.summary))throw new TrainingError("敏感凭证不能作为长期记忆",400,"sensitive_memory");
    const nextId=stableId("memory_edit",id,input.clientEventId);
    return database.write(async tx=>{
      const [priorEdit]=await tx.all<AppMemory>(sql`SELECT * FROM companion_memories WHERE id=${nextId}`);
      if(priorEdit){if(priorEdit.summary!==input.summary||priorEdit.category!==input.category)throw new TrainingError("编辑编号已用于其他内容",409,"memory_conflict");return priorEdit;}
      const [current]=await tx.all<AppMemory>(sql`SELECT * FROM companion_memories WHERE id=${id}`);
      if(!current||current.status!=="active")throw new TrainingError("这条记忆已变化，请恢复后再编辑",409,"memory_changed");
      await revokePending(tx);
      const timestamp=platform.now().toISOString();
      await tx.run(sql`INSERT INTO companion_memories(id,category,summary,detail_json,confidence,source_type,source_id,evidence_json,status,created_at,updated_at)
        VALUES(${nextId},${input.category},${input.summary},${current.detail_json},1,'user_edit',${id},${current.evidence_json},'active',${timestamp},${timestamp})`);
      await tx.run(sql`UPDATE companion_memories SET status='superseded',superseded_by_id=${nextId},updated_at=${timestamp} WHERE id=${id}`);
      return (await tx.all<AppMemory>(sql`SELECT * FROM companion_memories WHERE id=${nextId}`))[0];
    });
  }
  async function state(id:string,status:"active"|"dismissed"|"deleted"){
    return database.write(async tx=>{
      const [current]=await tx.all<AppMemory>(sql`SELECT * FROM companion_memories WHERE id=${id}`);
      if(!current)throw new TrainingError("记忆不存在",404,"memory_missing");
      if(current.status==="superseded"&&status==="active")throw new TrainingError("请编辑当前版本，不能覆盖较新的记忆",409,"memory_superseded");
      await revokePending(tx);
      const detail={...parseJson<Record<string,unknown>>(current.detail_json,{}),userRestored:status==='active'};
      await tx.run(sql`UPDATE companion_memories SET status=${status},detail_json=${JSON.stringify(detail)},deleted_at=${status==="deleted"?platform.now().toISOString():null},updated_at=${platform.now().toISOString()} WHERE id=${id}`);
    });
  }
  async function clear(){return database.write(async tx=>{await revokePending(tx,true);await tx.run(sql`UPDATE companion_memories SET status='deleted',detail_json=json_set(detail_json,'$.userRestored',json('false'),'$.clearedGeneration',(SELECT generation FROM companion_memory_control WHERE singleton=1)),deleted_at=${platform.now().toISOString()},updated_at=${platform.now().toISOString()}`);});}
  const jobs=()=>database.read(tx=>tx.all<MemoryJob>(sql`SELECT * FROM companion_memory_jobs WHERE status IN ('pending','failed') ORDER BY updated_at,id`));
  async function processJob(job:MemoryJob,options:RuntimeCallOptions){
    const clean=parseJson<Array<{id:string;text:string}>>(job.input_json,[]);
    try{
      const specialised=parseJson<LearningErrorReviewInput|null>(job.input_json,null);
      if(specialised?.kind==='coaching_error_review_v1')return await processLearningReview(database,runtime,platform,job,specialised,options);
      const valid=await database.read(async tx=>{
        const [current]=await tx.all<MemoryJob>(sql`SELECT * FROM companion_memory_jobs WHERE id=${job.id}`);
        const [control]=await tx.all<MemoryControl>(sql`SELECT * FROM companion_memory_control WHERE singleton=1`);
        return current&&['pending','failed'].includes(current.status)&&job.generation===(control?.generation??0);
      });
      if(!valid)return [];
      const result=await runtime.call({role:"memory_extractor",instructions:await platform.loadPrompt("companion_memory.extractor.v1.md"),input:JSON.stringify({messages:clean}),
        schema:companionMemoryExtractionSchema,schemaName:"companion_memory_extractor_v1",promptVersion:"companion-memory-extractor-v1",schemaVersion:"companion-memory-extractor-v1",idempotencyKey:job.id},options);
      return await database.write(async tx=>{
      const [control]=await tx.all<MemoryControl>(sql`SELECT * FROM companion_memory_control WHERE singleton=1`);
      if((control?.generation??0)!==job.generation)return [];
      const added:AppMemory[]=[];
      for(const candidate of result.data.memories){
        if(candidate.confidence<.8||sensitiveMemory(candidate.summary)||candidate.evidenceMessageIds.some(id=>!clean.some(message=>message.id===id)))continue;
        const id=stableId("memory",job.id,candidate.memoryKey,normalizeKey(candidate.summary));
        // A completed extraction replay cannot resurrect a dismissed/deleted memory.
        if((await tx.all(sql`SELECT id FROM companion_memories WHERE id=${id}`)).length)continue;
        // Rewording the same revoked source is not a new fact; an explicit later statement can be.
        const revoked=await tx.all<{evidence_json:string}>(sql`SELECT evidence_json FROM companion_memories WHERE status IN ('deleted','dismissed') AND json_extract(detail_json,'$.memoryKey')=${candidate.memoryKey}`);
        if(revoked.some(row=>candidate.evidenceMessageIds.every(id=>parseJson<string[]>(row.evidence_json,[]).includes(id))))continue;
        const previous=await tx.all<AppMemory>(sql`SELECT * FROM companion_memories WHERE status='active' AND json_extract(detail_json,'$.memoryKey')=${candidate.memoryKey} ORDER BY julianday(updated_at) DESC`);
        if(previous.some(memory=>normalizeKey(memory.summary)===normalizeKey(candidate.summary)))continue;
        const timestamp=platform.now().toISOString();
        await tx.run(sql`INSERT INTO companion_memories(id,category,summary,detail_json,confidence,source_type,source_id,evidence_json,status,created_at,updated_at)
          VALUES(${id},${candidate.category},${candidate.summary},${JSON.stringify({memoryKey:candidate.memoryKey,extractorRunId:result.runId})},${candidate.confidence},'chat_message',${candidate.evidenceMessageIds[0]},${JSON.stringify(candidate.evidenceMessageIds)},'active',${timestamp},${timestamp})`);
        for(const old of previous)await tx.run(sql`UPDATE companion_memories SET status='superseded',superseded_by_id=${id},updated_at=${timestamp} WHERE id=${old.id}`);
        added.push((await tx.all<AppMemory>(sql`SELECT * FROM companion_memories WHERE id=${id}`))[0]);
      }
      await tx.run(sql`UPDATE companion_memory_jobs SET status='completed',error_code=NULL,updated_at=${platform.now().toISOString()} WHERE id=${job.id}`);
      return added;
      });
    }catch(error){
      const code=error&&typeof error==='object'&&'code' in error?String(error.code):'memory_extraction_failed';
      await database.write(tx=>tx.run(sql`UPDATE companion_memory_jobs SET status='failed',error_code=${code},updated_at=${platform.now().toISOString()} WHERE id=${job.id} AND status!='cancelled'`));
      throw error;
    }
  }
  async function retry(id:string,options:RuntimeCallOptions={}){
    const pending=running.get(id);if(pending)return pending;
    const [job]=await database.read(tx=>tx.all<MemoryJob>(sql`SELECT * FROM companion_memory_jobs WHERE id=${id}`));
    if(!job)throw new TrainingError("记忆任务不存在",404,"memory_job_missing");
    const current=running.get(id);if(current)return current;
    const task=processJob(job,options);running.set(id,task);
    void task.finally(()=>{if(running.get(id)===task)running.delete(id);}).catch(()=>undefined);return task;
  }
  async function extract(threadId:string,options:RuntimeCallOptions={},force=false){
    const created=await database.write(async tx=>{
      const [control]=await tx.all<MemoryControl>(sql`SELECT * FROM companion_memory_control WHERE singleton=1`);
      const cutoff=parseJson<Record<string,number>>(control?.cutoffs_json??'{}',{})[threadId]??0;
      const controls=parseJson<Record<string,number>>(control?.cutoffs_json??'{}',{});
      const messages=(await tx.all<{id:string;text:string}>(sql`SELECT id,text FROM companion_messages WHERE thread_id=${threadId} AND role='user' AND status='sent' AND sequence_no>${cutoff} AND json_extract(metadata_json,'$.branchPrefixSourceId') IS NULL ORDER BY sequence_no`)).filter(row=>!controls['@'+row.id]);
      const end=force?messages.length:Math.floor(messages.length/4)*4,ids:string[]=[];
      for(let start=0;start<end;start+=4){
        const batch=messages.slice(start,Math.min(start+4,end)),clean=batch.filter(message=>!sensitiveMemory(message.text));
        if(!clean.length)continue;
        const id=stableId("memory_batch",threadId,batch.at(-1)!.id),timestamp=platform.now().toISOString();
        await tx.run(sql`INSERT INTO companion_memory_jobs(id,thread_id,generation,input_json,status,created_at,updated_at) VALUES(${id},${threadId},${control?.generation??0},${JSON.stringify(clean)},'pending',${timestamp},${timestamp}) ON CONFLICT DO NOTHING`);
        ids.push(id);
      }return ids;
    });
    const added:AppMemory[]=[];for(const id of created)added.push(...await retry(id,options));return added;
  }
  return {list,relevant,relevantForTeacher,edit,state,clear,extract,jobs,retry};
}
export type MemoryService=ReturnType<typeof createMemoryService>;
