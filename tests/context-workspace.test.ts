import {afterEach,expect,it,vi} from 'vitest';
import {portableTestDatabase} from './helpers/portable-db';
import {query as sql} from '@/lib/platform/sql';
import {createSentenceService} from '@/lib/sentence-study/core-service';
import {createSentencePreferences} from '@/lib/sentence-study/preferences';
import {publishSentenceMaterials} from '@/lib/sentence-study/materials';
import {sentencePracticeKey,type SentenceSession,type SentenceCard,type SentenceEvent} from '@/lib/sentence-study/contracts';
import {recallFixture} from './helpers/recall-material';
import {hash} from '@/lib/four-step/shared';
import type {MaterialRow,MaterialInput} from '@/lib/four-step/material-types';
import {gradeLightCard} from '@/lib/light-study/scheduler';
import {SentenceController,type SentenceClient} from '@/lib/sentence-study/client';

const open:ReturnType<typeof portableTestDatabase>[]=[];
afterEach(()=>{for(const f of open)f.close();open.length=0;vi.restoreAllMocks();});
async function fixture(){
  const f=portableTestDatabase();open.push(f);
  let sequence=0,now=new Date('2026-09-15T06:00:00Z');
  const clock={now:()=>now,newId:()=>`context-${++sequence}`,random:()=>0};
  const input:MaterialInput={sourceType:'ielts_practice',sourceId:'a',mode:'practice',actualAnswer:'I am used to live alone.',intendedMeaningZh:'我已经习惯一个人住了。',question:{id:'q',textEn:'Where do you live?',textZh:'你住哪里？',part:1},spokenStyleVersion:'personal-spoken-v2'};
  const analysis=recallFixture({key:'a',kind:'attempt',createdAt:clock.now().toISOString(),questionId:'q',questionEn:'Where do you live?',questionZh:'你住哪里？',part:1,english:input.actualAnswer,chinese:input.intendedMeaningZh,mode:'practice',index:0,hash:'source',spokenStyleVersion:'personal-spoken-v2',en:[{index:0,start:0,end:input.actualAnswer.length,text:input.actualAnswer}],zh:[{index:0,start:0,end:input.intendedMeaningZh.length,text:input.intendedMeaningZh}]}).analysis;
  await f.database.write(async tx=>{
    await tx.run(sql`INSERT INTO questions(id,book_id,part,text,text_zh,norm_text) VALUES('q','retired',1,'Where do you live?','你住哪里？','q')`);
    await tx.run(sql`INSERT INTO speaking_question_attempts(id,question_id,mode,answer_text,intended_meaning_zh,status) VALUES('a','q','practice',${input.actualAnswer},${input.intendedMeaningZh},'completed')`);
    await tx.run(sql`INSERT INTO practice_materials(id,source_type,source_id,question_id,input_json,input_hash,analysis_json,status,contract_version,created_at,updated_at) VALUES('m','ielts_practice','a','q',${JSON.stringify(input)},${hash(JSON.stringify(input))},${JSON.stringify(analysis)},'ready','evidence_v2',${clock.now().toISOString()},${clock.now().toISOString()})`);
    const [m]=await tx.all<MaterialRow>(sql`SELECT * FROM practice_materials WHERE id='m'`);await publishSentenceMaterials(tx,m,input,analysis,clock.now());
    const [row]=await tx.all<{body_json:string}>(sql`SELECT body_json FROM sentence_learning_units`),base=JSON.parse(row.body_json) as SentenceCard;
    // Nine synthetic units exercise complete-context selection without user material or Runtime.
    for(let ordinal=1;ordinal<9;ordinal++){
      const card={...base,id:`unit-${ordinal}`,sentenceId:`sentence-${ordinal}`,ordinal,version:`version-${ordinal}`,english:`Synthetic context sentence number ${ordinal}.`,chinese:`合成句子 ${ordinal}。`,usages:[],notes:[]};
      await tx.run(sql`INSERT INTO sentence_learning_units(id,material_id,sentence_id,source_type,source_id,question_id,ordinal,version,body_json,created_at,updated_at) VALUES(${card.id},'m',${card.sentenceId},'ielts_practice','a','q',${ordinal},${card.version},${JSON.stringify(card)},${clock.now().toISOString()},${clock.now().toISOString()})`);
    }
  });
  const service=createSentenceService(f.database,clock),preferences=createSentencePreferences(f.database,clock);
  const create=(request='create',mode:'learn'|'review'='learn')=>service.create({scope:{type:'question',id:'q'},mode,clientRequestId:request,experienceVersion:'context-workspace-v1'});
  const moveTime=(value:string)=>{now=new Date(value);};
  return {...f,clock,service,preferences,create,moveTime};
}
function unit(v:SentenceSession,type:string,clientEventId:string,index=v.index,extra:Record<string,unknown>={}){
  return {type,clientEventId,version:v.version,experienceVersion:v.experienceVersion,sentenceId:v.cards[index].id,unitVersion:v.cards[index].version,...extra};
}
function localStore(){
  const data=new Map<string,string>();
  return {data,getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>{data.set(key,value);},removeItem:(key:string)=>{data.delete(key);},get length(){return data.size;},key:(index:number)=>[...data.keys()][index]??null};
}
it('keeps nine ordered context cards when only five are new targets',async()=>{
  const f=await fixture();let legacy=await f.service.create({scope:{type:'question',id:'q'},mode:'learn',clientRequestId:'old'});
  for(let index=0;index<4;index++){legacy=await f.service.event(legacy.id,unit(legacy,'reveal',`old-reveal-${index}`));legacy=await f.service.event(legacy.id,unit(legacy,'rate',`old-rate-${index}`,legacy.index,{rating:'remembered'}));}
  const v=await f.create();expect(v.cards).toHaveLength(9);expect(v.cards.map(c=>c.ordinal)).toEqual([0,1,2,3,4,5,6,7,8]);expect(v.targetIds).toEqual(v.cards.slice(4).map(c=>c.id));expect(v.focusId).toBe(v.cards[0].id);
  expect(v.cards[0].source.questionEn).toBe('Where do you live?');
  expect((await f.service.overview()).newCount).toBe(5);
});
it('opening, focusing and typing do not create exposure or ratings; reveal sets a first review 24 hours later',async()=>{
  const f=await fixture(),fetch=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('Runtime forbidden'));let v=await f.create();
  await f.service.get(v.id);v=await f.service.event(v.id,unit(v,'focus','focus',7));
  v=await f.service.event(v.id,unit(v,'checkpoint','typing',7,{revealCount:0,maxRevealCount:0,draft:'My original attempt',retryDraft:''}));
  expect(await f.database.read(db=>db.all(sql`SELECT * FROM sentence_exposures`))).toHaveLength(0);
  v=await f.service.event(v.id,unit(v,'reveal','reveal'));
  const [exposure]=await f.database.read(db=>db.all<{first_exposed_at:string;first_review_due_at:string}>(sql`SELECT * FROM sentence_exposures`));
  expect(exposure).toMatchObject({first_exposed_at:'2026-09-15T06:00:00.000Z',first_review_due_at:'2026-09-16T06:00:00.000Z'});
  expect(await f.database.read(db=>db.all(sql`SELECT * FROM sentence_study_progress`))).toHaveLength(0);
  expect((await f.service.overview()).newCount).toBe(8);expect((await f.service.overview()).dueCount).toBe(0);
  f.moveTime('2026-09-16T06:00:00Z');expect((await f.service.overview()).dueCount).toBe(1);
  const review=await f.create('review','review');expect(review.cards).toHaveLength(9);expect(review.targetIds).toEqual([v.cards[7].id]);expect(fetch).not.toHaveBeenCalled();
});
it.each(['checkpoint','enter_teaching','exposure'])('%s records actual exposure without a fake Good result',async type=>{
  const f=await fixture();let v=await f.create();
  v=await f.service.event(v.id,unit(v,type,'touch',v.index,type==='checkpoint'?{revealCount:1,maxRevealCount:1,draft:'',retryDraft:''}:type==='exposure'?{source:'audio'}:{}));
  expect(await f.database.read(db=>db.all(sql`SELECT * FROM sentence_exposure_events`))).toHaveLength(1);expect(await f.database.read(db=>db.all(sql`SELECT * FROM sentence_study_progress`))).toHaveLength(0);
  expect(v.assessments).toEqual([]);
});
it('freely retries, advances and returns to version-bound drafts before any rating',async()=>{
  const f=await fixture();let v=await f.create();const first=v.cards[0];
  v=await f.service.event(v.id,unit(v,'checkpoint','draft',0,{revealCount:0,maxRevealCount:0,draft:'first sentence draft',retryDraft:''}));
  v=await f.service.event(v.id,unit(v,'start_retry','retry'));v=await f.service.event(v.id,unit(v,'checkpoint','retry-draft',0,{revealCount:0,maxRevealCount:0,draft:'first sentence draft',retryDraft:'another try'}));
  v=await f.service.event(v.id,unit(v,'advance','advance'));expect(v.index).toBe(1);
  v=await f.service.event(v.id,unit(v,'focus','back',0));expect(v.practice).toMatchObject({draft:'first sentence draft',retryDraft:'another try',retryAttempt:1});expect(v.stage).toBe('retry');
  expect(v.practiceByUnit?.[sentencePracticeKey(first)]?.draft).toBe('first sentence draft');
  v=await f.service.event(v.id,{type:'pause',clientEventId:'pause',version:v.version});v=await f.service.event(v.id,{type:'resume',clientEventId:'resume',version:v.version});expect(v.practice?.retryDraft).toBe('another try');
  expect(await f.database.read(db=>db.all(sql`SELECT * FROM sentence_study_progress`))).toHaveLength(0);
});
it('first real rating initializes FSRS, corrections reuse original time, and repeated practice does not settle twice',async()=>{
  const f=await fixture();let v=await f.create();v=await f.service.event(v.id,unit(v,'reveal','reveal'));
  f.moveTime('2026-09-15T08:00:00Z');const originalTime=f.clock.now();v=await f.service.event(v.id,unit(v,'rate','rate',0,{rating:'remembered'}));
  f.moveTime('2026-09-15T09:00:00Z');v=await f.service.event(v.id,{type:'revise_rating',experienceVersion:v.experienceVersion,clientEventId:'correction',version:v.version,targetEventId:'rate',rating:'forgot'});
  const before=await f.database.read(db=>db.all<{fsrs_json:string;review_count:number;first_seen_at:string;last_seen_at:string}>(sql`SELECT * FROM sentence_study_progress`));
  expect(JSON.parse(before[0].fsrs_json)).toEqual(JSON.parse(JSON.stringify(gradeLightCard(null,'forgot',originalTime))));expect(before[0]).toMatchObject({review_count:0,first_seen_at:'2026-09-15T06:00:00.000Z',last_seen_at:'2026-09-15T08:00:00.000Z'});
  v=await f.service.event(v.id,unit(v,'start_retry','retry'));v=await f.service.event(v.id,unit(v,'rate','practice-rating',0,{rating:'remembered'}));
  expect(await f.database.read(db=>db.all(sql`SELECT * FROM sentence_study_progress`))).toEqual(before);expect(v.assessments).toHaveLength(1);expect(v.lastRatingEventId).toBe('rate');
  const [evidence]=await f.database.read(db=>db.all<{scheduled:number}>(sql`SELECT scheduled FROM sentence_practice_evidence WHERE client_event_id='practice-rating'`));expect(evidence.scheduled).toBe(0);
});
it('idempotent receipts bind their exact payload and material version',async()=>{
  const f=await fixture();let v=await f.create();const reveal=unit(v,'reveal','same');v=await f.service.event(v.id,reveal);
  expect((await f.service.event(v.id,reveal)).version).toBe(v.version);
  await expect(f.service.event(v.id,{...reveal,type:'enter_teaching'})).rejects.toMatchObject({code:'event_conflict'});
  await expect(f.service.event(v.id,{...unit(v,'checkpoint','wrong'),unitVersion:'wrong-version',revealCount:0,maxRevealCount:0,draft:'do not apply',retryDraft:''})).rejects.toMatchObject({code:'material_changed'});
  expect(await f.database.read(db=>db.all(sql`SELECT * FROM sentence_exposure_events`))).toHaveLength(1);
});
it('cross-window recovery keeps context while removing already-settled targets',async()=>{
  const f=await fixture();let a=await f.create('a'),b=await f.create('b');a=await f.service.event(a.id,unit(a,'rate','a-rate',0,{rating:'remembered'}));
  await expect(f.service.event(b.id,unit(b,'rate','b-rate',0,{rating:'forgot'}))).rejects.toMatchObject({code:'progress_conflict'});
  b=await f.service.get(b.id);expect(b.status).toBe('paused');b=await f.service.event(b.id,{type:'resume',version:b.version,clientEventId:'recover'});
  expect(b.cards).toHaveLength(9);expect(b.targetIds).not.toContain(a.cards[0].id);
  b=await f.service.event(b.id,unit(b,'rate','context-rate',0,{rating:'forgot'}));expect(b.assessments).toHaveLength(0);
  expect(await f.database.read(db=>db.all(sql`SELECT * FROM sentence_study_progress`))).toHaveLength(1);
});
it('hidden and self-known preferences stop targets without removing full context or writing grades',async()=>{
  const f=await fixture(),initial=await f.create();const card=initial.cards[0];
  const request={clientRequestId:'hide',sentenceId:card.id,unitVersion:card.version,version:0,hidden:true,favorite:true,note:'Keep this context.'};
  const saved=await f.preferences.set(request);expect((await f.preferences.set(request)).preference).toEqual(saved.preference);
  await expect(f.preferences.set({...request,clientRequestId:'stale',hidden:false})).rejects.toMatchObject({code:'version_conflict'});
  let v=await f.create('hidden');expect(v.cards).toHaveLength(9);expect(v.targetIds).toHaveLength(8);expect(v.cards[0].preference).toMatchObject({hidden:true,favorite:true,note:'Keep this context.'});
  v=await f.service.event(v.id,unit(v,'rate','hidden-rate',0,{rating:'remembered'}));expect(v.assessments).toEqual([]);expect(await f.database.read(db=>db.all(sql`SELECT * FROM sentence_study_progress`))).toHaveLength(0);
  await f.preferences.set({clientRequestId:'unhide',sentenceId:card.id,unitVersion:card.version,version:1,hidden:false,selfKnown:true});expect((await f.service.overview()).newCount).toBe(8);
  await f.preferences.set({clientRequestId:'restore',sentenceId:card.id,unitVersion:card.version,version:2,selfKnown:false});expect((await f.service.overview()).newCount).toBe(9);
});
it('incorrect feedback quarantines the cited version and withdrawal preserves its audit trail',async()=>{
  const f=await fixture(),v=await f.create(),card=v.cards[0];
  const feedback=await f.preferences.feedback({action:'report',clientRequestId:'report',sentenceId:card.id,unitVersion:card.version,kind:'incorrect',reason:'Synthetic correction concern'});
  expect((await f.service.get(v.id)).cards[0].english).toBe('');await expect(f.service.event(v.id,unit(v,'reveal','unsafe'))).rejects.toMatchObject({code:'material_changed'});
  await f.preferences.feedback({action:'withdraw',clientRequestId:'withdraw',feedbackId:feedback.feedback.id});expect((await f.service.get(v.id)).cards[0].english).toBe(card.english);
  const list=await f.preferences.list({type:'collection',id:'ielts'});expect(list.feedback[0].status).toBe('withdrawn');expect(await f.database.read(db=>db.all(sql`SELECT * FROM sentence_feedback_events`))).toHaveLength(2);
});
it('reconciles a legacy lost response before upgrading to the full context protocol',async()=>{
  const f=await fixture();let legacy=await f.service.create({scope:{type:'question',id:'q'},mode:'learn',clientRequestId:'legacy',experienceVersion:'guided-reveal-v1'});
  const old=unit(legacy,'reveal','old-reveal') as SentenceEvent;legacy=await f.service.event(legacy.id,old);
  const storage=localStore();storage.setItem(`sentence_session:${legacy.id}`,JSON.stringify({view:legacy,queue:[old]}));storage.setItem(`sentence_event:${legacy.id}:old-reveal`,JSON.stringify(old));
  const client:SentenceClient={create:f.service.create,get:f.service.get,event:f.service.event,overview:f.service.overview};const controller=new SentenceController(client,storage,{context:true,writerId:'window'});
  await controller.load(legacy.id);await vi.waitFor(()=>expect(controller.getSnapshot().pending).toBe(0));expect(controller.getSnapshot().view?.experienceVersion).toBe('context-workspace-v1');expect(controller.getSnapshot().view?.cards).toHaveLength(9);
  const receipt=await f.service.event(legacy.id,old);expect(receipt.experienceVersion).toBe('context-workspace-v1');
  await expect(f.service.event(legacy.id,{...unit(receipt,'rate','old-client-rate',0,{rating:'remembered'}),experienceVersion:'guided-reveal-v1'})).rejects.toMatchObject({code:'client_update_required'});
  expect(await f.database.read(db=>db.all(sql`SELECT * FROM sentence_exposure_events`))).toHaveLength(0);controller.dispose();
});
it('saves an old guided draft before changing its protocol or version',async()=>{
  const f=await fixture(),legacy=await f.service.create({scope:{type:'question',id:'q'},mode:'learn',clientRequestId:'legacy-draft',experienceVersion:'guided-reveal-v1'}),storage=localStore(),card=legacy.cards[0];
  storage.setItem(`sentence_practice:${legacy.id}:window`,JSON.stringify({sessionId:legacy.id,sentenceId:card.id,unitVersion:card.version,version:legacy.version,stage:'recall',practice:{...legacy.practice,draft:'Retain my original sentence.'},clientEventId:'draft-before-upgrade',owner:'window'}));
  const client:SentenceClient={create:f.service.create,get:f.service.get,event:f.service.event,overview:f.service.overview},controller=new SentenceController(client,storage,{context:true,writerId:'window'});
  await controller.load(legacy.id);await vi.waitFor(()=>expect(controller.getSnapshot().view?.experienceVersion).toBe('context-workspace-v1'));await vi.waitFor(()=>expect(controller.getSnapshot().pending).toBe(0));
  const live=await f.service.get(legacy.id);expect(live.practiceByUnit?.[sentencePracticeKey(card)]?.draft).toBe('Retain my original sentence.');expect(controller.getSnapshot().conflict).toBe(false);
  const rows=await f.database.read(db=>db.all<{kind:string}>(sql`SELECT kind FROM sentence_study_events WHERE session_id=${legacy.id} ORDER BY rowid`));expect(rows.map(r=>r.kind)).toEqual(['checkpoint','upgrade_experience']);controller.dispose();
});
it('archives a rejected old event when another window already upgraded, without assigning it new semantics',async()=>{
  const f=await fixture(),legacy=await f.service.create({scope:{type:'question',id:'q'},mode:'learn',clientRequestId:'legacy-window',experienceVersion:'guided-reveal-v1'}),storage=localStore();
  const old=unit(legacy,'checkpoint','old-draft',0,{revealCount:1,maxRevealCount:1,draft:'Old offline draft',retryDraft:''}) as SentenceEvent;
  storage.setItem(`sentence_session:${legacy.id}`,JSON.stringify({view:legacy,queue:[old]}));storage.setItem(`sentence_event:${legacy.id}:old-draft`,JSON.stringify(old));
  await f.service.event(legacy.id,{type:'upgrade_experience',experienceVersion:'context-workspace-v1',clientEventId:'other-window-upgrade',version:legacy.version});
  const client:SentenceClient={create:f.service.create,get:f.service.get,event:f.service.event,overview:f.service.overview},controller=new SentenceController(client,storage,{context:true,writerId:'window'});
  await controller.load(legacy.id);expect(controller.getSnapshot().conflict).toBe(true);await controller.retry();
  expect(controller.getSnapshot().conflict).toBe(false);expect(controller.getSnapshot().pending).toBe(0);expect([...storage.data.keys()].some(key=>key.startsWith('sentence_conflict:'))).toBe(true);
  expect(await f.database.read(db=>db.all(sql`SELECT * FROM sentence_exposure_events`))).toHaveLength(0);
  expect((await f.service.get(legacy.id)).practice?.draft).toBe('');controller.dispose();
});
it('controller focus flushes and restores each sentence draft while retaining every context card',async()=>{
  const f=await fixture(),v=await f.create(),storage=localStore(),client:SentenceClient={create:f.service.create,get:f.service.get,event:f.service.event,overview:f.service.overview},controller=new SentenceController(client,storage,{context:true,writerId:'window'});
  await controller.load(v.id);controller.updatePractice({draft:'Sentence one draft'});await controller.apply({type:'focus',sentenceId:v.cards[5].id});controller.updatePractice({draft:'Sentence six draft'});await controller.apply({type:'focus',sentenceId:v.cards[0].id});
  await vi.waitFor(()=>expect(controller.getSnapshot().pending).toBe(0));expect(controller.getSnapshot().view?.practice?.draft).toBe('Sentence one draft');
  const saved=await f.service.get(v.id);expect(saved.cards).toHaveLength(9);expect(saved.practiceByUnit?.[sentencePracticeKey(v.cards[5])]?.draft).toBe('Sentence six draft');
  expect(await f.database.read(db=>db.all(sql`SELECT * FROM sentence_exposures`))).toHaveLength(0);controller.dispose();
});
