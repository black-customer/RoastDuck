import {afterEach,expect,it} from 'vitest';
import fs from 'node:fs';
import {portableTestDatabase} from './helpers/portable-db';
import {MockAiProvider} from '@/lib/ai/mock-provider';
import {createRuntimeCalls} from '@/lib/ai/runtime-ledger';
import {AiProviderError} from '@/lib/ai/errors';
import {createMemoryService} from '@/lib/app-services/memory';
import {createCoachingService} from '@/lib/coaching/service';
import {coachingMock} from '@/lib/coaching/mock';
import type {CoachingMaterial,CoachingContext,CoachingSubmit} from '@/lib/coaching/contracts';
import type {StructuredAiRequest} from '@/lib/ai/contracts';

const fixtures:Array<ReturnType<typeof portableTestDatabase>>=[];
afterEach(()=>fixtures.splice(0).forEach(f=>f.close()));
const c:CoachingContext={materialId:'material-1',sentenceId:'sentence-1',questionId:'question-1',mode:'sentence_guided',practiceId:'practice-111'};
const material:CoachingMaterial={materialId:c.materialId,questionId:'question-1',questionEn:'Do you live alone?',questionZh:'你一个人住吗？',sourceType:'ielts_practice',sourceId:'answer-1',sentences:[{id:'sentence-1',chinese:'我已经习惯一个人住了。',english:"I'm used to living alone."}],referenceText:"I'm used to living alone."};
function setup(resolver:(r:StructuredAiRequest<unknown>)=>unknown|Promise<unknown>=coachingMock){
  const f=portableTestDatabase();fixtures.push(f);let seq=0;
  const platform={now:()=>new Date('2026-09-10T10:00:00Z'),newId:()=>`coaching-test-${++seq}`,bootId:'coaching-test',loadPrompt:(name:string)=>fs.readFileSync(`pipeline/prompts/${name}`,'utf8'),loadMaterial:async()=>material};
  const runtime=createRuntimeCalls(f.database,new MockAiProvider(resolver),platform),memory=createMemoryService(f.database,runtime,platform);
  const service=createCoachingService(f.database,runtime,memory,platform);
  return {...f,platform,runtime,memory,service};
}
const submit=(context=c,text="I'm used to living alone.",id='message-111'):CoachingSubmit=>({context,text,clientMessageId:id,correctionHint:false,retryFailed:false,retryUnknown:false});
async function drain(f:ReturnType<typeof setup>){for(const job of await f.memory.jobs())await f.memory.retry(job.id);}
it('GET has no writes or AI; guided input is shown but no reference answer escapes',async()=>{
  const f=setup(),before=f.connection.prepare('SELECT COUNT(*) n FROM companion_threads').get();
  const result=await f.service.view(c);expect(result.threadId).toBeNull();expect(result.chinese).toBe(material.sentences[0].chinese);
  expect(JSON.stringify(result)).not.toContain('used to living');expect(f.connection.prepare('SELECT COUNT(*) n FROM companion_threads').get()).toEqual(before);
  expect(f.connection.prepare('SELECT * FROM ai_runs').all()).toEqual([]);
});
it('preserves output before provider, handles duplicate requests once, never creates materials or schedules',async()=>{
  let entered!:()=>void,release!:(v:unknown)=>void;const started=new Promise<void>(r=>entered=r);
  const f=setup(()=>{entered();return new Promise(res=>release=res);});const input=submit(),task=f.service.submit(input);await started;
  expect(f.connection.prepare("SELECT text FROM companion_messages WHERE role='user'").get()).toMatchObject({text:input.text});
  const duplicate=f.service.submit(input);await expect(f.service.submit({...input,text:'Changed answer.'})).rejects.toMatchObject({code:'coaching_message_conflict'});
  release(coachingMock({input:JSON.stringify({latestUserMessage:input.text}),schemaName:'sentence_coaching_v1'} as StructuredAiRequest<unknown>));
  await task;await duplicate;const recovered=await f.service.submit(input);expect(recovered.messages).toHaveLength(2);
  expect(f.connection.prepare('SELECT * FROM ai_runs').all()).toHaveLength(1);expect(f.connection.prepare('SELECT * FROM practice_materials').all()).toHaveLength(0);expect(f.connection.prepare('SELECT * FROM light_study_progress').all()).toHaveLength(0);
});
it('unknown receipt stays unknown after restart unless user explicitly permits another paid request',async()=>{
  let calls=0;const f=setup(r=>{calls++;if(calls===1)throw new AiProviderError('network lost','network_error',true);return coachingMock(r);});
  const input=submit();await expect(f.service.submit(input)).rejects.toMatchObject({code:'result_unknown'});
  const restarted=createCoachingService(f.database,createRuntimeCalls(f.database,new MockAiProvider(r=>{calls++;return coachingMock(r);}),{...f.platform,bootId:'second-boot'}),f.memory,{...f.platform,bootId:'second-boot'});
  await expect(restarted.submit({...input,retryFailed:true})).rejects.toMatchObject({code:'result_unknown'});expect(calls).toBe(1);
  const done=await restarted.submit({...input,retryUnknown:true});expect(done.messages.filter(m=>m.role==='user')).toHaveLength(1);expect(calls).toBe(2);
});
it('guided and successive independent practices share a thread but never leak earlier answers or hints',async()=>{
  const payloads:Record<string,unknown>[]=[];const f=setup(r=>{payloads.push(JSON.parse(r.input));return coachingMock(r);});await f.service.submit(submit());
  const independent:CoachingContext={...c,sentenceId:undefined,mode:'answer_independent',practiceId:'independent-1'};
  const before=await f.service.view(independent);expect(before.messages).toHaveLength(0);expect(before.chinese).toBeNull();expect(JSON.stringify(before)).not.toContain('习惯');
  await f.service.submit(submit(independent,'I live with my family.','independent-message'));
  expect(payloads[1]).toMatchObject({currentTask:{mode:'answer_independent',intentZh:''},recentHistory:[]});expect(JSON.stringify(payloads[1])).not.toContain('used to living');
  expect((await f.service.view({...independent,practiceId:'independent-2'})).messages).toHaveLength(0);
  expect(f.connection.prepare('SELECT * FROM companion_threads').all()).toHaveLength(1);
});
it('a local correction is not a new full-answer success and a valid synonym may be accepted',async()=>{
  const f=setup();await f.service.submit(submit());
  const result=await f.service.submit({...submit(c,'I meant, living by myself feels normal now.','message-local'),correctionHint:true});
  expect(result.messages.findLast(m=>m.feedback)?.feedback).toMatchObject({verdict:'natural',extent:'local_correction'});
  expect(result.messages.filter(m=>m.role==='user').every(m=>m.assisted)).toBe(true);
});
it('feedback-assisted followups in an independent thread are marked assisted',async()=>{
  const f=setup(),independent:CoachingContext={...c,sentenceId:undefined,mode:'answer_independent',practiceId:'independent-evidence'};
  await f.service.submit(submit(independent,'I live with my family.','independent-initial'));
  const result=await f.service.submit({...submit(independent,'I meant, I live with my parents.','independent-correction'),correctionHint:true});
  const users=result.messages.filter(m=>m.role==='user');expect(users[0].assisted).toBe(false);expect(users[1].assisted).toBe(true);
});
it('a skipped request preserves original output and a late reply cannot enter the next practice',async()=>{
  let entered!:()=>void,release!:(v:unknown)=>void;const started=new Promise<void>(r=>entered=r);const f=setup(()=>{entered();return new Promise(r=>release=r);});
  const input=submit(),task=f.service.submit(input);await started;
  await f.service.skip(c,input.clientMessageId);release(coachingMock({input:JSON.stringify({latestUserMessage:input.text}),schemaName:'sentence_coaching_v1'} as StructuredAiRequest<unknown>));
  await expect(task).rejects.toMatchObject({code:'coaching_lease_lost'});
  const result=await f.service.view(c);expect(result.messages).toHaveLength(1);expect(result.messages[0]).toMatchObject({text:input.text,status:'skipped'});
});
it('confirmed errors require an independent evidence reviewer and deduplicate as learning memory',async()=>{
  const f=setup();await f.service.submit(submit(c,"I'm used to live alone."));await drain(f);
  let memories=await f.memory.list();expect(memories).toHaveLength(1);expect(memories[0].category).toBe('learning');
  const evidence=JSON.parse(memories[0].detail_json).occurrences[0];expect(evidence.reviewerRunId).not.toBe(evidence.generatorRunId);expect(evidence.assisted).toBe(true);
  const source=f.connection.prepare('SELECT text FROM companion_messages WHERE id=?').get(evidence.messageId);expect(source).toMatchObject({text:"I'm used to live alone."});
  await f.service.submit(submit(c,"I'm used to live alone.",'message-second'));await drain(f);memories=await f.memory.list();expect(memories).toHaveLength(1);expect(JSON.parse(memories[0].detail_json).occurrences).toHaveLength(2);
});
it('style suggestions, uncertain ASR, rejected findings and fabricated quotes never become confirmed memory',async()=>{
  const f=setup(r=>{
    if(r.schemaName==='coaching_error_reviewer_v1')return {decisions:[{index:0,confirmed:false,sourceQuote:'used to live alone',reasonZh:'当前转写证据不足。',confidence:.5}]};
    return coachingMock(r);
  });
  await f.service.submit(submit(c,"I'm used to live alone."));await drain(f);expect(await f.memory.list()).toHaveLength(0);
  const bad=setup(r=>({...coachingMock(r) as object,findings:[{kind:'confirmed_error',sourceQuote:'not in input',correction:'something else',explanationZh:'不能凭空造证据',memoryKey:'invalid_quote'}]}));
  await expect(bad.service.submit(submit(c,"I'm used to live alone."))).rejects.toMatchObject({code:'coaching_invalid_evidence'});
  expect(await bad.memory.list()).toHaveLength(0);
});
it('clearing memory during pending review prevents late writes and replay resurrection',async()=>{
  let entered!:()=>void,release!:(v:unknown)=>void;const started=new Promise<void>(r=>entered=r);
  const f=setup(r=>{if(r.schemaName==='coaching_error_reviewer_v1'){entered();return new Promise(res=>release=res);}return coachingMock(r);});
  await f.service.submit(submit(c,"I'm used to live alone."));await started;const jobs=await f.memory.jobs();expect(jobs).toHaveLength(1);
  await f.memory.clear();release({decisions:[{index:0,confirmed:true,sourceQuote:'used to live alone',reasonZh:'习惯构式需要动名词。',confidence:.95}]});
  await f.memory.retry(jobs[0].id);expect(await f.memory.list()).toHaveLength(0);
  await f.service.submit(submit(c,"I'm used to live alone."));expect(await f.memory.list()).toHaveLength(0);
});
it('deleting a confirmed issue prevents new wording or later output from silently re-enabling it',async()=>{
  const f=setup();await f.service.submit(submit(c,"I'm used to live alone."));await drain(f);
  const [memory]=await f.memory.list();await f.memory.state(memory.id,'deleted');
  await f.service.submit(submit(c,"I'm used to live alone.",'another-output'));await drain(f);expect(await f.memory.list()).toHaveLength(0);
});
it('a different question, sentence, or reused output id cannot silently change the task',async()=>{
  const f=setup();await expect(f.service.view({...c,questionId:'unrelated-question'})).rejects.toMatchObject({code:'coaching_question_mismatch'});
  await expect(f.service.view({...c,sentenceId:'unknown-sentence'})).rejects.toMatchObject({code:'coaching_sentence_missing'});
  await f.service.submit(submit());await expect(f.service.submit(submit(c,'Different text.'))).rejects.toMatchObject({code:'coaching_message_conflict'});
});
it('casual retrieval includes at most one old learning issue and whole lessons at most two',async()=>{
  const f=setup();
  for(let i=0;i<4;i++)f.connection.prepare("INSERT INTO companion_memories(id,category,summary,detail_json,confidence,source_type,source_id,evidence_json,status,created_at,updated_at) VALUES(?,'learning','独居搭配',?,.9,'coaching_output','old','[]','active','2026-09-10','2026-09-10')").run('old-'+i,JSON.stringify({memoryKey:'live_alone_'+i,correction:'living alone'}));
  expect(await f.memory.relevant('I enjoy living alone.')).toHaveLength(1);
  expect(await f.memory.relevant('I enjoy living alone.',2,2)).toHaveLength(2);
  const payloads:Record<string,unknown>[]=[];
  const runtime=createRuntimeCalls(f.database,new MockAiProvider(r=>{payloads.push(JSON.parse(r.input));return coachingMock(r);}),{...f.platform,bootId:'lesson'});
  const service=createCoachingService(f.database,runtime,f.memory,f.platform);
  await service.submit(submit({...c,mode:'answer_guided',sentenceId:undefined},'I enjoy living alone.'));
  expect(payloads[0].relevantMemories).toHaveLength(2);
});
it('style and ASR-uncertain feedback is conversational but does not even queue confirmation',async()=>{
  const f=setup(()=>({verdict:'uncertain',extent:'uncertain',messages:[{text:'Did you mean you live alone?'}],findings:[{kind:'uncertain',sourceQuote:'olive alone',correction:'live alone',explanationZh:'这可能是转写问题，先确认原意。',memoryKey:'asr_live_alone'},{kind:'style_suggestion',sourceQuote:'olive alone',correction:'live on my own',explanationZh:'如果你是想说独居，这也是一种说法。',memoryKey:'live_on_my_own'}]}));
  await f.service.submit(submit(c,'I olive alone.'));expect(await f.memory.jobs()).toHaveLength(0);expect(await f.memory.list()).toHaveLength(0);expect(f.connection.prepare('SELECT * FROM ai_runs').all()).toHaveLength(1);
});
it('failed independent memory review can recover without repeating delivered feedback',async()=>{
  let reviews=0;const f=setup(r=>{if(r.schemaName==='coaching_error_reviewer_v1'&&++reviews===1)throw new AiProviderError('network lost','network_error',true);return coachingMock(r);});
  const input=submit(c,"I'm used to live alone.");await f.service.submit(input);
  await expect(drain(f)).rejects.toMatchObject({code:'result_unknown'});
  await expect(f.service.retryReviews(c,{retryFailed:true})).rejects.toMatchObject({code:'result_unknown'});
  await f.service.retryReviews(c,{retryUnknown:true});expect(await f.memory.list()).toHaveLength(1);
  expect(f.connection.prepare("SELECT * FROM ai_runs WHERE role='companion_response'").all()).toHaveLength(1);
});
