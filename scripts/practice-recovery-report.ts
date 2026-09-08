/** 只提交脱敏的发布清单与哈希；私人原文和审核正文始终在忽略目录。 */
import fs from "node:fs";
import path from "node:path";
import {createClient} from "@libsql/client";
import {recoverySourceSchema} from "../src/lib/four-step/offline-contracts";
import {auditPracticeMaterials} from "../src/lib/four-step/audit";
import {auditSourceRevisions} from "../src/lib/four-step/source-audit";
const directory=path.resolve("data/imports/private/four-step-recovery");
const sources=["sources.json","sources.fragments.json"].flatMap(file=>recoverySourceSchema.array().parse(JSON.parse(fs.readFileSync(path.join(directory,file),"utf8"))));
const db=createClient({url:process.env.ROASTDUCK_DB??"file:./data/app.db"});
try{
  await db.execute("PRAGMA query_only=ON");
  const rows=[];
  for(const source of sources){
    const revision=(await db.execute({sql:"SELECT id FROM practice_source_revisions WHERE parent_answer_id=?",args:[source.key]})).rows[0];
    if(revision){rows.push({index:source.index,sourceHash:source.hash,state:"classified_original",revisionId:revision.id});continue;}
    const mapped=(await db.execute({sql:"SELECT attempt_id FROM practice_answer_sources WHERE answer_id=?",args:[source.key]})).rows[0];
    const attempt=source.kind==="attempt"?source.key:mapped?.attempt_id;
    const material=attempt?(await db.execute({sql:"SELECT * FROM practice_materials WHERE source_type='ielts_practice' AND source_id=? AND contract_version='evidence_v2' ORDER BY created_at DESC LIMIT 1",args:[attempt]})).rows[0]:null;
    if(!material||material.status!=="ready")throw new Error(`index ${source.index} 尚未发布，不能出具全量交付清单`);
    const analysis=JSON.parse(String(material.analysis_json));
    const receipts=(await db.execute({sql:"SELECT stage,run_id,model,context_id,prompt_version,input_hash,output_hash,artifact_hash,network_calls FROM practice_offline_runs WHERE material_id=? ORDER BY stage",args:[material.id]})).rows;
    rows.push({index:source.index,sourceHash:source.hash,state:"published",materialId:material.id,units:analysis.evidence.diagnosis.units.length,trainingRows:analysis.learningMaterials.length,receipts});
  }
  const audit=await auditPracticeMaterials(db),sourceAudit=await auditSourceRevisions(db);
  if(!audit.ok||!sourceAudit.ok)throw new Error("真实发布或源修订审计失败");
  const output=path.resolve("pipeline/agent-work/practice-recovery/2026-09-07.json");
  fs.mkdirSync(path.dirname(output),{recursive:true});
  fs.writeFileSync(output,JSON.stringify({version:"offline-practice-recovery-v1",checkedAt:new Date().toISOString(),networkCalls:0,runtimeApiCalls:0,originalSources:95,derivedSources:20,audit,sourceAudit,rows},null,2));
  console.log(JSON.stringify({published:audit.checked,classified:sourceAudit.checked,output,networkCalls:0}));
}finally{db.close();}
