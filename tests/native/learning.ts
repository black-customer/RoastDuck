import commands from "@native-fixture";
import type { DatabasePort } from "../../src/lib/platform/database";
import { createLightService } from "../../src/lib/light-study/core-service";
import type { LightView } from "../../src/lib/light-study/contracts";

/** This module is packaged ONLY in the explicit debug harness, never mobile/dist. */
export async function testNativeLearning(database:DatabasePort,assert:(condition:unknown,name:string)=>void) {
  await database.write(async tx=>{for(const command of commands)await tx.run(command);});
  let clock=new Date("2026-09-07T08:00:00Z"),sequence=0;
  const options={now:()=>clock,newId:()=>`native-test-${++sequence}`,enabled:()=>true,allowMock:true};
  let service=createLightService(database,options);
  const scope={type:"question" as const,id:"native-question"};
  assert((await service.lightOverview(scope)).newCount===5,"真实原生审核链选出5项");
  const request={scope,mode:"learn",clientRequestId:"native-create"};
  let view=await service.createLightSession(request);
  assert(!view.revealed&&view.total===5,"新学中文先行/初始5项");
  assert((await service.createLightSession(request)).id===view.id,"创建重试不重复会话");
  async function rate(value:LightView){
    value=await service.applyLightEvent(value.id,{type:"reveal",version:value.version,clientEventId:`event-${++sequence}`});
    const event={type:"rate",rating:"forgot",version:value.version,clientEventId:`event-${++sequence}`};
    const result=await service.applyLightEvent(value.id,event);
    if((await service.applyLightEvent(value.id,event)).version!==result.version)throw new Error("event duplicated");
    return result;
  }
  view=await rate(view);
  view=await service.applyLightEvent(view.id,{type:"pause",version:view.version,clientEventId:"pause"});
  service=createLightService(database,options);
  view=await service.createLightSession({...request,clientRequestId:"resume"});
  assert(view.index===1&&view.status==="active","重新创建服务仍恢复原位置");
  while(view.status==="active")view=await rate(view);
  assert(view.total===8&&view.summary?.length===5,"原生有限巩固最多3项");
  const initial=await database.read(tx=>tx.all<{due_at:string;fsrs_json:string|null;review_count:number}>({sql:"SELECT * FROM light_study_progress"}));
  assert(initial.length===5&&initial.every(p=>p.due_at==="2026-09-08T08:00:00.000Z"&&p.fsrs_json===null&&p.review_count===0),"首见24小时且无成功评分");
  clock=new Date("2026-09-08T08:00:01Z");
  view=await service.createLightSession({scope,mode:"review",clientRequestId:"review"});
  while(view.status==="active")view=await rate(view);
  const reviewed=await database.read(tx=>tx.all<{fsrs_json:string;review_count:number}>({sql:"SELECT * FROM light_study_progress"}));
  assert(reviewed.every(p=>p.review_count===1&&p.fsrs_json),"正式复习每项只结算一次FSRS");
  assert((await database.read(tx=>tx.all({sql:"SELECT * FROM four_step_sessions"}))).length===0,"轻学习不写四步成绩");
  assert((await database.read(tx=>tx.all({sql:"SELECT * FROM ai_runs"}))).length===0,"轻学习不调用文本AI");
}
