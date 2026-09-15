import type {DatabasePort,SqlReader} from '@/lib/platform/database';
import {query as sql} from '@/lib/platform/sql';
import type {RuntimeCalls,RuntimeCallOptions} from '@/lib/ai/runtime-ledger';
import {readSentenceCatalogue,sentenceIsTarget} from '@/lib/sentence-study/catalogue';
import {TrainingError,hash} from '@/lib/four-step/shared';
import {stableId} from '@/lib/app-services/shared';
import {contextPracticeCreateSchema,relatedQuestionSchema,assertRelatedQuestion,projectContextTask,type ContextPracticeTaskRow,type RelatedQuestionCandidate} from './contracts';
interface GenerationPayload {version:'context-related-question-v1';sourceQuestion:{id:string|null;textEn:string;topicId:string|null;topic:string};targets:Array<{id:string;version:string;english:string}>;memories:Array<{id:string;summary:string}>}
interface SavedRequest {input:unknown;generation?:GenerationPayload}
export function createContextPracticeService(database:DatabasePort,runtime:RuntimeCalls,platform:{now:()=>Date;loadPrompt:(name:string)=>string|Promise<string>;generationAvailable:()=>boolean}){
  const active=new Map<string,Promise<ReturnType<typeof projectContextTask>>>();
  const now=()=>platform.now().toISOString();
  async function source(db:SqlReader,materialId:string){
    const catalogue=await readSentenceCatalogue(db,{type:'material',id:materialId},platform.now(),false),cards=catalogue.cards.filter(sentenceIsTarget),first=cards[0];
    if(!first)throw new TrainingError('原句子材料已更新或暂不可用，请先返回工作区',409,'related_material_unavailable');
    const [question]=first.source.questionId?await db.all<{id:string;text:string;topic_id:string|null;topic:string}>(sql`SELECT q.id,q.text,q.topic_id,COALESCE(t.name_zh,t.name_en,'') topic FROM questions q LEFT JOIN topics t ON t.id=q.topic_id WHERE q.id=${first.source.questionId}`):[];
    return {cards,question};
  }
  async function candidatesIn(db:SqlReader,materialId:string){
    const current=await source(db,materialId),question=current.question;
    const rows=question?.topic_id?await db.all<{id:string;text:string;text_zh:string;topic_id:string;topic:string}>(sql`SELECT q.id,q.text,q.text_zh,q.topic_id,COALESCE(t.name_zh,t.name_en,'') topic FROM questions q LEFT JOIN topics t ON t.id=q.topic_id WHERE q.topic_id=${question.topic_id} AND q.id!=${question.id} ORDER BY q.part,q.id LIMIT 12`):[];
    const candidates:RelatedQuestionCandidate[]=rows.map(q=>({questionId:q.id,promptEn:q.text,promptZh:q.text_zh,topicId:q.topic_id,topic:q.topic}));
    return {...current,candidates};
  }
  async function list(materialId:string){return database.read(async db=>{
    const {candidates}=await candidatesIn(db,materialId),rows=await db.all<ContextPracticeTaskRow>(sql`SELECT * FROM context_practice_tasks WHERE material_id=${materialId} ORDER BY created_at DESC,id DESC`);
    return {tasks:rows.map(projectContextTask),candidates,generationAvailable:platform.generationAvailable()};
  });}
  async function row(id:string){const [task]=await database.read(db=>db.all<ContextPracticeTaskRow>(sql`SELECT * FROM context_practice_tasks WHERE id=${id}`));if(!task)throw new TrainingError('相关练习不存在',404,'related_task_missing');return task;}
  async function get(id:string){return projectContextTask(await row(id));}
  async function generate(id:string,options:RuntimeCallOptions){
    let task=await row(id);if(task.origin!=='teacher_generated'||['ready','completed','dismissed'].includes(task.status))return projectContextTask(task);
    if(!platform.generationAvailable())throw new TrainingError('请先配置 AI 服务，再主动生成相关问题',409,'related_generation_unconfigured');
    const saved=JSON.parse(task.request_json) as SavedRequest,payload=saved.generation;
    if(!payload)throw new TrainingError('生成检查点缺失，原任务已保留',409,'related_checkpoint_missing');
    const current=await database.read(db=>source(db,task.material_id));
    if(payload.targets.some(target=>!current.cards.some(c=>c.id===target.id&&c.version===target.version)))throw new TrainingError('原句子版本已变化，请重新选择相关练习',409,'related_material_changed');
    async function assertMemories(db:SqlReader){
      if(!payload!.memories.length)return;
      const memories=await db.all<{id:string}>(sql`SELECT id FROM companion_memories WHERE category='learning' AND status='active' AND id IN (${{sql:payload!.memories.map(()=>'?').join(','),args:payload!.memories.map(m=>m.id)}})`);
      if(memories.length!==payload!.memories.length)throw new TrainingError('相关记忆已撤回，不能继续发送旧内容',409,'related_memory_unavailable');
    }
    await database.read(assertMemories);
    await database.write(tx=>tx.run(sql`UPDATE context_practice_tasks SET status='generating',error_code=NULL,updated_at=${now()} WHERE id=${id} AND status IN ('generating','failed')`));
    try{
      const result=await runtime.call({role:'companion_response',instructions:await platform.loadPrompt('context_related_question.chloe.v1.md'),input:JSON.stringify(payload),schema:relatedQuestionSchema,schemaName:'context_related_question_v1',promptVersion:'context-related-question-chloe-v1',schemaVersion:'context-related-question-v1',idempotencyKey:id},options);
      assertRelatedQuestion(result.data,payload);
      await database.write(async tx=>{
        const live=await source(tx,task.material_id);
        await assertMemories(tx);
        if(payload.targets.some(target=>!live.cards.some(c=>c.id===target.id&&c.version===target.version)))throw new TrainingError('生成期间材料发生变化，原任务已保留',409,'related_material_changed');
        await tx.run(sql`UPDATE context_practice_tasks SET prompt_en=${result.data.promptEn},prompt_zh=${result.data.promptZh},status='ready',run_id=${result.runId},error_code=NULL,version=version+1,updated_at=${now()} WHERE id=${id} AND status='generating'`);
      });
    }catch(error){
      const code=error&&typeof error==='object'&&'code'in error?String(error.code):'related_generation_failed';
      await database.write(tx=>tx.run(sql`UPDATE context_practice_tasks SET status='failed',error_code=${code},updated_at=${now()} WHERE id=${id} AND status='generating'`));throw error;
    }
    task=await row(id);return projectContextTask(task);
  }
  function run(id:string,options:RuntimeCallOptions={}){const prior=active.get(id);if(prior)return prior;const promise=generate(id,options).catch(async error=>{
    const code=error&&typeof error==='object'&&'code'in error?String(error.code):'related_generation_failed';
    await database.write(tx=>tx.run(sql`UPDATE context_practice_tasks SET status='failed',error_code=${code},updated_at=${now()} WHERE id=${id} AND status='generating'`));throw error;
  });active.set(id,promise);void promise.finally(()=>{if(active.get(id)===promise)active.delete(id);}).catch(()=>undefined);return promise;}
  async function create(raw:unknown){
    const input=contextPracticeCreateSchema.parse(raw),inputHash=hash(JSON.stringify(input));
    const task=await database.write(async tx=>{
      const [prior]=await tx.all<ContextPracticeTaskRow>(sql`SELECT * FROM context_practice_tasks WHERE client_request_id=${input.clientRequestId}`);
      if(prior){if(prior.input_hash!==inputHash)throw new TrainingError('创建编号已用于其他相关练习',409,'related_request_conflict');return prior;}
      const {cards,question,candidates}=await candidatesIn(tx,input.materialId),chosen=input.origin==='bank'?candidates.find(q=>q.questionId===input.questionId):undefined;
      if(input.origin==='bank'&&!chosen)throw new TrainingError('该题没有与原题相同的已登记话题关联',422,'related_question_unlinked');
      if(input.origin==='teacher_generated'&&!platform.generationAvailable())throw new TrainingError('请先配置 AI 服务，再主动生成相关问题',409,'related_generation_unconfigured');
      const ids=input.sourceSentenceIds??cards.slice(0,2).map(c=>c.id),memoryIds=input.sourceMemoryIds??[];
      if(new Set(ids).size!==ids.length||ids.some(id=>!cards.some(c=>c.id===id)))throw new TrainingError('目标句子不属于当前材料',422,'related_target_invalid');
      const memories=await tx.all<{id:string;summary:string}>(sql`SELECT id,summary FROM companion_memories WHERE category='learning' AND status='active' AND id IN (${{sql:memoryIds.map(()=>'?').join(',')||'NULL',args:memoryIds}})`);
      if(memories.length!==new Set(memoryIds).size)throw new TrainingError('引用的学习记忆已撤回或不存在',409,'related_memory_unavailable');
      const id=stableId('context_task',input.clientRequestId),stamp=now(),generation:GenerationPayload={version:'context-related-question-v1',sourceQuestion:{id:question?.id??null,textEn:question?.text??'',topicId:question?.topic_id??null,topic:question?.topic??''},targets:cards.filter(c=>ids.includes(c.id)).slice(0,2).map(c=>({id:c.id,version:c.version,english:c.english})),memories};
      await tx.run(sql`INSERT INTO context_practice_tasks(id,client_request_id,input_hash,material_id,source_question_id,question_id,source_sentence_ids_json,source_memory_ids_json,prompt_en,prompt_zh,origin,status,request_json,created_at,updated_at) VALUES(${id},${input.clientRequestId},${inputHash},${input.materialId},${question?.id??null},${chosen?.questionId??null},${JSON.stringify(ids)},${JSON.stringify(memoryIds)},${chosen?.promptEn??''},${chosen?.promptZh??''},${input.origin},${input.origin==='bank'?'ready':'generating'},${JSON.stringify({input,generation} satisfies SavedRequest)},${stamp},${stamp})`);
      return (await tx.all<ContextPracticeTaskRow>(sql`SELECT * FROM context_practice_tasks WHERE id=${id}`))[0];
    });
    return task.origin==='teacher_generated'?run(task.id):projectContextTask(task);
  }
  return {list,get,create,retry:(id:string,options:RuntimeCallOptions={})=>run(id,options)};
}
