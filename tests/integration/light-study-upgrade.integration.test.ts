import {beforeAll,expect,it} from 'vitest';
import {sql} from 'drizzle-orm';
import {prepareTestDatabase} from '../helpers/temp-db';
import type {LightCard,LightView} from '@/lib/light-study/contracts';
const temporary=prepareTestDatabase('light-study-upgrade');process.env.ROASTDUCK_DB=temporary.url;process.env.ROASTDUCK_SKIP_DB_BACKUP='1';process.env.AI_PROVIDER='mock';
let db:Awaited<ReturnType<typeof import('@db/client').getDbReady>>,service:typeof import('@/lib/light-study/service');
const clock=new Date('2026-09-08T01:00:00Z');
async function oldSession(name:string,count=1){
  const {publishLightFixture}=await import('../helpers/light-material');
  const questionId=`upgrade-${name}`,scope={type:'question' as const,id:questionId};
  for(let i=0;i<count;i++)await publishLightFixture(db,`${name}-${i}`,`describe ${name} ${i}`,`说明${name}${i}`,questionId);
  const {cards}=await(await import('@/lib/light-study/catalogue')).readLightCatalogue(scope);
  const id=`legacy-${name}`;
  await db.run(sql`INSERT INTO light_study_sessions(id,scope_key,scope_json,mode,status,version,cursor,revealed,queue_json,experience_version,created_at,updated_at) VALUES(${id},${JSON.stringify(scope)},${JSON.stringify(scope)},'learn','active',0,0,0,${JSON.stringify(cards)},'light_study_v1',${clock.toISOString()},${clock.toISOString()})`);
  return {id,scope,cards};
}
beforeAll(async()=>{db=await(await import('@db/client')).getDbReady();service=await import('@/lib/light-study/service');});
it('old URLs read a transition, never answers; continue creates one five-item successor and retains the remainder',async()=>{
  const old=await oldSession('batch',8),before=await service.getLightView(old.id);
  expect(before).toMatchObject({needsUpgrade:true,revealed:false,card:null});
  expect(await db.all(sql`SELECT * FROM light_study_successions`)).toHaveLength(0);
  const input={scope:old.scope,mode:'learn',clientRequestId:'upgrade-once',resumeSessionId:old.id};
  let current=await service.createLightSession(input,clock);expect(current).toMatchObject({experienceVersion:'light_study_v2',legacySessionId:old.id,revealed:false,initialTotal:5,index:0});expect(current.card?.itemId).toBe(old.cards[0].itemId);
  expect((await service.createLightSession(input,clock)).id).toBe(current.id);
  expect((await service.getLightView(old.id)).id).toBe(current.id);
  expect(await db.all(sql`SELECT * FROM light_study_progress`)).toHaveLength(0);
  const firstId=current.id;
  while(current.status==='active'){
    current=await service.applyLightEvent(current.id,{type:'reveal',clientEventId:`show-${current.version}`,version:current.version},clock);
    current=await service.applyLightEvent(current.id,{type:'rate',rating:'remembered',clientEventId:`rate-${current.version}`,version:current.version},clock);
  }
  current=await service.createLightSession({scope:old.scope,mode:'learn',clientRequestId:'next-batch'},clock);
  expect(current.initialTotal).toBe(3);expect(current.card?.itemId).toBe(old.cards[5].itemId);
  expect((await service.createLightSession(input,clock)).id).toBe(firstId);
  expect(await db.all(sql`SELECT * FROM light_study_succession_batches WHERE legacy_session_id=${old.id}`)).toHaveLength(2);
});
it('still-due review items with newer progress versions are reprojected, not dropped from a successor',async()=>{
  const old=await oldSession('stale-due');await db.run(sql`UPDATE light_study_sessions SET mode='review' WHERE id=${old.id}`);
  await db.run(sql`INSERT INTO light_study_progress(learning_item_id,first_seen_at,last_seen_at,due_at,version) VALUES(${old.cards[0].itemId},'2026-09-01','2026-09-02','2026-09-03',8)`);
  const view=await service.createLightSession({scope:old.scope,mode:'review',clientRequestId:'stale-due'},clock);
  expect(view.experienceVersion).toBe('light_study_v2');expect(view.unavailable).toBeNull();expect(view.card?.itemId).toBe(old.cards[0].itemId);
});
it('saved old exposure is reconciled once before continuation; it is not a correct recall',async()=>{
  const old=await oldSession('pending',3),event={type:'advance',clientEventId:'old-response-lost',version:0};
  await service.applyLightEvent(old.id,event,clock);await service.applyLightEvent(old.id,event,clock);
  const next=await service.createLightSession({scope:old.scope,mode:'learn',clientRequestId:'pending-resume'},clock);
  expect(next.card?.itemId).toBe(old.cards[1].itemId);
  const [progress]=await db.all<{due_at:string;review_count:number;fsrs_json:string|null}>(sql`SELECT * FROM light_study_progress WHERE learning_item_id=${old.cards[0].itemId}`);
  expect(progress).toMatchObject({due_at:'2026-09-09T01:00:00.000Z',review_count:0,fsrs_json:null});
  expect(await db.all(sql`SELECT * FROM light_study_events WHERE session_id=${old.id} AND outcome='exposure'`)).toHaveLength(1);
});
it('a late old advance after cutover records only the old exposure and does not grade V2',async()=>{
  const old=await oldSession('late',2),next=await service.createLightSession({scope:old.scope,mode:'learn',clientRequestId:'late-upgrade'},clock);
  const event={type:'advance',clientEventId:'late-advance',version:0};
  await service.applyLightEvent(old.id,event,clock);await service.applyLightEvent(old.id,event,clock);
  const state=await service.getLightView(next.id);expect(state.unavailable).toBeTruthy();
  await expect(service.applyLightEvent(old.id,{type:'advance',clientEventId:'new-old-operation',version:1},clock)).rejects.toMatchObject({code:'version_conflict'});
  const skipped=await service.applyLightEvent(next.id,{type:'advance',clientEventId:'skip-changed',version:state.version},clock);
  expect(skipped.card?.itemId).toBe(old.cards[1].itemId);
  expect(await db.all(sql`SELECT * FROM light_study_events WHERE session_id=${next.id} AND outcome='diagnostic_exposure'`)).toHaveLength(0);
});
it('completed old sessions are read-only history; removed queued material is not marked learned',async()=>{
  const old=await oldSession('removed');await db.run(sql`UPDATE practice_materials SET status='hidden' WHERE id=${old.cards[0].materialId}`);
  const view=await service.createLightSession({scope:old.scope,mode:'learn',clientRequestId:'empty-upgrade'},clock);
  expect(view).toMatchObject({historyOnly:true,card:null,revealed:false});
  expect(await db.all(sql`SELECT * FROM light_study_progress WHERE learning_item_id=${old.cards[0].itemId}`)).toHaveLength(0);
  expect((await service.lightOverview(old.scope,clock)).resumable).toEqual({});
  const done=await oldSession('completed');await db.run(sql`UPDATE light_study_sessions SET status='completed',cursor=1 WHERE id=${done.id}`);
  expect(await service.getLightView(done.id)).toMatchObject({historyOnly:true,needsUpgrade:false,card:null});
});
it('V1 review keeps its previous FSRS record and requires a new reveal before self-rating',async()=>{
  const old=await oldSession('review');
  await db.run(sql`UPDATE light_study_sessions SET mode='review',revealed=1 WHERE id=${old.id}`);
  await db.run(sql`INSERT INTO light_study_progress(learning_item_id,first_seen_at,last_seen_at,due_at) VALUES(${old.cards[0].itemId},'2026-09-01','2026-09-01','2026-09-02')`);
  const cards:LightCard[]=old.cards.map(card=>({...card,progressVersion:1}));await db.run(sql`UPDATE light_study_sessions SET queue_json=${JSON.stringify(cards)} WHERE id=${old.id}`);
  const before=await db.all(sql`SELECT * FROM light_study_progress WHERE learning_item_id=${old.cards[0].itemId}`);
  const view:LightView=await service.createLightSession({scope:old.scope,mode:'review',clientRequestId:'review-upgrade'},clock);
  expect(view.revealed).toBe(false);expect(await db.all(sql`SELECT * FROM light_study_progress WHERE learning_item_id=${old.cards[0].itemId}`)).toEqual(before);
  await expect(service.applyLightEvent(view.id,{type:'rate',rating:'remembered',version:0,clientEventId:'no-reveal'},clock)).rejects.toMatchObject({code:'reveal_required'});
});
