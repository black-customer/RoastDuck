/** 真实材料的只读就绪核查；不创建会话、不触发文本AI或TTS。 */
import fs from "node:fs";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";
import {createLightService} from "../src/lib/light-study/core-service";
import type {DatabasePort,SqlCommand} from "../src/lib/platform/database";
const url=process.env.ROASTDUCK_DB??"file:./data/app.db";
if(!url.startsWith("file:")||!fs.existsSync(path.resolve(url.slice(5))))throw new Error("需要已存在的本地数据库");
// Open read-only BEFORE any application imports; audit must never trigger migrations.
const db=new DatabaseSync(path.resolve(url.slice(5)),{readOnly:true});
const port:DatabasePort={
  read:async work=>work({all:async<T>(command:SqlCommand)=>db.prepare(command.sql).all(...command.args??[]) as T[]}),
  write:async()=>{throw new Error("只读审计禁止写入或迁移");},
};
const {lightOverview}=createLightService(port,{now:()=>new Date(),newId:()=>{throw new Error("只读审计禁止新建记录");},enabled:()=>true});
const counts=async()=>{
  const result:Record<string,number>={};
  for(const table of ["light_study_sessions","light_study_events","light_study_progress","four_step_sessions","learning_item_schedule","question_mastery","ai_runs","speaking_question_attempts"]){
    result[table]=Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n);
  }
  return result;
};
try{
const before=await counts(),start=Date.now();
const overview=await lightOverview({type:"all"});
const elapsedMs=Date.now()-start,after=await counts();
const unchanged=JSON.stringify(before)===JSON.stringify(after);
const report={checkedAt:new Date().toISOString(),readOnly:true,networkCalls:0,elapsedMs,schemaVersion:Number(db.prepare("SELECT MAX(version) AS v FROM _schema_migrations").get()!.v),
  eligibleExpressions:overview.totalCount,newExpressions:overview.newCount,dueExpressions:overview.dueCount,
  unavailableMaterials:overview.unavailableCount,unchanged,counts:after};
fs.mkdirSync("test-results/light-study",{recursive:true});
fs.writeFileSync("test-results/light-study/readiness.json",JSON.stringify(report,null,2));
console.log(JSON.stringify(report));
if(!unchanged||overview.unavailableCount||!overview.totalCount)process.exitCode=1;
}finally{db.close();}
