import {afterEach,expect,it,vi} from 'vitest';
import fs from 'node:fs';
import {portableTestDatabase} from './helpers/portable-db';
import {query as sql} from '@/lib/platform/sql';
import {hash} from '@/lib/four-step/shared';
import {recallFixture} from './helpers/recall-material';
import {publishSentenceMaterials} from '@/lib/sentence-study/materials';
import {readSentenceCatalogue} from '@/lib/sentence-study/catalogue';
import {createSentenceService} from '@/lib/sentence-study/core-service';
import {createContextPracticeService} from '@/lib/context-practice/service';
import {relatedQuestionMock} from '@/lib/context-practice/mock';
import {assertRelatedQuestion} from '@/lib/context-practice/contracts';
import {createCoachingService} from '@/lib/coaching/service';
import {coachingMock} from '@/lib/coaching/mock';
import {assertCoachingFeedback,type CoachingContext,type CoachingSubmit} from '@/lib/coaching/contracts';
import {MockAiProvider} from '@/lib/ai/mock-provider';
import {createRuntimeCalls} from '@/lib/ai/runtime-ledger';
import {AiProviderError} from '@/lib/ai/errors';
import {createMemoryService} from '@/lib/app-services/memory';
import {createChatService} from '@/lib/app-services/chat';
import {createMaterialService} from '@/lib/four-step/core-materials';
import type {MaterialInput,MaterialRow} from '@/lib/four-step/material-types';
import type {StructuredAiRequest} from '@/lib/ai/contracts';
const open:ReturnType<typeof portableTestDatabase>[]=[];
afterEach(()=>{for(const f of open)f.close();open.length=0;vi.restoreAllMocks();});
async function setup(resolver?:(request:StructuredAiRequest<unknown>)=>unknown|Promise<unknown>){
  const f=portableTestDatabase();open.push(f);let sequence=0,clock=new Date('2026-09-15T06:00:00Z'),configured=true;
  const requests:StructuredAiRequest<unknown>[]=[],platform={now:()=>clock,newId:()=>`related-${++sequence}`,bootId:'context-practice',loadPrompt:(name:string)=>fs.readFileSync(`pipeline/prompts/${name}`,'utf8'),generationAvailable:()=>configured,allowMock:true};
  const provider=new MockAiProvider(async request=>{requests.push(request);if(resolver)return resolver(request);if(request.schemaName==='context_related_question_v1')return relatedQuestionMock(request);if(request.schemaName==='companion_dialogue_v2')return {messages:[{text:'What feels different in this routine?',translationZh:'这种日常有什么不一样？',purpose:'follow_up'}],usedLearningItemIds:[],glossary:[]};return coachingMock(request);});
  const runtime=createRuntimeCalls(f.database,provider,platform),memory=createMemoryService(f.database,runtime,platform);
  const input:MaterialInput={sourceType:'ielts_practice',sourceId:'a',mode:'practice',actualAnswer:'I am used to live alone.',intendedMeaningZh:'我已经习惯一个人住了。',question:{id:'q',textEn:'Where do you live?',textZh:'你住哪里？',part:1},spokenStyleVersion:'personal-spoken-v2'};
  const analysis=recallFixture({key:'a',kind:'attempt',createdAt:clock.toISOString(),questionId:'q',questionEn:'Where do you live?',questionZh:'你住哪里？',part:1,english:input.actualAnswer,chinese:input.intendedMeaningZh,mode:'practice',index:0,hash:'source',spokenStyleVersion:'personal-spoken-v2',en:[{index:0,start:0,end:input.actualAnswer.length,text:input.actualAnswer}],zh:[{index:0,start:0,end:input.intendedMeaningZh.length,text:input.intendedMeaningZh}]}).analysis;
  await f.database.write(async tx=>{
    await tx.run(sql`INSERT INTO topics(id,book_id,name_zh,name_en) VALUES('home','retired','居住','Home'),('unlinked','retired','其他','Other')`);
    await tx.run(sql`INSERT INTO questions(id,book_id,topic_id,part,text,text_zh,norm_text) VALUES('q','retired','home',1,'Where do you live?','你住哪里？','q'),('related-q','retired','home',1,'What would make a new home feel comfortable?','什么让新住所感觉舒适？','related-q'),('unlinked-q','retired','unlinked',1,'Where are you living?','你住在哪？','unlinked-q')`);
    await tx.run(sql`INSERT INTO speaking_question_attempts(id,question_id,mode,answer_text,intended_meaning_zh,status) VALUES('a','q','practice',${input.actualAnswer},${input.intendedMeaningZh},'completed')`);
    await tx.run(sql`INSERT INTO practice_materials(id,source_type,source_id,question_id,input_json,input_hash,analysis_json,status,contract_version,created_at,updated_at) VALUES('m','ielts_practice','a','q',${JSON.stringify(input)},${hash(JSON.stringify(input))},${JSON.stringify(analysis)},'ready','evidence_v2',${clock.toISOString()},${clock.toISOString()})`);
    const [m]=await tx.all<MaterialRow>(sql`SELECT * FROM practice_materials WHERE id='m'`);await publishSentenceMaterials(tx,m,input,analysis,clock);
  });
  const loadMaterial=async()=>f.database.read(async db=>{const {cards}=await readSentenceCatalogue(db,{type:'material',id:'m'},platform.now());return {materialId:'m',questionId:'q',questionEn:'Where do you live?',questionZh:'你住哪里？',sourceType:'ielts_practice',sourceId:'a',sentences:cards.map(c=>({id:c.id,chinese:c.chinese,english:c.english})),referenceText:cards.map(c=>c.english).join('\n')};});
  const tasks=createContextPracticeService(f.database,runtime,platform),coaching=createCoachingService(f.database,runtime,memory,{...platform,loadMaterial}),sentences=createSentenceService(f.database,platform);
  const card=(await loadMaterial()).sentences[0];
  return {...f,platform,runtime,memory,requests,tasks,coaching,sentences,card,setTime:(time:string)=>{clock=new Date(time);},setConfigured:(value:boolean)=>{configured=value;}};
}
const bank={clientRequestId:'bank-request',materialId:'m',origin:'bank',questionId:'related-q'};
const submit=(context:CoachingContext,text='I would bring some familiar pictures.',clientMessageId='first-related-answer'):CoachingSubmit=>({context,text,clientMessageId,correctionHint:false,retryFailed:false,retryUnknown:false});
it('lists only explicit topic-linked bank questions and GET performs no write or generation',async()=>{
  const f=await setup(),before=f.connection.prepare('SELECT total_changes() count').get();
  const result=await f.tasks.list('m');expect(result.candidates.map(q=>q.questionId)).toEqual(['related-q']);expect(result.tasks).toEqual([]);expect(f.requests).toHaveLength(0);expect(f.connection.prepare('SELECT total_changes() count').get()).toEqual(before);
  await expect(f.tasks.create({...bank,questionId:'unlinked-q'})).rejects.toMatchObject({code:'related_question_unlinked'});expect(f.connection.prepare('SELECT * FROM context_practice_tasks').all()).toHaveLength(0);
});
it('bank selection saves a stable identity, preserves source question and never invokes Runtime',async()=>{
  const f=await setup(),task=await f.tasks.create(bank);expect(await f.tasks.create(bank)).toEqual(task);expect(task).toMatchObject({origin:'bank',sourceQuestionId:'q',questionId:'related-q',status:'ready'});expect(f.requests).toHaveLength(0);
  await expect(f.tasks.create({...bank,origin:'teacher_generated',questionId:undefined})).rejects.toMatchObject({code:'related_request_conflict'});
});
it('teacher generation requires configured service and an explicit create, stores its own provenance and no model answer',async()=>{
  const f=await setup();f.setConfigured(false);const request={clientRequestId:'generate-request',materialId:'m',origin:'teacher_generated'};
  expect((await f.tasks.list('m')).generationAvailable).toBe(false);await expect(f.tasks.create(request)).rejects.toMatchObject({code:'related_generation_unconfigured'});expect(f.requests).toHaveLength(0);
  f.setConfigured(true);const task=await f.tasks.create(request);expect(task).toMatchObject({origin:'teacher_generated',questionId:null,sourceQuestionId:'q',status:'ready'});expect(task.promptEn).toContain('new routine');expect(JSON.stringify(task)).not.toContain('used to living');
  expect((await f.tasks.create(request)).id).toBe(task.id);expect(f.requests).toHaveLength(1);expect(f.requests[0]).toMatchObject({schemaVersion:'context-related-question-v1',promptVersion:'context-related-question-chloe-v1'});
});
it('an unknown generation remains one task and requires explicit retryUnknown before another request',async()=>{
  let calls=0;const f=await setup(request=>{if(++calls===1)throw new AiProviderError('lost response','network_error',true);return relatedQuestionMock(request);});
  await expect(f.tasks.create({clientRequestId:'unknown-request',materialId:'m',origin:'teacher_generated'})).rejects.toMatchObject({code:'result_unknown'});
  const task=(await f.tasks.list('m')).tasks[0];expect(task.status).toBe('failed');await expect(f.tasks.retry(task.id,{retryFailed:true})).rejects.toMatchObject({code:'result_unknown'});expect(calls).toBe(1);
  expect((await f.tasks.retry(task.id,{retryUnknown:true})).id).toBe(task.id);expect(calls).toBe(2);expect(f.connection.prepare('SELECT * FROM context_practice_tasks').all()).toHaveLength(1);
});
it('withdrawal during generation leaves the task failed with its request evidence preserved',async()=>{
  let entered!:()=>void,release!:(value:unknown)=>void;const started=new Promise<void>(resolve=>entered=resolve);let request:StructuredAiRequest<unknown>|undefined;
  const f=await setup(input=>{request=input;entered();return new Promise(resolve=>release=resolve);});
  const pending=f.tasks.create({clientRequestId:'withdrawal-request',materialId:'m',origin:'teacher_generated'});await started;
  await f.database.write(tx=>tx.run(sql`UPDATE practice_materials SET status='hidden' WHERE id='m'`));release(relatedQuestionMock(request!));
  await expect(pending).rejects.toMatchObject({code:'related_material_unavailable'});
  const task=f.connection.prepare('SELECT status,error_code,request_json FROM context_practice_tasks').get();expect(task).toMatchObject({status:'failed',error_code:'related_material_unavailable'});expect(String(task?.request_json)).toContain('context-related-question-v1');
});
it('first related answer sees only the new question and observations do not change FSRS',async()=>{
  const f=await setup(),task=await f.tasks.create(bank),context:CoachingContext={materialId:'m',questionId:task.questionId!,relatedTaskId:task.id,practiceId:'related-practice',mode:'answer_independent'};
  const view=await f.coaching.view(context);expect(view.questionEn).toBe(task.promptEn);expect(view.chinese).toBeNull();expect(view.messages).toEqual([]);expect(JSON.stringify(view)).not.toContain('习惯');expect(f.requests).toHaveLength(0);
  const result=await f.coaching.submit(submit(context));const payload=JSON.parse(f.requests[0].input);expect(payload.currentTask.intentZh).toBe('');expect(payload.currentTask.referenceEnglish).toBeUndefined();expect(payload.recentHistory).toEqual([]);expect(payload.currentTask.questionEn).toBe(task.promptEn);
  expect(result.messages.find(m=>m.feedback)?.feedback?.targetObservations).toEqual([{sentenceId:f.card.id,status:'not_observed',sourceQuote:'',reasonZh:'隔离模拟：本次没有独立的目标使用判定。'}]);
  expect((await f.tasks.get(task.id)).status).toBe('completed');expect(f.connection.prepare('SELECT * FROM sentence_study_progress').all()).toHaveLength(0);
});
it('recent exposure is retained across paused sessions and new practices, with elapsed time instead of a permanent assisted flag',async()=>{
  const f=await setup();let session=await f.sentences.create({scope:{type:'material',id:'m'},mode:'learn',clientRequestId:'exposure-session',experienceVersion:'context-workspace-v1'});
  session=await f.sentences.event(session.id,{type:'reveal',experienceVersion:'context-workspace-v1',version:session.version,clientEventId:'prior-help',sentenceId:f.card.id,unitVersion:session.cards[0].version});
  await f.sentences.event(session.id,{type:'pause',version:session.version,clientEventId:'pause-after-help'});
  f.setTime('2026-09-15T06:10:00Z');const context:CoachingContext={materialId:'m',questionId:'q',sourceSessionId:session.id,rootPracticeId:'root-practice',practiceId:'later-practice',mode:'answer_independent'};
  const current=await f.coaching.submit(submit(context));const first=current.messages.find(m=>m.role==='user')!;expect(first.assisted).toBe(true);expect(first.practiceEvidence).toMatchObject({currentCueCondition:'question_only',lastHelpAt:'2026-09-15T06:00:00.000Z',elapsedMsSinceHelp:600000,exposureEventIds:['prior-help']});
  f.setTime('2026-09-17T06:10:00Z');const later=await f.coaching.submit(submit({...context,practiceId:'next-day-practice'},'I live near the station.','next-day-answer'));const next=later.messages.find(m=>m.role==='user')!;expect(next.assisted).toBe(false);expect(next.practiceEvidence?.currentCueCondition).toBe('question_only');expect(next.practiceEvidence?.lastHelpAt).toBe('2026-09-15T06:10:00.000Z');expect(next.practiceEvidence?.firstOutputMessageId).toBe(first.id);
});
it('exposure in another session still traces to the relevant current sentence',async()=>{
  const f=await setup(),first=await f.sentences.create({scope:{type:'material',id:'m'},mode:'learn',clientRequestId:'first',experienceVersion:'context-workspace-v1'}),second=await f.sentences.create({scope:{type:'material',id:'m'},mode:'learn',clientRequestId:'second',experienceVersion:'context-workspace-v1'});
  await f.sentences.event(first.id,{type:'exposure',source:'audio',experienceVersion:'context-workspace-v1',version:0,clientEventId:'other-session-audio',sentenceId:f.card.id,unitVersion:first.cards[0].version});
  const view=await f.coaching.view({materialId:'m',questionId:'q',sourceSessionId:second.id,practiceId:'new-practice',mode:'answer_independent'});expect(view.practiceEvidence?.exposureEventIds).toContain('other-session-audio');expect(view.practiceEvidence?.lastHelpAt).toBe(f.platform.now().toISOString());
});
it('target observations accept a quoted natural variant but reject invented or unsupplied evidence',()=>{
  const input={coachingVersion:'context-coaching-v1',currentTask:{mode:'answer_independent'},latestUserMessage:'Living by myself feels normal now.',correctionHint:false,relevantMemories:[],targets:[{id:'target'}]},feedback={verdict:'natural',extent:'full_answer',messages:[{text:'That works naturally.'}],findings:[],targetObservations:[{sentenceId:'target',status:'observed',sourceQuote:'Living by myself feels normal now.',reasonZh:'自然替代表达说明已经习惯。'}]};
  expect(()=>assertCoachingFeedback(feedback,input)).not.toThrow();expect(()=>assertCoachingFeedback({...feedback,targetObservations:[{...feedback.targetObservations[0],sourceQuote:'made up'}]},input)).toThrow();
  expect(()=>assertRelatedQuestion({promptEn:'Where do you live?',promptZh:'你住哪里？',targetSentenceIds:['unknown'],targetMemoryIds:[],rationaleZh:'错误'}, {sourceQuestion:{textEn:'Where do you live?'},targets:[],memories:[]})).toThrow();
});
it('stored old Coaching payloads retain their old prompt and schema on recovery',async()=>{
  const f=await setup(),context:CoachingContext={materialId:'m',questionId:'q',practiceId:'legacy-practice',mode:'answer_independent'},input=submit(context);
  const user=await f.coaching.prepare(input),metadata=JSON.parse(user.metadata_json);delete metadata.payload.coachingVersion;delete metadata.payload.targets;delete metadata.payload.practiceEvidence;
  await f.database.write(tx=>tx.run(sql`UPDATE companion_messages SET metadata_json=${JSON.stringify(metadata)} WHERE id=${user.id}`));
  await f.coaching.submit(input);expect(f.requests[0]).toMatchObject({schemaName:'sentence_coaching_v1',schemaVersion:'sentence-coaching-v1',promptVersion:'sentence-coaching-chloe-v2-young-us-v1'});
});
it('FreeTalk receives current sentence context and ignores legacy due tables',async()=>{
  const f=await setup(),materials=createMaterialService({database:f.database,runtime:f.runtime,...f.platform}),chat=createChatService(f.database,f.runtime,f.memory,materials,f.platform);
  await f.sentences.create({scope:{type:'material',id:'m'},mode:'learn',clientRequestId:'current-workspace',experienceVersion:'context-workspace-v1'});
  f.connection.exec("INSERT INTO light_study_progress(learning_item_id,first_seen_at,last_seen_at,due_at) VALUES('legacy-do-not-send','2020-01-01','2020-01-01','2020-01-02')");
  const conversation=await chat.create({clientRequestId:'new-chat',questionId:'q'}),user=await chat.prepare(conversation.id,{clientMessageId:'new-chat-message',text:'I am thinking about my new routine.'});await chat.process(conversation.id,user.id);
  const request=f.requests.find(request=>request.schemaName==='companion_dialogue_v2')!,payload=JSON.parse(request.input);expect(request.promptVersion).toContain('companion-dialogue-v4');expect(payload.dueExpressions).toEqual([]);expect(payload.contextSentences[0].id).toBe(f.card.id);expect(JSON.stringify(payload)).not.toContain('legacy-do-not-send');
});
