import {afterEach,expect,it,vi} from 'vitest';
import {portableTestDatabase} from './helpers/portable-db';
import {query as sql} from '@/lib/platform/sql';
import {createSentenceService} from '@/lib/sentence-study/core-service';
import {publishSentenceMaterials,projectSentenceMaterials} from '@/lib/sentence-study/materials';
import {recallFixture} from './helpers/recall-material';
import {hash} from '@/lib/four-step/shared';
import type {MaterialRow,MaterialInput} from '@/lib/four-step/material-types';
import type {SentenceSession} from '@/lib/sentence-study/contracts';
import {gradeLightCard} from '@/lib/light-study/scheduler';
const open:ReturnType<typeof portableTestDatabase>[]=[];
afterEach(()=>{for(const f of open)f.close();open.length=0;vi.restoreAllMocks();});
async function fixture(){
  const f=portableTestDatabase();open.push(f);let sequence=0;const clock={now:()=>new Date('2026-09-10T06:00:00Z'),newId:()=>`test-${++sequence}`,random:()=>0};
  const input:MaterialInput={sourceType:'ielts_practice',sourceId:'a',mode:'practice',actualAnswer:'I am used to live alone.',intendedMeaningZh:'我已经习惯一个人住了。',question:{id:'q',textEn:'Where do you live?',textZh:'你住哪里？',part:1},spokenStyleVersion:'personal-spoken-v2'};
  const analysis=recallFixture({key:'a',kind:'attempt',createdAt:clock.now().toISOString(),questionId:'q',questionEn:'Where do you live?',questionZh:'你住哪里？',part:1,english:input.actualAnswer,chinese:input.intendedMeaningZh,mode:'practice',index:0,hash:'source',spokenStyleVersion:'personal-spoken-v2',en:[{index:0,start:0,end:input.actualAnswer.length,text:input.actualAnswer}],zh:[{index:0,start:0,end:input.intendedMeaningZh.length,text:input.intendedMeaningZh}]}).analysis;
  await f.database.write(async tx=>{
    await tx.run(sql`INSERT INTO questions(id,book_id,part,text,text_zh,norm_text) VALUES('q','retired',1,'Where do you live?','你住哪里？','q')`);
    await tx.run(sql`INSERT INTO speaking_question_attempts(id,question_id,mode,answer_text,intended_meaning_zh,status) VALUES('a','q','practice',${input.actualAnswer},${input.intendedMeaningZh},'completed')`);
    await tx.run(sql`INSERT INTO practice_materials(id,source_type,source_id,question_id,input_json,input_hash,analysis_json,status,contract_version,created_at,updated_at) VALUES('m','ielts_practice','a','q',${JSON.stringify(input)},${hash(JSON.stringify(input))},${JSON.stringify(analysis)},'ready','evidence_v2',${clock.now().toISOString()},${clock.now().toISOString()})`);
    const [m]=await tx.all<MaterialRow>(sql`SELECT * FROM practice_materials WHERE id='m'`);await publishSentenceMaterials(tx,m,input,analysis,clock.now());
  });
  const service=createSentenceService(f.database,clock);return {...f,clock,input,analysis,service};
}
const event=(v:SentenceSession,type:'rate'|'reveal',id:string,rating='remembered')=>({type,version:v.version,clientEventId:id,sentenceId:v.cards[v.index].id,unitVersion:v.cards[v.index].version,...(v.experienceVersion?{experienceVersion:v.experienceVersion}:{}),...(type==='rate'?{rating}:{})});
it('projects one full reviewed sentence, not one copy per gap, and marks Chinese provenance',async()=>{const f=await fixture();const cards=projectSentenceMaterials('m',f.input,f.analysis);expect(cards).toHaveLength(1);expect(cards[0]).toMatchObject({chinese:f.input.intendedMeaningZh,english:'I am used to living alone.',meaningOrigin:'user_chinese'});expect(cards[0].usages[0]).toMatchObject({text:'used to living'});});
it('a server-resolved edit lineage keeps unchanged sentence identity but updates its display version',async()=>{
  const f=await fixture(),original=projectSentenceMaterials('m',f.input,f.analysis)[0];
  const edited=projectSentenceMaterials('m-edit',{...f.input,sourceId:'new-attempt',sentenceSourceId:f.input.sourceId},f.analysis)[0];
  expect(edited.id).toBe(original.id);expect(edited.version).not.toBe(original.version);expect(edited.source.id).toBe('new-attempt');
  const another=projectSentenceMaterials('other',{...f.input,sourceId:'independent-attempt'},f.analysis)[0];expect(another.id).not.toBe(original.id);
});
it('never overwrites an independently revised sentence edition with the older projection',async()=>{
  const f=await fixture();
  await f.database.write(tx=>tx.run(sql`INSERT INTO sentence_material_editions(id,material_id,source_hash,analysis_hash,author_json,review_json,cards_json,created_at) VALUES('edition','m','source','analysis','{}','{}','[]',${f.clock.now().toISOString()})`));
  const before=await f.database.read(tx=>tx.all(sql`SELECT * FROM sentence_learning_units`));
  await expect(f.database.write(async tx=>{const [m]=await tx.all<MaterialRow>(sql`SELECT * FROM practice_materials WHERE id='m'`);return publishSentenceMaterials(tx,m,f.input,f.analysis,f.clock.now());})).rejects.toThrow('不能用旧投影覆盖');
  expect(await f.database.read(tx=>tx.all(sql`SELECT * FROM sentence_learning_units`))).toEqual(before);
});
it('requires reveal, schedules a first self-rating, and leaves old progress untouched',async()=>{
  const f=await fixture(),fetch=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('no runtime'));let v=await f.service.create({scope:{type:'question',id:'q'},mode:'learn',clientRequestId:'create-one'});
  await expect(f.service.event(v.id,event(v,'rate','early'))).rejects.toMatchObject({code:'reveal_required'});
  expect(await f.database.read(tx=>tx.all(sql`SELECT * FROM sentence_study_progress`))).toHaveLength(0);
  v=await f.service.event(v.id,event(v,'reveal','reveal'));const rate=event(v,'rate','rating');v=await f.service.event(v.id,rate);
  expect(v.status).toBe('completed');expect(v.nextDueAt).toBeTruthy();expect((await f.service.event(v.id,rate)).version).toBe(v.version);
  expect(await f.database.read(tx=>tx.all(sql`SELECT * FROM light_study_progress`))).toHaveLength(0);expect(fetch).not.toHaveBeenCalled();
});
it('corrects the latest rating from its original before-state without increasing review counts',async()=>{
  const f=await fixture();let v=await f.service.create({scope:{type:'question',id:'q'},mode:'learn',clientRequestId:'create-undo'});v=await f.service.event(v.id,event(v,'reveal','reveal'));v=await f.service.event(v.id,event(v,'rate','rating'));
  const corrected=await f.service.event(v.id,{type:'revise_rating',version:v.version,clientEventId:'fix',targetEventId:'rating',rating:'forgot'});
  const [p]=await f.database.read(tx=>tx.all<{fsrs_json:string;review_count:number}>(sql`SELECT * FROM sentence_study_progress`));
  expect(JSON.parse(p.fsrs_json)).toEqual(JSON.parse(JSON.stringify(gradeLightCard(null,'forgot',f.clock.now()))));expect(p.review_count).toBe(0);expect(corrected.assessments).toHaveLength(1);expect(corrected.assessments[0].rating).toBe('forgot');
});
it('uses new request ids for new work, restores exact ids, and never revives withdrawn material',async()=>{
  const f=await fixture(),input={scope:{type:'question',id:'q'},mode:'learn',clientRequestId:'receipt'};const v=await f.service.create(input);expect((await f.service.create(input)).id).toBe(v.id);
  expect((await f.service.overview()).resumable.learn?.id).toBe(v.id);
  await f.database.write(tx=>tx.run(sql`UPDATE practice_materials SET status='hidden' WHERE id='m'`));
  expect((await f.service.overview()).totalCount).toBe(0);expect((await f.service.get(v.id)).cards[0].english).toBe('');
  await expect(f.service.event(v.id,event(v,'reveal','after-withdraw'))).rejects.toMatchObject({code:'material_changed'});
});
it('resume and duplicate receipts cannot reveal withdrawn content, including completed summaries',async()=>{
  const f=await fixture();let v=await f.service.create({scope:{type:'question',id:'q'},mode:'learn',clientRequestId:'withdrawn'});
  const reveal=event(v,'reveal','reveal');v=await f.service.event(v.id,reveal);
  await f.database.write(tx=>tx.run(sql`UPDATE practice_materials SET status='hidden' WHERE id='m'`));
  const repeated=await f.service.event(v.id,reveal);expect(repeated.cards[0].english).toBe('');expect(repeated.status).toBe('paused');
  const resumed=await f.service.event(v.id,{type:'resume',version:v.version,clientEventId:'resume'});expect(resumed.cards).toHaveLength(0);expect(resumed.status).toBe('completed');
});
it('a second session skips a sentence graded elsewhere after explicit recovery',async()=>{
  const f=await fixture();let a=await f.service.create({scope:{type:'question',id:'q'},mode:'learn',clientRequestId:'a'}),b=await f.service.create({scope:{type:'question',id:'q'},mode:'learn',clientRequestId:'b'});
  a=await f.service.event(a.id,event(a,'reveal','ar'));b=await f.service.event(b.id,event(b,'reveal','br'));await f.service.event(a.id,event(a,'rate','ag'));
  await expect(f.service.event(b.id,event(b,'rate','bg'))).rejects.toMatchObject({code:'progress_conflict'});
  const latest=await f.service.get(b.id);expect(latest.status).toBe('paused');
  const recovered=await f.service.event(b.id,{type:'resume',version:latest.version,clientEventId:'resume'});expect(recovered.status).toBe('completed');expect(recovered.assessments).toHaveLength(0);
  expect(await f.database.read(tx=>tx.all(sql`SELECT * FROM sentence_study_events WHERE kind='rate'`))).toHaveLength(1);
});

it.each(['remembered','uncertain','forgot'])('guided %s saves once and resumes the rated last sentence until explicit completion',async rating=>{
  const f=await fixture();let v=await f.service.create({scope:{type:'question',id:'q'},mode:'learn',clientRequestId:`guided-${rating}`,experienceVersion:'guided-reveal-v1'});
  const unit=()=>({sentenceId:v.cards[v.index].id,unitVersion:v.cards[v.index].version,version:v.version,experienceVersion:v.experienceVersion});
  v=await f.service.event(v.id,{type:'checkpoint',...unit(),clientEventId:'draft',revealCount:2,maxRevealCount:2,draft:'I am',retryDraft:''});
  expect(await f.database.read(tx=>tx.all(sql`SELECT * FROM sentence_study_progress`))).toHaveLength(0);
  v=await f.service.event(v.id,{type:'enter_teaching',...unit(),clientEventId:'teach'});
  const grade={type:'rate',...unit(),clientEventId:'grade',rating};v=await f.service.event(v.id,grade);
  expect(v).toMatchObject({status:'active',index:0,stage:'rated'});expect((await f.service.overview()).resumable.learn?.id).toBe(v.id);
  const before=await f.database.read(tx=>tx.all(sql`SELECT * FROM sentence_study_progress`));await f.service.event(v.id,grade);
  v=await f.service.event(v.id,{type:'start_retry',...unit(),clientEventId:'retry'});v=await f.service.event(v.id,{type:'pause',version:v.version,clientEventId:'pause'});
  v=await f.service.event(v.id,{type:'resume',version:v.version,clientEventId:'resume'});expect(v.stage).toBe('retry');expect(v.revealed).toBe(false);
  v=await f.service.event(v.id,{type:'reveal_retry',...unit(),clientEventId:'compare'});
  expect(await f.database.read(tx=>tx.all(sql`SELECT * FROM sentence_study_progress`))).toEqual(before);
  v=await f.service.event(v.id,{type:'advance',...unit(),clientEventId:'finish'});expect(v.status).toBe('completed');expect(v.assessments).toHaveLength(1);
});
it('guided rating correction retains the active sentence and recomputes from original before state',async()=>{
  const f=await fixture();let v=await f.service.create({scope:{type:'question',id:'q'},mode:'learn',clientRequestId:'guided-revision',experienceVersion:'guided-reveal-v1'});
  v=await f.service.event(v.id,event(v,'reveal','show'));v=await f.service.event(v.id,event(v,'rate','rated'));
  v=await f.service.event(v.id,{type:'revise_rating',version:v.version,clientEventId:'fix',targetEventId:'rated',rating:'forgot'});
  expect(v).toMatchObject({status:'active',stage:'rated',index:0});expect(v.cards[0].unavailable).toBeUndefined();
  const [p]=await f.database.read(tx=>tx.all<{fsrs_json:string;review_count:number;version:number}>(sql`SELECT * FROM sentence_study_progress`));
  expect(JSON.parse(p.fsrs_json)).toEqual(JSON.parse(JSON.stringify(gradeLightCard(null,'forgot',f.clock.now()))));expect(p.review_count).toBe(0);expect(v.cards[0].progressVersion).toBe(p.version);
});
