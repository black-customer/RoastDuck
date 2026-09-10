import {afterEach,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {sql} from 'drizzle-orm';
import {prepareTestDatabase} from '../helpers/temp-db';
import {currentMaterialFixture} from '../helpers/light-current-material';
import type {LightScope,LightView} from '@/lib/light-study/contracts';

const temporary=prepareTestDatabase('light-current-material');
process.env.ROASTDUCK_DB=temporary.url;process.env.ROASTDUCK_SKIP_DB_BACKUP='1';process.env.AI_PROVIDER='mock';
let db:Awaited<ReturnType<typeof import('@db/client').getDbReady>>;
let catalogue:typeof import('@/lib/light-study/catalogue');
let light:typeof import('@/lib/light-study/service');
let activity:typeof import('@/lib/questions/activity');
const now=new Date('2026-08-01T08:00:00.000Z');
beforeAll(async()=>{
  db=await(await import('@db/client')).getDbReady();
  catalogue=await import('@/lib/light-study/catalogue');light=await import('@/lib/light-study/service');activity=await import('@/lib/questions/activity');
});
beforeEach(()=>{vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('No network in current-material regression'));});
afterEach(()=>{expect(globalThis.fetch).not.toHaveBeenCalled();vi.restoreAllMocks();});

async function stamp(materialId:string,createdAt:string,updatedAt=createdAt){
  await db.run(sql`UPDATE practice_materials SET created_at=${createdAt},updated_at=${updatedAt} WHERE id=${materialId}`);
}
async function sourceCards(scope:LightScope,sourceId:string){
  return (await catalogue.readLightCatalogue(scope)).cards.filter(card=>card.sources?.some(source=>source.sourceId===sourceId));
}
async function rate(view:LightView,eventId:string,clock=now){
  view=await light.applyLightEvent(view.id,{type:'reveal',version:view.version,clientEventId:`${eventId}-reveal`},clock);
  return light.applyLightEvent(view.id,{type:'rate',rating:'remembered',version:view.version,clientEventId:`${eventId}-rate`},clock);
}

it('all, question, collection, and explicit material scopes project only the newest ready version by created_at',async()=>{
  const fixture=await currentMaterialFixture(db,'newest-ready',[['brush my teeth','刷牙'],['wash my hands','洗手']]);
  const old=await fixture.publish('old'),current=await fixture.publish('new');
  await stamp(old.materialId,'2026-08-01T00:00:00.000Z','2026-09-01T00:00:00.000Z');
  await stamp(current.materialId,'2026-08-02T00:00:00.000Z');
  expect(old.itemIds).toHaveLength(1);expect(current.itemIds).toHaveLength(2);
  expect(current.itemIds).not.toContain(old.itemIds[0]);
  const scopes:LightScope[]=[{type:'all'},{type:'question',id:fixture.questionId},{type:'collection',id:'ielts'},{type:'material',id:current.materialId}];
  for(const scope of scopes){
    const cards=await sourceCards(scope,fixture.sourceId);
    expect(cards).toHaveLength(2);
    expect(cards.every(card=>card.materialId===current.materialId&&card.sources?.every(source=>source.materialId!==old.materialId))).toBe(true);
  }
  expect(await sourceCards({type:'material',id:old.materialId},fixture.sourceId)).toEqual([]);
  await expect(light.createLightSession({scope:{type:'material',id:old.materialId},mode:'learn',clientRequestId:'old-version-new-study'},now)).rejects.toMatchObject({code:'nothing_available'});
  expect(await light.lightOverview({type:'question',id:fixture.questionId},now)).toMatchObject({newCount:2,totalCount:2,dueCount:0});
  expect(await activity.getQuestionActivity(fixture.questionId)).toMatchObject({currentMaterialId:current.materialId,currentUnitCount:2,lightTotal:2,lightSeen:0,lightDueCount:0});
  expect(await db.all(sql`SELECT * FROM practice_materials WHERE source_id=${fixture.sourceId} AND status='ready'`)).toHaveLength(2);
  expect(await db.all(sql`SELECT * FROM practice_material_items WHERE material_id=${old.materialId}`)).toHaveLength(1);
});

it('replacing a material preserves cumulative exposure without awarding completion to its replacements',async()=>{
  const fixture=await currentMaterialFixture(db,'lifetime-revision',[['fold a towel','叠毛巾'],['hang a towel','挂毛巾']]);
  const old=await fixture.publish('old');await stamp(old.materialId,'2026-08-01T00:00:00Z');
  const scope:LightScope={type:'question',id:fixture.questionId};
  await rate(await light.createLightSession({scope,mode:'learn',clientRequestId:'lifetime-old'},now),'lifetime');
  const expressions=(await import('@/lib/app-services/web')).webExpressions;
  expect(await expressions.summary(scope,now)).toMatchObject({studied:1,eligibleStudied:1});
  const current=await fixture.publish('new');await stamp(current.materialId,'2026-08-02T00:00:00Z');
  expect(await expressions.summary(scope,now)).toMatchObject({studied:1,eligibleStudied:0,new:2});
});

it('equal created_at timestamps use descending stable material id, regardless of updated_at',async()=>{
  const fixture=await currentMaterialFixture(db,'tie-breaker',[['charge my phone','给手机充电'],['turn off the light','关灯']]);
  const versions=[await fixture.publish('old'),await fixture.publish('new')].sort((a,b)=>a.materialId<b.materialId?1:-1);
  await stamp(versions[0].materialId,'2026-08-03T00:00:00.000Z');
  await stamp(versions[1].materialId,'2026-08-03T00:00:00.000Z','2026-09-03T00:00:00.000Z');
  const cards=await sourceCards({type:'all'},fixture.sourceId);
  expect(cards.map(card=>card.itemId).sort()).toEqual([...versions[0].itemIds].sort());
  expect(cards.every(card=>card.materialId===versions[0].materialId)).toBe(true);
  expect(await activity.getQuestionActivity(fixture.questionId)).toMatchObject({currentMaterialId:versions[0].materialId,lightTotal:versions[0].itemIds.length});
});

it('a newer pending version leaves the previous ready material available in catalogue and activity',async()=>{
  const fixture=await currentMaterialFixture(db,'pending-version',[['pack my bag','收拾背包'],['lock the door','锁门']]);
  const ready=await fixture.publish('old');
  await stamp(ready.materialId,'2026-08-04T00:00:00.000Z');
  const pending=await fixture.pending();
  await stamp(pending.id,'2026-08-05T00:00:00.000Z');
  expect(pending.status).not.toBe('ready');
  expect((await sourceCards({type:'all'},fixture.sourceId)).map(card=>card.materialId)).toEqual([ready.materialId]);
  expect(await light.lightOverview({type:'question',id:fixture.questionId},now)).toMatchObject({newCount:1,totalCount:1});
  expect(await activity.getQuestionActivity(fixture.questionId)).toMatchObject({currentMaterialId:ready.materialId,lightTotal:1,state:'learning_incomplete'});
  expect((await light.createLightSession({scope:{type:'material',id:ready.materialId},mode:'learn',clientRequestId:'ready-while-pending'},now)).card?.materialId).toBe(ready.materialId);
});
it('withdrawing an already-published replacement never resurrects the superseded teaching version',async()=>{
  const fixture=await currentMaterialFixture(db,'withdraw-replacement',[['close the door','关门'],['open the door','开门']]);
  const old=await fixture.publish('old'),current=await fixture.publish('new');
  await stamp(old.materialId,'2026-08-04T00:00:00Z');await stamp(current.materialId,'2026-08-05T00:00:00Z');
  await db.run(sql`UPDATE practice_materials SET status='hidden' WHERE id=${current.materialId}`);
  expect(await sourceCards({type:'question',id:fixture.questionId},fixture.sourceId)).toEqual([]);
  expect(await sourceCards({type:'material',id:old.materialId},fixture.sourceId)).toEqual([]);
  expect(await light.lightOverview({type:'question',id:fixture.questionId},now)).toMatchObject({newCount:0,totalCount:0});
  expect(await db.all(sql`SELECT * FROM practice_material_revisions WHERE material_id=${current.materialId}`)).not.toHaveLength(0);
});

it.each(['learn','review'] as const)('a superseded %s session skips its old snapshot without adding or replacing study progress',async mode=>{
  const actions=mode==='learn'?[['wipe the table','擦桌子'],['sweep the floor','扫地']] as const:[['book a flight','订机票'],['reserve a room','订房间']] as const;
  const fixture=await currentMaterialFixture(db,`snapshot-${mode}`,actions),old=await fixture.publish('old');
  await stamp(old.materialId,'2026-08-06T00:00:00.000Z');
  const scope={type:'material' as const,id:old.materialId};
  let clock=now;
  let historyId:string|undefined;
  if(mode==='review'){
    const learned=await rate(await light.createLightSession({scope,mode:'learn',clientRequestId:'history-first-study'},now),'history-first-study');
    historyId=learned.id;expect(learned.status).toBe('completed');
    const [progress]=await db.all<{due_at:string}>(sql`SELECT due_at FROM light_study_progress WHERE learning_item_id=${old.itemIds[0]}`);
    clock=new Date(Date.parse(progress.due_at)+1000);
  }
  let snapshot=await light.createLightSession({scope,mode,clientRequestId:`snapshot-${mode}`},clock);
  snapshot=await light.applyLightEvent(snapshot.id,{type:'reveal',version:snapshot.version,clientEventId:`snapshot-${mode}-reveal`},clock);
  const before=await db.all(sql`SELECT * FROM light_study_progress WHERE learning_item_id=${old.itemIds[0]}`);
  const current=await fixture.publish('new');
  await stamp(current.materialId,'2026-08-07T00:00:00.000Z');
  const unavailable=await light.getLightView(snapshot.id);
  expect(unavailable.card).toBeNull();expect(unavailable.unavailable).toBeTruthy();
  const skipped=await light.applyLightEvent(snapshot.id,{type:'rate',rating:'forgot',version:snapshot.version,clientEventId:`superseded-${mode}-rate`},clock);
  expect(skipped.status).toBe('completed');expect(skipped.summary).toEqual([]);
  expect(await db.all(sql`SELECT * FROM light_study_progress WHERE learning_item_id=${old.itemIds[0]}`)).toEqual(before);
  expect(await db.all(sql`SELECT outcome,rating FROM light_study_events WHERE session_id=${snapshot.id} AND client_event_id=${`superseded-${mode}-rate`}`)).toEqual([{outcome:'skipped',rating:null}]);
  expect(await db.all(sql`SELECT * FROM practice_material_items WHERE material_id=${old.materialId}`)).toHaveLength(1);
  if(historyId){
    expect((await light.getLightView(historyId)).summary).toMatchObject([{itemId:old.itemIds[0],initialRating:'remembered'}]);
    expect(await db.all(sql`SELECT * FROM light_study_events WHERE session_id=${historyId} AND outcome='diagnostic_exposure'`)).toHaveLength(1);
  }
  expect(await light.lightOverview({type:'question',id:fixture.questionId},clock)).toMatchObject({newCount:2,totalCount:2,dueCount:0});
  expect(await activity.getQuestionActivity(fixture.questionId)).toMatchObject({currentMaterialId:current.materialId,lightTotal:2,lightSeen:0,lightDueCount:0});
  if(mode==='review'){
    await db.run(sql`INSERT INTO light_study_progress(learning_item_id,first_seen_at,last_seen_at,due_at,version) VALUES(${current.itemIds[0]},'2026-07-01','2026-07-01','2000-01-01',3)`);
    expect(await activity.getQuestionActivity(fixture.questionId)).toMatchObject({lightTotal:2,lightSeen:1,lightDueCount:1});
  }
});
