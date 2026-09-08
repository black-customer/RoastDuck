/** 只读原库，导出最少必要私有材料；不初始化、写进度或调用 AI。 */
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@libsql/client";
import { hash } from "../src/lib/four-step/shared";

const client=createClient({url:process.env.ROASTDUCK_DB??"file:./data/app.db"});
await client.execute("PRAGMA query_only=ON");
const directory=path.resolve("data/imports/private/four-step-recovery");
fs.mkdirSync(directory,{recursive:true});
const catalogue=(text:string)=>Array.from(text.matchAll(/[^.!?。！？\n]+[.!?。！？\n]*|[.!?。！？\n]+/g)).map((m,index)=>({index,start:m.index,end:m.index+m[0].length,text:m[0]}));
const attempts=(await client.execute("SELECT a.*,q.text question_en,q.text_zh question_zh,q.part FROM speaking_question_attempts a JOIN questions q ON q.id=a.question_id ORDER BY a.created_at,a.id")).rows;
const old=(await client.execute("SELECT a.*,q.text question_en,q.text_zh question_zh,q.part FROM personal_answers a JOIN questions q ON q.id=a.question_id WHERE a.superseded_by_revision_id IS NULL ORDER BY a.created_at,a.attempt_order,a.id")).rows;
const sources=[...attempts.map(a=>({key:String(a.id),kind:"attempt",createdAt:String(a.created_at),questionId:String(a.question_id),questionEn:String(a.question_en),questionZh:String(a.question_zh),part:Number(a.part),english:String(a.answer_text),chinese:String(a.intended_meaning_zh),mode:String(a.mode)})),...old.map(a=>({key:String(a.id),kind:"personal_answer",createdAt:String(a.created_at),questionId:String(a.question_id),questionEn:String(a.question_en),questionZh:String(a.question_zh),part:Number(a.part),english:String(a.raw_text),chinese:"",mode:"practice"}))].map((s,index)=>({...s,index,hash:hash(JSON.stringify(s)),en:catalogue(s.english),zh:catalogue(s.chinese)}));
const output=path.join(directory,"sources.json");
if(fs.existsSync(output)&&fs.readFileSync(output,"utf8")!==JSON.stringify(sources,null,2)+"\n") throw new Error("导出快照已有不同内容，需新建版本，不能覆盖");
fs.writeFileSync(output,JSON.stringify(sources,null,2)+"\n",{flag:fs.existsSync(output)?"w":"wx"});
console.log(JSON.stringify({sources:sources.length,attempts:attempts.length,historical:old.length,networkCalls:0,path:output}));
client.close();
