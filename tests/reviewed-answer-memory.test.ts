import {afterEach,expect,it} from 'vitest';
import fs from 'node:fs';
import {portableTestDatabase} from './helpers/portable-db';
import {MockAiProvider} from '@/lib/ai/mock-provider';
import {selectionMockResolver} from '@/lib/four-step/selection-mock';
import {coachingMock} from '@/lib/coaching/mock';
import {createRuntimeCalls} from '@/lib/ai/runtime-ledger';
import {createMaterialService} from '@/lib/four-step/core-materials';
import {createAnswerService} from '@/lib/app-services/answers';
import {createChatService} from '@/lib/app-services/chat';
import {createCoachingService} from '@/lib/coaching/service';
import {createMemoryService} from '@/lib/app-services/memory';
import {recordReviewedAnswerMemoriesIn,teacherMemory} from '@/lib/coaching/learning-memory';
import type {CoachingContext,CoachingMaterial} from '@/lib/coaching/contracts';
import type {StructuredAiRequest} from '@/lib/ai/contracts';
import type {Diagnosis} from '@/lib/four-step/selection-contracts';
const open:Array<ReturnType<typeof portableTestDatabase>>=[];
afterEach(()=>open.splice(0).forEach(f=>f.close()));
function setup(change?:(r:StructuredAiRequest<unknown>,value:unknown)=>unknown){
  const f=portableTestDatabase();open.push(f);let n=0;const requests:StructuredAiRequest<unknown>[]=[];
  f.connection.exec("INSERT INTO questions(id,book_id,part,text,text_zh,norm_text) VALUES('q-memory','retired',1,'Do you live alone?','你一个人住吗？','q-memory')");
  const platform={now:()=>new Date('2026-09-11T10:00:00Z'),newId:()=>`answer-memory-${++n}`,bootId:'answer-memory',allowMock:true,loadPrompt:(name:string)=>fs.readFileSync('pipeline/prompts/'+name,'utf8')};
  const runtime=createRuntimeCalls(f.database,new MockAiProvider(r=>{requests.push(r);let value:unknown;
    if(r.schemaName==='companion_dialogue_v2')value={messages:[{text:'What do you enjoy about living alone?',purpose:'follow_up'}],usedLearningItemIds:[],glossary:[]};
    else if(r.schemaName.startsWith('sentence_coaching')||r.schemaName.startsWith('coaching_error'))value=coachingMock(r);
    else value=selectionMockResolver(r);
    return change?change(r,value):value;
  }),platform);
  const materialService=createMaterialService({...platform,database:f.database,runtime}),answers=createAnswerService(f.database,materialService,platform),memory=createMemoryService(f.database,runtime,platform);
  async function saved(id:string,english="I'm used to live alone.",chinese='我已经习惯一个人住了。',kind:'practice'|'independent'='practice',source:string|null=null){
    let d=await answers.start('q-memory','start-'+id,source,kind);
    d=await answers.saveDraft(d.id,kind==='practice'&&!chinese?{version:d.version,inputText:english}:{version:d.version,english,chinese:kind==='independent'?'':chinese,englishUnknown:!english});
    if(kind==='independent')d=await answers.commitEnglish(d.id,d.version);
    const s=await answers.submit(d.id,d.version),detail=await answers.detail(s.attemptId);return {attemptId:s.attemptId,materialId:detail.material!.id};
  }
  const publish=async(id:string)=>{const m=await materialService.process(id);expect(m.status).toBe('ready');return m;};
  const record=(id:string,allowMock=true)=>f.database.write(tx=>recordReviewedAnswerMemoriesIn(tx,id,platform.now(),{allowMock}));
  return {...f,platform,runtime,requests,materialService,answers,memory,saved,publish,record};
}
it('published answer errors enter memory using existing independent evidence without another API call',async()=>{
  const f=setup(),source=await f.saved('first');await f.publish(source.materialId);const calls=f.requests.length;
  await f.record(source.materialId);expect(f.requests).toHaveLength(calls);
  const [m]=await f.memory.list();expect(m.source_type).toBe('reviewed_answer');expect(m.source_id).toBe(source.attemptId);
  const detail=JSON.parse(m.detail_json),e=detail.occurrences[0];expect(e).toMatchObject({materialId:source.materialId,sourceId:source.attemptId,quote:'used to live alone',correction:'used to living',kind:'confirmed_error',assisted:true});
  expect(e.generatorRunId).not.toBe(e.reviewerRunId);expect(e.sourceVersion).toMatch(/^[a-f0-9]{64}$/);
  await f.record(source.materialId);expect(JSON.parse((await f.memory.list())[0].detail_json).occurrences).toHaveLength(1);
  expect(f.connection.prepare('SELECT * FROM sentence_study_progress').all()).toHaveLength(0);
});
it('a rejected independent selection returns its evidence to bounded repair without losing the original attempt',async()=>{
  let reject=true;const f=setup((request,value)=>{if(request.schemaName.startsWith('four_step_selection')&&reject){reject=false;return {...value as object,approved:false,reasonZh:'合成审核反馈：中英重复意思应合并且保留原始引用'};}return value;});
  const source=await f.saved('selection-repair');
  expect((await f.materialService.process(source.materialId)).status).toBe('failed');
  expect((await f.materialService.process(source.materialId,{retry:true})).status).toBe('ready');
  const diagnosis=f.requests.filter(r=>r.schemaName.startsWith('four_step_diagnosis'));
  expect(diagnosis).toHaveLength(2);expect(JSON.parse(diagnosis[1].input).correction).toMatchObject({validationIssue:expect.stringContaining('中英重复意思'),reviewRunId:expect.any(String)});
  expect(f.connection.prepare('SELECT * FROM speaking_question_attempts').all()).toHaveLength(1);
  expect(f.requests).toHaveLength(6);
});
it('different genuine outputs aggregate recurrence but independent and assisted evidence remain separate',async()=>{
  const f=setup(),a=await f.saved('a');await f.publish(a.materialId);await f.record(a.materialId);
  const b=await f.saved('b',"I'm used to live alone.",'','independent',a.attemptId);await f.publish(b.materialId);await f.record(b.materialId);
  const memories=await f.memory.list();expect(memories).toHaveLength(1);const events=JSON.parse(memories[0].detail_json).occurrences;
  expect(events).toHaveLength(2);expect(events[0].assisted).toBe(true);expect(events[1].assisted).toBe(false);expect(events[1].mode).toBe('independent');
});
it('a revised analysis keeps its review version without counting the same answer error twice',async()=>{
  const f=setup(),a=await f.saved('versions'),first=await f.publish(a.materialId);await f.record(first.id);
  const next=await f.materialService.prepare({...JSON.parse(first.input_json),mode:'exam_style'});await f.publish(next.id);await f.record(next.id);
  const [m]=await f.memory.list(),occurrences=JSON.parse(m.detail_json).occurrences;expect(occurrences).toHaveLength(1);
  expect(occurrences[0].materialId).toBe(first.id);expect(occurrences[0].reviewedVersions).toHaveLength(1);expect(occurrences[0].reviewedVersions[0].materialId).toBe(next.id);
});
it('Chinese preparation, existing natural regional wording, and uncertain ASR never become confirmed errors',async()=>{
  const f=setup((r,value)=>{if(r.schemaName.startsWith('four_step_diagnosis')&&JSON.parse(r.input).source.actualAnswer==='I olive alone.'){const diagnosis=value as Diagnosis;diagnosis.units[0].status='uncertain';diagnosis.units[0].gaps=[];}return value;});
  for(const [id,en,zh] of [['preparation','','我准备午饭。'],['regional','I live in a flat.','我住在公寓里。'],['asr','I olive alone.','']]){const a=await f.saved(id,en,zh);await f.publish(a.materialId);await f.record(a.materialId);}
  expect(await f.memory.list()).toHaveLength(0);
});
it('a quoted accepted variant is not turned into an error even if an upstream label contradicts it',async()=>{
  const f=setup((r,value)=>{if(r.schemaName.startsWith('four_step_diagnosis'))(value as Diagnosis).units[0].gaps[0].acceptableVariants=['used to live alone'];return value;});
  const a=await f.saved('variant');await f.publish(a.materialId);await f.record(a.materialId);expect(await f.memory.list()).toHaveLength(0);
});
it('ready flag alone, changed source, missing review and disallowed Mock evidence cannot create memories',async()=>{
  const f=setup(),a=await f.saved('bad');await expect(f.record(a.materialId)).rejects.toMatchObject({code:'memory_material_not_ready'});
  await f.publish(a.materialId);await expect(f.record(a.materialId,false)).rejects.toMatchObject({code:'memory_material_unverified'});
  const previous=await f.memory.list();
  f.connection.prepare("UPDATE speaking_question_attempts SET answer_text='Replaced text' WHERE id=?").run(a.attemptId);
  await expect(f.record(a.materialId)).rejects.toMatchObject({code:'memory_material_unverified'});expect(await f.memory.list()).toEqual(previous);
});
it('clear blocks an already saved answer whose material publishes later; a newly saved answer remains eligible',async()=>{
  const f=setup(),a=await f.saved('pending');await f.memory.clear();await f.publish(a.materialId);expect(await f.record(a.materialId)).toMatchObject({cutoffBlocked:true});expect(await f.memory.list()).toHaveLength(0);
  const b=await f.saved('new');await f.publish(b.materialId);await f.record(b.materialId);expect(await f.memory.list()).toHaveLength(1);
});
it('reviewed FreeTalk errors point to the exact user message and cannot come from teacher text',async()=>{
  const f=setup();
  f.connection.exec("INSERT INTO free_talk_conversations(id,title,mode,status) VALUES('ft-memory','Home','relaxed','active')");
  f.connection.prepare("INSERT INTO free_talk_messages(id,conversation_id,sequence_no,role,text) VALUES('ft-user','ft-memory',1,'user',?)").run("I'm used to live alone.");
  f.connection.prepare("INSERT INTO free_talk_messages(id,conversation_id,sequence_no,role,text) VALUES('ft-teacher','ft-memory',2,'assistant',?)").run("You could say, I'm used to living alone.");
  const m=await f.materialService.prepare({sourceType:'free_talk',sourceId:'ft-memory',question:null,mode:'free_talk',actualAnswer:"I'm used to live alone.",intendedMeaningZh:'',spokenStyleVersion:'personal-spoken-v2',selectionPolicyVersion:'evidence-exclusion-v1',sentenceStudyVersion:'sentence-material-v1',sourceMessages:[{id:'ft-user',role:'user',text:"I'm used to live alone."},{id:'ft-teacher',role:'assistant',text:"You could say, I'm used to living alone."}]});
  await f.publish(m.id);await f.record(m.id);const [memory]=await f.memory.list();
  expect(JSON.parse(memory.detail_json).occurrences[0]).toMatchObject({sourceType:'free_talk',sourceId:'ft-user',quote:'used to live alone'});
  await f.memory.clear();expect(await f.record(m.id)).toMatchObject({cutoffBlocked:true});expect(await f.memory.list()).toHaveLength(0);
});
it('deletion and dismissal survive repeated publication; explicit restoration can collect future errors',async()=>{
  const f=setup(),a=await f.saved('delete-a');await f.publish(a.materialId);await f.record(a.materialId);const [m]=await f.memory.list();await f.memory.state(m.id,'deleted');
  const b=await f.saved('delete-b');await f.publish(b.materialId);await f.record(b.materialId);expect(await f.memory.list()).toHaveLength(0);
  await f.memory.state(m.id,'active');await f.record(b.materialId);expect(JSON.parse((await f.memory.list())[0].detail_json).occurrences).toHaveLength(2);
});
it('teachers receive quoted mistake, correction and reason with bounded relevance; only positive text use adds evidence',async()=>{
  const f=setup(),a=await f.saved('teach');await f.publish(a.materialId);await f.record(a.materialId);const [m]=await f.memory.list();
  expect(teacherMemory(m)).toMatchObject({learning:{mistake:'used to live alone',correction:'used to living',assisted:true,sourceId:a.attemptId}});
  const chat=createChatService(f.database,f.runtime,f.memory,f.materialService,f.platform),conversation=await chat.create({clientRequestId:'memory-chat'}),user=await chat.prepare(conversation.id,{clientMessageId:'memory-chat-user',text:'I live alone.'});await chat.process(conversation.id,user.id);
  const chatInput=JSON.parse(f.requests.find(r=>r.schemaName==='companion_dialogue_v2')!.input);expect(chatInput.relevantMemories[0].learning).toMatchObject({mistake:'used to live alone',correction:'used to living'});expect(chatInput.memoryUsePolicy).toMatchObject({maxOldIssues:1,absenceIsNotImprovement:true});expect(chatInput.dueExpressions).toEqual([]);
  const material:CoachingMaterial={materialId:a.materialId,questionId:'q-memory',questionEn:'Do you live alone?',questionZh:'你一个人住吗？',sourceType:'ielts_practice',sourceId:a.attemptId,sentences:[{id:'sentence-test',chinese:'我已经习惯独居。',english:"I'm used to living alone."}],referenceText:"I'm used to living alone."};
  const service=createCoachingService(f.database,f.runtime,f.memory,{...f.platform,loadMaterial:async()=>material}),context:CoachingContext={materialId:a.materialId,questionId:'q-memory',practiceId:'positive-use',mode:'answer_independent'};
  await service.submit({context,text:'I live with my family.',clientMessageId:'no-mention',correctionHint:false,retryFailed:false,retryUnknown:false});
  expect(JSON.parse((await f.memory.list())[0].detail_json).occurrences).toHaveLength(1);
  await service.submit({context:{...context,practiceId:'quoting-only'},text:"I know the expression 'used to living'.",clientMessageId:'quoted-mention',correctionHint:false,retryFailed:false,retryUnknown:false});
  expect(JSON.parse((await f.memory.list())[0].detail_json).occurrences).toHaveLength(1);
  await service.submit({context:{...context,practiceId:'positive-use-fresh'},text:"I'm used to living alone.",clientMessageId:'positive-mention',correctionHint:false,retryFailed:false,retryUnknown:false});
  const events=JSON.parse((await f.memory.list())[0].detail_json).occurrences;expect(events).toHaveLength(2);expect(events[1]).toMatchObject({kind:'correct_form_observed',quote:'used to living',assisted:false});
  expect(f.connection.prepare('SELECT * FROM sentence_study_progress').all()).toHaveLength(0);
  await service.submit({context:{...context,practiceId:'recurrence-fresh'},text:"I'm used to live alone.",clientMessageId:'recurrence-mention',correctionHint:false,retryFailed:false,retryUnknown:false});
  for(const job of await f.memory.jobs())await f.memory.retry(job.id);
  const recurrent=await f.memory.list();expect(recurrent).toHaveLength(1);expect(recurrent[0].id).toBe(m.id);expect(JSON.parse(recurrent[0].detail_json).occurrences.at(-1)).toMatchObject({kind:'confirmed_error',assisted:false});
  await f.memory.state(m.id,'deleted');
  await service.submit({context:{...context,practiceId:'after-deletion'},text:"I'm used to live alone.",clientMessageId:'deleted-issue-return',correctionHint:false,retryFailed:false,retryUnknown:false});
  for(const job of await f.memory.jobs())await f.memory.retry(job.id);expect(await f.memory.list()).toHaveLength(0);
});
