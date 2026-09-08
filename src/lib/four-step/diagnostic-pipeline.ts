import fs from "node:fs";
import path from "node:path";
import {nodeDatabase} from "@/lib/platform/node/database";
import {executeAuditedAiCall} from "@/lib/ai/job-service";
import type {AiProvider} from "@/lib/ai/contracts";
import type {MaterialRow} from "./material-types";
import {runCoreDiagnosticPipeline} from "./core-diagnostic-pipeline";
export {STAGE_CONTRACTS,DIAGNOSIS_REPAIR_PROMPT} from "./stage-contracts";
export function runDiagnosticPipeline(material:MaterialRow,jobId:string,provider:AiProvider,guard:(work:()=>Promise<unknown>)=>Promise<unknown>){
  return runCoreDiagnosticPipeline(material,{database:nodeDatabase,runtime:{call:(request)=>executeAuditedAiCall(provider,jobId,request,{maxAttempts:1})},
    loadPrompt:name=>fs.readFileSync(path.join(process.cwd(),"pipeline/prompts",name),"utf8"),now:()=>new Date(),
    guard:work=>guard(()=>nodeDatabase.write(work)),callOptions:{jobId}});
}
