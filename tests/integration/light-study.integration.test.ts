import { beforeAll,afterEach,expect,it,vi } from "vitest";
import { sql } from "drizzle-orm";
import { prepareTestDatabase } from "../helpers/temp-db";
const temporary=prepareTestDatabase("light-study");
process.env.ROASTDUCK_DB=temporary.url;process.env.ROASTDUCK_SKIP_DB_BACKUP="1";process.env.AI_PROVIDER="mock";
let db:Awaited<ReturnType<typeof import("@db/client").getDbReady>>;
let service:typeof import("@/lib/light-study/service");
let publish:typeof import("../helpers/light-material").publishLightFixture;
// Retired V1 event fixture: raw snapshots are inspected only by tests; no live direct-teaching view.
async function legacy(input:Parameters<typeof service.createLightSession>[0],clock:Date) {
  const view=await service.createLightSession(input,clock);
  if(view.experienceVersion==="light_study_v2"&&view.version===0){
    const {cards,progress}=await(await import("@/lib/light-study/catalogue")).readLightCatalogue(view.scope);
    const selected=cards.filter(card=>view.mode==="learn"?!progress.has(card.itemId):(progress.get(card.itemId)?.due_at??"9999")<=clock.toISOString()).slice(0,10);
    await db.run(sql`UPDATE light_study_sessions SET experience_version='light_study_v1',round_json=NULL,queue_json=${JSON.stringify(selected)} WHERE id=${view.id}`);
  }
  const [raw]=await db.all<{queue_json:string;version:number}>(sql`SELECT queue_json,version FROM light_study_sessions WHERE id=${view.id}`);
  const cards=JSON.parse(raw.queue_json);
  return {...await service.getLightView(view.id),card:cards[0],total:cards.length,version:raw.version};
}
const all={type:"all" as const};
const time=new Date("2026-09-07T04:00:00Z");
let first:{materialId:string;questionId:string;attemptId:string};
const request=(suffix:string,scope:typeof all|{type:"question"|"material";id:string},mode:"learn"|"review"="learn")=>({scope,mode,clientRequestId:`request-${suffix}`});
beforeAll(async()=>{
  db=await(await import("@db/client")).getDbReady();service=await import("@/lib/light-study/service");
  publish=(await import("../helpers/light-material")).publishLightFixture;
  first=await publish(db,"light-first","brush my teeth","刷牙");
});
afterEach(()=>{vi.restoreAllMocks();delete process.env.LIGHT_STUDY_ENABLED;});
it("v24迁移连续，overview纯读取，材料范围不存在返回404",async()=>{
  expect((await db.all<{v:number}>(sql`SELECT MAX(version) AS v FROM _schema_migrations`))[0].v).toBe(32);
  expect(await service.lightOverview(all,time)).toMatchObject({newCount:1,dueCount:0,totalCount:1,defaultMode:"learn"});
  expect(await db.all(sql`SELECT * FROM light_study_sessions`)).toHaveLength(0);
  expect(await db.all(sql`SELECT * FROM light_study_progress`)).toHaveLength(0);
  await expect(service.lightOverview({type:"question",id:"missing"})).rejects.toMatchObject({status:404});
});
it("旧新学事件只补记曝光/24小时due，公开读取不再教学；重试不影响旧成绩",async()=>{
  const network=vi.spyOn(globalThis,"fetch").mockRejectedValue(new Error("禁止网络"));
  const view=await legacy(request("first",all),time);
  expect(view).toMatchObject({mode:"learn",revealed:false,index:0,total:1});
  expect((await service.getLightView(view.id)).card).toBeNull();
  await expect(service.createLightSession(request("first",{type:"material",id:first.materialId}),time)).rejects.toMatchObject({code:"request_conflict"});
  const event={type:"advance",clientEventId:"exposure-once",version:view.version};
  expect((await service.applyLightEvent(view.id,event,time)).status).toBe("completed");
  expect((await service.applyLightEvent(view.id,event,time)).status).toBe("completed");
  const [progress]=await db.all<{due_at:string;fsrs_json:string|null;review_count:number}>(sql`SELECT * FROM light_study_progress`);
  expect(progress).toMatchObject({due_at:"2026-09-08T04:00:00.000Z",fsrs_json:null,review_count:0});
  for(const table of ["four_step_sessions","learning_item_schedule","question_mastery","four_step_settlements","retrieval_attempts"])expect(await db.all(sql.raw(`SELECT * FROM ${table}`))).toHaveLength(0);
  expect(await db.all(sql`SELECT * FROM ai_runs`)).toHaveLength(0);
  expect(network).not.toHaveBeenCalled();
});
it("未到期不能复习；三档都前进，揭晓前不能评分，暂停刷新保留状态",async()=>{
  await expect(service.createLightSession(request("not-due",all,"review"),time)).rejects.toMatchObject({code:"nothing_available"});
  const due=new Date(time.getTime()+86400001);
  expect(await service.lightOverview(all,due)).toMatchObject({dueCount:1,defaultMode:"review"});
  let view=await service.createLightSession(request("review",all,"review"),due);
  expect(view.revealed).toBe(false);
  await expect(service.applyLightEvent(view.id,{type:"rate",rating:"remembered",clientEventId:"early",version:0},due)).rejects.toMatchObject({code:"reveal_required"});
  view=await service.applyLightEvent(view.id,{type:"reveal",clientEventId:"show",version:view.version},due);
  view=await service.applyLightEvent(view.id,{type:"pause",clientEventId:"pause",version:view.version},due);
  expect((await service.getLightView(view.id)).revealed).toBe(true);
  view=await service.createLightSession(request("resume",all,"review"),due);
  expect(view).toMatchObject({status:"active",revealed:true});
  view=await service.applyLightEvent(view.id,{type:"rate",rating:"forgot",clientEventId:"rate-forgot",version:view.version},due);
  expect(view.status).toBe("completed");
  for(const rating of ["uncertain","remembered"] as const){
    const [{due_at:nextDue}]=await db.all<{due_at:string}>(sql`SELECT due_at FROM light_study_progress`);
    const clock=new Date(Date.parse(nextDue)+1000);
    view=await service.createLightSession(request(`review-${rating}`,all,"review"),clock);
    view=await service.applyLightEvent(view.id,{type:"reveal",clientEventId:`show-${rating}`,version:view.version},clock);
    view=await service.applyLightEvent(view.id,{type:"rate",rating,clientEventId:`rate-${rating}`,version:view.version},clock);
    expect(view.status).toBe("completed");
  }
  expect((await db.all<{review_count:number;last_rating:string}>(sql`SELECT * FROM light_study_progress`))[0]).toMatchObject({review_count:3,last_rating:"remembered"});
});
it("跨题共享一份进度，失去响应重试不新建第二会话，多窗口过期事件不覆盖",async()=>{
  const second=await publish(db,"light-second","brush my teeth","刷牙","light-q-second");
  expect(await service.lightOverview({type:"question",id:second.questionId},time)).toMatchObject({newCount:0,totalCount:1});
  const item=await publish(db,"light-other","wash my hands","洗手");
  const scope={type:"material" as const,id:item.materialId};
  const a=await service.createLightSession(request("same-a",scope),time);
  const b=await service.createLightSession(request("same-b",scope),time);
  expect(a.id).toBe(b.id);
  const revealed=await service.applyLightEvent(a.id,{type:"reveal",clientEventId:"tab-a-show",version:a.version},time);
  await service.applyLightEvent(a.id,{type:"rate",rating:'remembered',clientEventId:"tab-a",version:revealed.version},time);
  await expect(service.applyLightEvent(b.id,{type:"advance",clientEventId:"tab-b",version:b.version},time)).rejects.toMatchObject({code:"version_conflict"});
  expect((await service.createLightSession(request("same-b",scope),time)).status).toBe("completed");
});
it("跨范围并行会话不重复评分：已更新项跳过并说明",async()=>{
  const item=await publish(db,"light-cross","rinse my mouth","漱口");
  const a=await legacy(request("cross-a",{type:"material",id:item.materialId}),time);
  const b=await legacy(request("cross-b",{type:"question",id:item.questionId}),time);
  await service.applyLightEvent(a.id,{type:"advance",clientEventId:"cross-a-next",version:0},time);
  const result=await service.applyLightEvent(b.id,{type:"advance",clientEventId:"cross-b-next",version:0},time);
  expect(result.notice).toContain("另一批次");expect(result.status).toBe("completed");
  expect((await db.all<{n:number}>(sql`SELECT COUNT(*) AS n FROM light_study_events WHERE learning_item_id=${a.card!.itemId} AND outcome='exposure'`))[0].n).toBe(1);
});
it("批次最多10且去重，不要求一批清空；被撤销和审核坏链不计为学过",async()=>{
  const items=[];
  for(const [index,target] of ["wipe the table","charge my phone","turn off the light","put on sunscreen","take a break","make an appointment","change my mind","miss the bus","catch a train","take a shower","get some rest"].entries()){
    items.push(await publish(db,`light-batch-${index}`,target,`合成动作${index}`,"light-batch-q"));
  }
  const scope={type:"question" as const,id:"light-batch-q"};
  const view=await legacy(request("batch",scope),time);
  expect(view.total).toBe(10);expect((await service.lightOverview(scope,time)).newCount).toBe(11);
  const materialId=view.card!.materialId;
  await db.run(sql`UPDATE practice_materials SET status='failed' WHERE id=${materialId}`);
  expect((await service.getLightView(view.id)).card).toBeNull();
  const next=await service.applyLightEvent(view.id,{type:"advance",clientEventId:"skip-revoked",version:0},time);
  expect(next.index).toBe(1);
  expect(await db.all(sql`SELECT * FROM light_study_progress WHERE learning_item_id=${view.card!.itemId}`)).toHaveLength(0);
  const [raw]=await db.all<{queue_json:string}>(sql`SELECT queue_json FROM light_study_sessions WHERE id=${view.id}`);
  const nextMaterial=JSON.parse(raw.queue_json)[1].materialId;
  await db.run(sql`UPDATE practice_offline_runs SET artifact_hash='tampered' WHERE material_id=${nextMaterial} AND stage='review'`);
  const upgraded=await service.createLightSession(request('skip-invalid-upgrade',scope),time);
  expect(upgraded.experienceVersion).toBe('light_study_v2');expect(upgraded.total).toBe(5);expect(upgraded.card?.materialId).not.toBe(nextMaterial);
  expect((await service.lightOverview(scope,time)).unavailableCount).toBe(2);
});
it("关闭新建仍能恢复旧批次，HTTP验证非法请求并保持GET只读",async()=>{
  process.env.LIGHT_STUDY_ENABLED="0";
  await expect(service.createLightSession(request("disabled",{type:"material",id:first.materialId}),time)).rejects.toMatchObject({code:"light_study_disabled"});
  const scope={type:"question" as const,id:"light-batch-q"};
  expect((await service.createLightSession(request("disabled-resume",scope),time)).status).toBe("active");
  const get=await import("@/app/api/light-study/overview/route");
  expect((await get.GET(new Request("http://localhost/api/light-study/overview?scope=bad"))).status).toBe(400);
  const post=await import("@/app/api/light-study/sessions/route");
  expect((await post.POST(new Request("http://localhost/api/light-study/sessions",{method:"POST",body:"{"}))).status).toBe(400);
  const before=(await db.all<{n:number}>(sql`SELECT COUNT(*) AS n FROM light_study_events`))[0].n;
  expect((await get.GET(new Request("http://localhost/api/light-study/overview"))).status).toBe(200);
  expect((await db.all<{n:number}>(sql`SELECT COUNT(*) AS n FROM light_study_events`))[0].n).toBe(before);
});
