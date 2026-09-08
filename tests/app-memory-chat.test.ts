import {afterEach,expect,it} from 'vitest';
import fs from 'node:fs';
import {portableTestDatabase} from './helpers/portable-db';
import {MockAiProvider} from '@/lib/ai/mock-provider';
import {createRuntimeCalls} from '@/lib/ai/runtime-ledger';
import {createMemoryService} from '@/lib/app-services/memory';
import {createChatService} from '@/lib/app-services/chat';
import {createMaterialService} from '@/lib/four-step/core-materials';
import {createAnswerService} from '@/lib/app-services/answers';
import {selectionMockResolver} from '@/lib/four-step/selection-mock';
import type {StructuredAiRequest} from '@/lib/ai/contracts';
const fixtures:Array<ReturnType<typeof portableTestDatabase>>=[];
afterEach(()=>fixtures.splice(0).forEach(f=>f.close()));
function setup(resolve:(request:StructuredAiRequest<unknown>)=>unknown|Promise<unknown>){
  const f=portableTestDatabase();fixtures.push(f);let seq=0;
  const platform={now:()=>new Date('2026-09-08T00:00:00Z'),newId:()=>`memory-test-${++seq}`,bootId:'memory-test',allowMock:true,loadPrompt:(name:string)=>fs.readFileSync(`pipeline/prompts/${name}`,'utf8')};
  const runtime=createRuntimeCalls(f.database,new MockAiProvider(resolve),platform);
  return {...f,platform,runtime,memory:createMemoryService(f.database,runtime,platform)};
}
function seed(f:ReturnType<typeof setup>){
  f.connection.exec("INSERT INTO companion_threads(id,scope_key,scope_type,title,created_at,updated_at) VALUES('t','general:t','general','Chat','2026-09-07','2026-09-07')");
  for(let i=1;i<=4;i++)f.connection.prepare("INSERT INTO companion_messages(id,thread_id,sequence_no,role,text,status,client_message_id,created_at) VALUES(?,'t',?,'user','I want to practise English every day.','sent',?,'2026-09-07')").run(`m${i}`,i,`m${i}`);
}
it('clear revokes a pending extraction and excludes old source messages after a restart',async()=>{
  let release!:(value:unknown)=>void,started!:()=>void;const entered=new Promise<void>(r=>started=r);
  const f=setup(()=>{started();return new Promise(r=>release=r);});seed(f);
  const task=f.memory.extract('t');await entered;await f.memory.clear();
  release({memories:[{memoryKey:'daily_english',category:'goal',summary:'每天练习英语',confidence:.95,evidenceMessageIds:['m4']}]});
  expect(await task).toEqual([]);expect(await f.memory.list()).toEqual([]);
  const reopened=createMemoryService(f.database,f.runtime,f.platform);
  expect(await reopened.extract('t')).toEqual([]);expect(await reopened.jobs()).toEqual([]);
  expect(f.connection.prepare('SELECT * FROM ai_runs').all()).toHaveLength(1);
});
it('memory failures are persisted and an explicit retry completes the same batch',async()=>{
  let fail=true;const f=setup(()=>{if(fail)throw new Error('Mock provider unavailable');return {memories:[]};});seed(f);
  await expect(f.memory.extract('t')).rejects.toThrow();const jobs=await f.memory.jobs();expect(jobs).toHaveLength(1);expect(jobs[0].status).toBe('failed');
  fail=false;await f.memory.retry(jobs[0].id,{retryFailed:true,retryUnknown:true});expect(await f.memory.jobs()).toEqual([]);
  expect(f.connection.prepare('SELECT * FROM companion_memory_jobs').all()).toHaveLength(1);
});
it('chat cannot send a material rejected by the same source audit used by learning',async()=>{
  let sent:unknown;const f=setup(request=>{
    if(request.schemaName==='companion_dialogue_v2'){sent=JSON.parse(request.input);return {messages:[{text:'What do you enjoy about living alone?',translationZh:'你喜欢独居的哪些方面？',purpose:'follow_up'}],usedLearningItemIds:[],glossary:[]};}
    return selectionMockResolver(request);
  });
  f.connection.exec("INSERT INTO questions(id,book_id,part,text,text_zh,norm_text) VALUES('q','removed',1,'Do you live alone?','你一个人住吗？','q')");
  const materials=createMaterialService({...f.platform,database:f.database,runtime:f.runtime}),answers=createAnswerService(f.database,materials,f.platform);
  let draft=await answers.start('q','test-start');draft=await answers.saveDraft(draft.id,{version:0,english:"I'm used to live alone.",chinese:'我已经习惯一个人住了。',englishUnknown:false});
  const saved=await answers.submit(draft.id,draft.version),detail=await answers.detail(saved.attemptId);
  await materials.process(detail.material!.id);expect((await materials.inspect(detail.material!.id)).verified).toBe(true);
  f.connection.exec("INSERT INTO light_study_progress(learning_item_id,first_seen_at,last_seen_at,due_at) SELECT id,'2026-09-01','2026-09-01','2026-09-02' FROM learning_items");
  f.connection.prepare("UPDATE speaking_question_attempts SET answer_text='Source has changed' WHERE id=?").run(saved.attemptId);
  expect((await materials.inspect(detail.material!.id)).verified).toBe(false);
  const chat=createChatService(f.database,f.runtime,f.memory,materials,f.platform),conversation=await chat.create({clientRequestId:'test-conversation'});
  const user=await chat.prepare(conversation.id,{clientMessageId:'user-message-test',text:'I live alone.'});await chat.process(conversation.id,user.id);
  expect(sent).toMatchObject({dueExpressions:[]});
});
