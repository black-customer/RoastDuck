import {afterEach,expect,it,vi} from 'vitest';
import fs from 'node:fs';
import {portableTestDatabase} from './helpers/portable-db';
import {MockAiProvider} from '@/lib/ai/mock-provider';
import {selectionMockResolver} from '@/lib/four-step/selection-mock';
import {createRuntimeCalls} from '@/lib/ai/runtime-ledger';
import {createMaterialService} from '@/lib/four-step/core-materials';
import {createExpressionService} from '@/lib/app-services/expressions';
import {createLightService} from '@/lib/light-study/core-service';
import type {LightView} from '@/lib/light-study/contracts';

const opened:Array<ReturnType<typeof portableTestDatabase>>=[];
afterEach(()=>{vi.restoreAllMocks();for(const fixture of opened.splice(0))fixture.close();});
const clock=new Date('2026-09-08T08:00:00Z');
async function setup(){
  const fixture=portableTestDatabase();opened.push(fixture);let seq=0;
  const platform={now:()=>clock,newId:()=>`collection-${++seq}`,bootId:'collections',allowMock:true};
  const runtime=createRuntimeCalls(fixture.database,new MockAiProvider(selectionMockResolver),platform);
  const materials=createMaterialService({...platform,database:fixture.database,runtime,loadPrompt:name=>fs.readFileSync(`pipeline/prompts/${name}`,'utf8')});
  const english="I'm used to live alone.",chinese='我已经习惯一个人住了。';
  fixture.connection.exec("INSERT INTO questions(id,book_id,part,text,text_zh,norm_text) VALUES('q','retired',1,'Do you live alone?','你一个人住吗？','q')");
  fixture.connection.prepare("INSERT INTO speaking_question_attempts(id,question_id,mode,answer_text,intended_meaning_zh,status) VALUES('attempt','q','practice',?,?,'processing')").run(english,chinese);
  fixture.connection.exec("INSERT INTO free_talk_conversations(id,title) VALUES('chat','生活聊天')");
  fixture.connection.prepare("INSERT INTO free_talk_messages(id,conversation_id,sequence_no,role,text) VALUES('message','chat',1,'user',?)").run(english);
  const ielts=await materials.prepare({sourceType:'ielts_practice',sourceId:'attempt',question:{id:'q',part:1,textEn:'Do you live alone?',textZh:'你一个人住吗？'},mode:'practice',actualAnswer:english,intendedMeaningZh:chinese});
  const talk=await materials.prepare({sourceType:'free_talk',sourceId:'chat',question:null,mode:'relaxed',actualAnswer:english,intendedMeaningZh:chinese,sourceMessages:[{id:'message',role:'user',text:english}]});
  for(const material of [ielts,talk]){expect((await materials.process(material.id)).status).toBe('ready');expect((await materials.inspect(material.id)).verified).toBe(true);}
  return {...fixture,ielts,talk,materials,expressions:createExpressionService(fixture.database,true),light:createLightService(fixture.database,{...platform,enabled:()=>true})};
}
async function rate(light:ReturnType<typeof createLightService>,view:LightView,now=clock){
  view=await light.applyLightEvent(view.id,{type:'reveal',version:view.version,clientEventId:`show-${view.version}`},now);
  return light.applyLightEvent(view.id,{type:'rate',rating:'remembered',version:view.version,clientEventId:`rate-${view.version}`},now);
}
it('two current source collections share one stable item, preserve both sources, and never write during reads',async()=>{
  const f=await setup(),network=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('No network'));
  const [ielts]=await f.expressions.list('',{type:'collection',id:'ielts'}),[talk]=await f.expressions.list('',{type:'collection',id:'free_talk'});
  expect(ielts.itemId).toBe(talk.itemId);expect(ielts.sourceType).toBe('ielts_practice');expect(talk.sourceType).toBe('free_talk');
  expect((await f.expressions.list())[0].sources.map(source=>source.sourceType).sort()).toEqual(['free_talk','ielts_practice']);
  expect(await f.expressions.summary()).toEqual({total:1,eligibleTotal:1,studied:0,eligibleStudied:0,selfKnownUnstudied:0,eligibleSelfKnownUnstudied:0,new:1,due:0,hidden:0});
  expect(f.connection.prepare('SELECT * FROM light_study_events').all()).toEqual([]);expect(network).not.toHaveBeenCalled();
  const view=await f.light.createLightSession({scope:{type:'collection',id:'ielts'},mode:'learn',clientRequestId:'start'});
  await rate(f.light,view);
  const updated=(await f.expressions.list('',{type:'collection',id:'free_talk'}))[0];
  expect(updated.progress).toMatchObject({review_count:0,last_rating:'remembered',scheduler_version:'light-fsrs-days-v1'});
  expect((await f.light.lightOverview({type:'collection',id:'free_talk'})).newCount).toBe(0);
});
it('self-known stops new and already-snapshotted pushes, remains searchable, and does not create study credit',async()=>{
  const f=await setup(),scope={type:'collection' as const,id:'ielts' as const};
  let view=await f.light.createLightSession({scope,mode:'learn',clientRequestId:'queued'});
  const card=view.card!,input={itemId:card.itemId,materialId:card.materialId,version:0,selfKnown:true};
  const preference=await f.expressions.update(input);expect(preference).toMatchObject({self_known:1,hidden:0});
  expect(await f.expressions.update(input)).toEqual(preference);
  expect(await f.light.lightOverview(scope)).toMatchObject({newCount:0,dueCount:0,resumable:{}});
  await expect(f.light.createLightSession({scope,mode:'learn',clientRequestId:'nothing-new'})).rejects.toMatchObject({code:'nothing_available'});
  expect((await f.light.getLightView(view.id)).card).toBeNull();
  view=await f.light.applyLightEvent(view.id,{type:'advance',version:view.version,clientEventId:'skip'});
  expect(view.status).toBe('completed');expect(view.summary).toEqual([]);
  expect((await f.expressions.list('be used to'))[0].preference.self_known).toBe(1);
  expect(await f.expressions.summary()).toMatchObject({studied:0,selfKnownUnstudied:1,new:0});
  expect(f.connection.prepare('SELECT * FROM light_study_progress').all()).toEqual([]);
  expect(f.connection.prepare('SELECT * FROM question_mastery').all()).toEqual([]);
  await expect(f.expressions.update({...input,selfKnown:false})).rejects.toMatchObject({code:'preference_conflict'});
  await f.expressions.update({...input,version:preference.version,selfKnown:false});
  expect((await f.light.lightOverview(scope)).newCount).toBe(1);
});
it('stopping and restoring a learned item preserves its old due/FSRS/history and exposes due again',async()=>{
  const f=await setup(),scope={type:'collection' as const,id:'free_talk' as const};
  const initial=await f.light.createLightSession({scope,mode:'learn',clientRequestId:'learn'});await rate(f.light,initial);
  const card=(await f.expressions.list())[0],due=new Date(Date.parse(card.progress!.due_at)+1);
  const before=f.connection.prepare('SELECT * FROM light_study_progress').get();
  let preference=await f.expressions.update({itemId:card.itemId,materialId:card.materialId,version:0,selfKnown:true});
  expect((await f.expressions.summary(scope,due))).toMatchObject({studied:1,selfKnownUnstudied:0,new:0,due:0});
  expect((await f.light.lightOverview(scope,due)).dueCount).toBe(0);
  preference=await f.expressions.update({itemId:card.itemId,materialId:card.materialId,version:preference.version,selfKnown:false,hidden:true});
  expect((await f.expressions.summary(scope,due))).toMatchObject({total:1,eligibleTotal:0,studied:1,eligibleStudied:0,hidden:1,due:0});
  await f.expressions.update({itemId:card.itemId,materialId:card.materialId,version:preference.version,hidden:false});
  expect(f.connection.prepare('SELECT * FROM light_study_progress').get()).toEqual(before);
  expect((await f.light.lightOverview(scope,due)).dueCount).toBe(1);
  await rate(f.light,await f.light.createLightSession({scope,mode:'review',clientRequestId:'review'},due),due);
  expect(f.connection.prepare('SELECT review_count FROM light_study_progress').get()).toMatchObject({review_count:1});
});
it('IELTS source filters select the matching question before shared-item deduplication, with real topics and multi-season links',async()=>{
  const f=await setup();
  f.connection.exec("INSERT INTO topics(id,book_id,name_zh,name_en) VALUES('topic-a','retired','居住','Home'),('topic-b','retired','习惯','Habits')");
  f.connection.exec("UPDATE questions SET topic_id='topic-a' WHERE id='q'");
  f.connection.exec("INSERT INTO questions(id,book_id,topic_id,part,text,text_zh,norm_text) VALUES('q-other','retired','topic-b',1,'What habits do you have?','你有什么习惯？','q-other')");
  f.connection.exec("INSERT INTO question_sets(id,name_zh,year,start_month,end_month) VALUES('season-a','2026年1—4月',2026,1,4),('season-b','2026年5—8月',2026,5,8)");
  f.connection.exec("INSERT INTO question_set_links(question_id,question_set_id,source_slug,source_file,source_page) VALUES('q','season-a','fixture','fixture.pdf',1),('q','season-b','fixture','fixture.pdf',1)");
  const english="I'm used to live alone.",chinese='我已经习惯一个人住了。';
  f.connection.prepare("INSERT INTO speaking_question_attempts(id,question_id,mode,answer_text,intended_meaning_zh,status) VALUES('other-attempt','q-other','practice',?,?,'processing')").run(english,chinese);
  const material=await f.materials.prepare({sourceType:'ielts_practice',sourceId:'other-attempt',question:{id:'q-other',part:1,textEn:'What habits do you have?',textZh:'你有什么习惯？'},mode:'practice',actualAnswer:english,intendedMeaningZh:chinese});
  expect((await f.materials.process(material.id)).status).toBe('ready');
  f.connection.prepare("UPDATE practice_materials SET created_at='2026-09-09T08:00:00Z' WHERE id=?").run(material.id);
  const [all]=await f.expressions.list('',{type:'collection',id:'ielts'});
  expect(all.materialId).toBe(material.id);expect(all.sources).toHaveLength(2);
  const [fromA]=await f.expressions.list('',{type:'collection',id:'ielts',topicId:'topic-a',seasonId:'season-b'});
  expect(fromA.itemId).toBe(all.itemId);expect(fromA.materialId).toBe(f.ielts.id);expect(fromA.sources).toHaveLength(1);
  expect(fromA.sources[0]).toMatchObject({questionId:'q',questionTitle:'你一个人住吗？',topicId:'topic-a',topicTitle:'居住',seasons:[{id:'season-a',title:'2026年1—4月'},{id:'season-b',title:'2026年5—8月'}]});
  expect(await f.expressions.list('',{type:'collection',id:'ielts',topicId:'topic-b',seasonId:'season-a'})).toEqual([]);
  const [unmarked]=await f.expressions.list('',{type:'collection',id:'ielts',seasonId:'unmarked'});
  expect(unmarked.materialId).toBe(material.id);expect(unmarked.sources[0].seasons).toEqual([]);
  expect((await f.light.lightOverview({type:'collection',id:'ielts',questionId:'q-other'})).newCount).toBe(1);
  const view=await f.light.createLightSession({scope:{type:'collection',id:'ielts',questionId:'q'},mode:'learn',clientRequestId:'source-filter'});
  expect(view.card?.materialId).toBe(f.ielts.id);
});
