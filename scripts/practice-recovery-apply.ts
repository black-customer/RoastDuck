import fs from "node:fs";
import path from "node:path";
import { applyOfflineMaterial, compileOfflineMaterial } from "../src/lib/four-step/offline-apply";
import { authoredMaterialSchema, offlineReviewSchema, recoverySourceSchema } from "../src/lib/four-step/offline-contracts";
const directory=path.resolve("data/imports/private/four-step-recovery");
const [batch,mode="validate"]=process.argv.slice(2);
if(!/^batch-\d+[a-z]?(?:-r\d+)?$/.test(batch??"")||!["validate","apply"].includes(mode))throw new Error("用法 batch-NN [validate|apply]");
const candidates=JSON.parse(fs.readFileSync(path.join(directory,`${batch}.candidates.json`),"utf8")) as Array<{source:unknown;author:unknown}>;
const reviews=JSON.parse(fs.readFileSync(path.join(directory,`${batch}.review.json`),"utf8")) as Array<Record<string,unknown>&{index:number}>;
const selected=process.argv[4]?.split(",").map(Number);
if(selected&&(selected.some(n=>!Number.isInteger(n))||new Set(selected).size!==selected.length||selected.some(n=>!candidates.some(c=>recoverySourceSchema.parse(c.source).index===n))))throw new Error("发布索引必须明确属于当前批次");
const results=[];
for(const candidate of candidates){
  const source=recoverySourceSchema.parse(candidate.source);
  if(selected&&!selected.includes(source.index))continue;
  try{
    const author=authoredMaterialSchema.parse(candidate.author);
    const review=offlineReviewSchema.parse(reviews.find(r=>r.index===source.index));
    const compiled=compileOfflineMaterial(source,author,review);
    const publication=mode==="apply"?await applyOfflineMaterial(source,author,review):null;
    results.push({index:source.index,status:publication?"published":"validated",rows:compiled.analysis.learningMaterials.length,publication});
  }catch(error){results.push({index:source.index,status:"blocked",reason:error instanceof Error?error.message:"unknown"});}
}
fs.writeFileSync(path.join(directory,`${batch}.${mode}-report.json`),JSON.stringify({results,networkCalls:0},null,2));
console.log(JSON.stringify({results,networkCalls:0},null,2));
if(results.some(r=>r.status==="blocked"))process.exitCode=1;
