import { beforeAll, afterEach, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { prepareTestDatabase } from "../helpers/temp-db";
import type { LightView } from "@/lib/light-study/contracts";
const temporary=prepareTestDatabase("light-study-v2");
process.env.ROASTDUCK_DB=temporary.url;process.env.ROASTDUCK_SKIP_DB_BACKUP="1";process.env.AI_PROVIDER="mock";
let db:Awaited<ReturnType<typeof import("@db/client").getDbReady>>;
let service:typeof import("@/lib/light-study/service");
const scope={type:"question" as const,id:"light-v2-q"},now=new Date("2026-09-07T08:00:00Z");
beforeAll(async()=>{
  db=await(await import("@db/client")).getDbReady();service=await import("@/lib/light-study/service");
  const {publishLightFixture}=await import("../helpers/light-material");
  for(const [index,[en,zh]] of [["brush my teeth","刷牙"],["wash my hands","洗手"],["wipe the table","擦桌子"],["charge my phone","给手机充电"],["take a shower","洗澡"],["put on sunscreen","涂防晒"]].entries())await publishLightFixture(db,`v2-${index}`,en,zh,scope.id);
});
afterEach(async()=>{
  vi.restoreAllMocks();
  for(const table of ["light_study_events","light_study_sessions","light_study_progress"])await db.run(sql.raw(`DELETE FROM ${table}`));
  await db.run(sql`UPDATE practice_materials SET status='ready'`);
});
const create=(requestId:string,mode:"learn"|"review"="learn",clock=now)=>service.createLightSession({scope,mode,clientRequestId:requestId},clock);
async function rate(view:LightView,rating:"remembered"|"uncertain"|"forgot",clock=now){
  view=await service.applyLightEvent(view.id,{type:"reveal",version:view.version,clientEventId:`reveal-${view.version}`},clock);
  return service.applyLightEvent(view.id,{type:"rate",rating,version:view.version,clientEventId:`rate-${view.version}`},clock);
}
it("new sessions have five hidden prompts; reveal cannot settle; exact event retries do not duplicate exposure",async()=>{
  const network=vi.spyOn(globalThis,"fetch").mockRejectedValue(new Error("No network"));
  let view=await create("v2-start");
  expect(view).toMatchObject({experienceVersion:"light_study_v2",revealed:false,total:5,initialTotal:5,phase:"initial"});
  expect((await create("v2-start")).id).toBe(view.id);
  await expect(service.applyLightEvent(view.id,{type:"rate",rating:"remembered",version:view.version,clientEventId:"early"},now)).rejects.toMatchObject({code:"reveal_required"});
  await expect(service.applyLightEvent(view.id,{type:"advance",version:view.version,clientEventId:"bypass"},now)).rejects.toMatchObject({code:"rating_required"});
  view=await service.applyLightEvent(view.id,{type:"reveal",version:view.version,clientEventId:"show"},now);
  expect(await db.all(sql`SELECT * FROM light_study_progress`)).toHaveLength(0);
  const event={type:"rate",rating:"forgot",version:view.version,clientEventId:"same-rating"};
  view=await service.applyLightEvent(view.id,event,now);
  expect((await service.applyLightEvent(view.id,event,now)).version).toBe(view.version);
  expect(await db.all(sql`SELECT * FROM light_study_progress`)).toMatchObject([{due_at:"2026-09-08T08:00:00.000Z",fsrs_json:expect.any(String),review_count:0,last_rating:'forgot',scheduler_version:'light-fsrs-days-v1'}]);
  expect(await db.all(sql`SELECT * FROM light_study_events WHERE outcome='diagnostic_exposure'`)).toHaveLength(1);
  expect(network).not.toHaveBeenCalled();
});
it("five forgotten items add at most three spaced encounters, never loop or create extra FSRS reviews",async()=>{
  let view=await create("v2-weak");
  for(let index=0;index<5;index++)view=await rate(view,"forgot");
  expect(view).toMatchObject({phase:"consolidation",index:5,total:8,initialTotal:5,unavailable:null});
  expect((await service.lightOverview(scope,now)).resumable.learn).toMatchObject({index:5,total:8});
  for(let index=0;index<3;index++)view=await rate(view,"forgot");
  expect(view.status).toBe("completed");expect(view.summary).toHaveLength(5);
  expect((await service.lightOverview(scope,now)).newCount).toBe(1);
  expect(await db.all(sql`SELECT * FROM light_study_events WHERE outcome='consolidation'`)).toHaveLength(3);
  expect((await db.all<{n:number}>(sql`SELECT SUM(review_count) AS n FROM light_study_progress`))[0].n).toBe(0);
  for(const table of ["ai_runs","four_step_sessions","learning_item_schedule","question_mastery","retrieval_attempts"])expect(await db.all(sql.raw(`SELECT * FROM ${table}`))).toHaveLength(0);
});
it("formal review settles FSRS once per item; consolidation leaves its entire scheduling snapshot unchanged",async()=>{
  let view=await create("v2-expose");
  while(view.status==="active")view=await rate(view,"remembered");
  const [{due_at}]=await db.all<{due_at:string}>(sql`SELECT MAX(due_at) AS due_at FROM light_study_progress`);
  const due=new Date(Date.parse(due_at)+1);
  view=await create("v2-due","review",due);
  for(let index=0;index<5;index++)view=await rate(view,"forgot",due);
  const before=await db.all<{review_count:number;fsrs_json:string|null}>(sql`SELECT * FROM light_study_progress ORDER BY learning_item_id`);
  while(view.status==="active")view=await rate(view,"remembered",due);
  expect(await db.all(sql`SELECT * FROM light_study_progress ORDER BY learning_item_id`)).toEqual(before);
  expect(before.every(row=>row.review_count===1&&row.fsrs_json!==null)).toBe(true);
});
it("pause/reopen retains reveal; stale window cannot overwrite; another scope cannot expose twice",async()=>{
  let view=await create("v2-pause");
  const other=await service.createLightSession({scope:{type:"material",id:view.card!.materialId},mode:"learn",clientRequestId:"other-scope"},now);
  view=await service.applyLightEvent(view.id,{type:"reveal",version:view.version,clientEventId:"show-before-pause"},now);
  view=await service.applyLightEvent(view.id,{type:"pause",version:view.version,clientEventId:"pause"},now);
  expect((await service.getLightView(view.id)).revealed).toBe(true);
  view=await create("v2-resume");
  const stale=view.version;
  view=await rate(view,"remembered");
  await expect(service.applyLightEvent(view.id,{type:"rate",rating:"forgot",version:stale,clientEventId:"stale"},now)).rejects.toMatchObject({code:"version_conflict"});
  const skipped=await service.applyLightEvent(other.id,{type:"reveal",version:other.version,clientEventId:"other"},now);
  expect(skipped.status).toBe("completed");expect(skipped.notice).toContain("另一批次");
});
it("withdrawn material does not count as exposure or as one of the intervening expressions",async()=>{
  let view=await create("v2-withdrawn");
  const itemId=view.card!.itemId;
  await db.run(sql`UPDATE practice_materials SET status='failed' WHERE id=${view.card!.materialId}`);
  expect((await service.getLightView(view.id)).card).toBeNull();
  view=await service.applyLightEvent(view.id,{type:"advance",version:view.version,clientEventId:"skip"},now);
  while(view.status==="active")view=await rate(view,"forgot");
  expect(await db.all(sql`SELECT * FROM light_study_progress WHERE learning_item_id=${itemId}`)).toHaveLength(0);
  expect(view.summary).toHaveLength(4);
});
it('completed summaries retain their original cue/answer pair; changed material is not silently substituted',async()=>{
  let view=await create('summary-binding');const first=view.card!;
  while(view.status==='active')view=await rate(view,'remembered');
  expect(view.summary?.find(item=>item.itemId===first.itemId)).toMatchObject({chinese:first.chinese,english:first.english});
  expect(view.nextDueAt).toBeTruthy();
  await db.run(sql`UPDATE practice_materials SET status='hidden' WHERE id=${first.materialId}`);
  const changed=await service.getLightView(view.id);
  expect(changed.summary?.find(item=>item.itemId===first.itemId)).toMatchObject({chinese:first.chinese,english:undefined});
  expect(changed.status).toBe('completed');
});
it('explicitly resuming a paused group does not substitute a different active group in the same scope',async()=>{
  const original=await create('explicit-source');
  await db.run(sql`INSERT INTO light_study_sessions(id,scope_key,scope_json,mode,status,version,cursor,revealed,queue_json,experience_version,round_json,created_at,updated_at)
    SELECT 'explicit-paused',scope_key,scope_json,mode,'paused',version,cursor,revealed,queue_json,experience_version,round_json,created_at,updated_at FROM light_study_sessions WHERE id=${original.id}`);
  const resumed=await service.createLightSession({scope,mode:'learn',clientRequestId:'explicit-resume',resumeSessionId:'explicit-paused'},now);
  expect(resumed.id).toBe('explicit-paused');expect(resumed.status).toBe('active');
  expect((await service.getLightView(original.id)).status).toBe('paused');
});
