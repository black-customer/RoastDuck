/** 私有切分清单的校验/派生快照/应用。只能接收已独立审核的连续范围。 */
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@libsql/client";
import { recoverySourceSchema } from "../src/lib/four-step/offline-contracts";
import { sourceRevisionSchema, compileSourceRevision, applySourceRevision } from "../src/lib/four-step/source-revisions";
import { hash } from "../src/lib/four-step/shared";
const dir=path.resolve("data/imports/private/four-step-recovery");
const mode=process.argv[2]??"prepare";
if(!["prepare","apply"].includes(mode))throw new Error("prepare|apply");
const sources=recoverySourceSchema.array().parse(JSON.parse(fs.readFileSync(path.join(dir,"sources.json"),"utf8")));
const reviews=sourceRevisionSchema.array().parse(JSON.parse(fs.readFileSync(path.join(dir,"source-revisions.review.json"),"utf8")));
if(new Set(reviews.map(r=>r.sourceIndex)).size!==reviews.length)throw new Error("重复父来源");
const compiled=reviews.map(r=>compileSourceRevision(sources.find(s=>s.index===r.sourceIndex)!,r));
const client=createClient({url:process.env.ROASTDUCK_DB??"file:./data/app.db"});
const derived=[];
try{
  await client.execute("PRAGMA query_only=ON");
  for(const c of compiled){
    for(const child of c.children){
      const q=(await client.execute({sql:"SELECT text,text_zh,part FROM questions WHERE id=?",args:[child.questionId]})).rows[0];
      if(!q||q.text!==child.questionEn||q.part!==c.source.part)throw new Error("题目映射不一致");
      const base={key:child.id,kind:"personal_answer",createdAt:c.source.createdAt,questionId:child.questionId,questionEn:String(q.text),questionZh:String(q.text_zh),part:Number(q.part),english:child.raw,chinese:"",mode:"practice"};
      const en=Array.from(child.raw.matchAll(/[^.!?。！？\n]+[.!?。！？\n]*|[.!?。！？\n]+/g)).map((m,index)=>({index,start:m.index,end:m.index+m[0].length,text:m[0]}));
      derived.push({...base,index:sources.length+derived.length,hash:hash(JSON.stringify(base)),en,zh:[]});
    }
  }
}finally{client.close();}
const output=path.join(dir,"sources.fragments.json"),json=JSON.stringify(derived,null,2);
if(fs.existsSync(output)&&fs.readFileSync(output,"utf8")!==json)throw new Error("派生来源不可覆盖");
if(!fs.existsSync(output))fs.writeFileSync(output,json,{flag:"wx"});
const applied=[];
if(mode==="apply")for(const c of compiled)applied.push(await applySourceRevision(c.source,c.revision));
fs.writeFileSync(path.join(dir,`source-revisions.${mode}-report.json`),JSON.stringify({parents:compiled.length,children:derived.length,networkCalls:0,applied},null,2));
console.log(JSON.stringify({parents:compiled.length,children:derived.length,classifiedCharacters:compiled.reduce((n,c)=>n+c.source.english.length,0),networkCalls:0,applied}));
