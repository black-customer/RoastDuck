import fs from "node:fs";
import path from "node:path";
import { authoredMaterialSchema, expandAuthored, recoverySourceSchema, authorHash } from "../src/lib/four-step/offline-contracts";
const directory=path.resolve("data/imports/private/four-step-recovery");
const sources=["sources.json","sources.fragments.json"].filter(f=>fs.existsSync(path.join(directory,f))).flatMap(f=>recoverySourceSchema.array().parse(JSON.parse(fs.readFileSync(path.join(directory,f),"utf8"))));
const batch=process.argv[2];
if(!/^batch-\d+[a-z]?(?:-r\d+)?$/u.test(batch??""))throw new Error("传入 batch-NN 或 batch-NN-rN");
const raw=JSON.parse(fs.readFileSync(path.join(directory,`${batch}.author.json`),"utf8")) as Array<Record<string,unknown>&{index:number}>;
const candidates=raw.map(row=>{
  const source=sources.find(s=>s.index===row.index)!;
  const author=authoredMaterialSchema.parse({model:"Codex agent (model not exposed)",contextId:process.argv[3]??"root-offline-20260907",...row,sourceHash:source.hash});
  let expanded;
  try{expanded=expandAuthored(source,author);}catch(error){throw new Error(`index=${row.index}: ${error instanceof Error?error.message:"invalid"}`);}
  const candidate={source,author,authorHash:authorHash(author),...expanded};
  return candidate;
});
const output=path.join(directory,`${batch}.candidates.json`);
const json=JSON.stringify(candidates,null,2);
if(fs.existsSync(output)&&fs.readFileSync(output,"utf8")!==json)throw new Error("送审候选不可覆盖，请创建新的修订批次");
if(!fs.existsSync(output))fs.writeFileSync(output,json,{flag:"wx"});
console.log(JSON.stringify({batch,count:candidates.length,sourceCoverage:"checked",reviewStatus:"pending_independent_review",output}));
