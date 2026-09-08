/** 本机 MVP 内容可用性与 CI Mock 质量门分开，零发布不能被 PASS 掩盖。 */
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@libsql/client";
import { auditPracticeMaterials } from "../src/lib/four-step/audit";
import { auditSourceRevisions } from "../src/lib/four-step/source-audit";
const url=process.env.ROASTDUCK_DB??"file:./data/app.db";
if(!url.startsWith("file:")||!fs.existsSync(path.resolve(url.slice(5))))throw new Error("需要已存在的本地数据库");
const db=createClient({url});
try{
  await db.execute("PRAGMA query_only=ON");
  const rows=(await db.execute(`WITH sources AS (
    SELECT a.id source_id,'attempt' kind,a.id attempt_id,a.question_id FROM speaking_question_attempts a
      WHERE NOT EXISTS(SELECT 1 FROM practice_answer_sources m WHERE m.attempt_id=a.id)
    UNION ALL SELECT a.id,'historical',m.attempt_id,a.question_id FROM personal_answers a LEFT JOIN practice_answer_sources m ON m.answer_id=a.id WHERE a.superseded_by_revision_id IS NULL
  ) SELECT s.*,p.id material_id,p.status,json_array_length(p.analysis_json,'$.learningMaterials') rows,
    (SELECT count(*) FROM json_each(p.analysis_json,'$.evidence.selection.units') u WHERE json_extract(u.value,'$.status')='uncertain') uncertain
    FROM sources s LEFT JOIN practice_materials p ON p.id=(SELECT pm.id FROM practice_materials pm WHERE pm.source_type='ielts_practice' AND pm.source_id=s.attempt_id ORDER BY (pm.contract_version='evidence_v2') DESC,pm.created_at DESC,pm.id DESC LIMIT 1)`)).rows;
  const audit=await auditPracticeMaterials(db);
  const sourceRevisionAudit=await auditSourceRevisions(db);
  const pending=rows.filter(r=>r.status!=="ready");
  const result={checkedAt:new Date().toISOString(),networkCalls:0,totalSources:rows.length,learnable:rows.filter(r=>r.status==="ready"&&Number(r.rows)>0).length,noConfirmedTraining:rows.filter(r=>r.status==="ready"&&Number(r.rows)===0).length,withUncertainFragments:rows.filter(r=>r.status==="ready"&&Number(r.uncertain)>0).length,unprocessed:pending.length,materialAudit:audit,sourceRevisionAudit,remaining:pending.map(r=>({sourceId:r.source_id,questionId:r.question_id,status:r.status??"not_compiled"}))};
  const dir=path.resolve("test-results/material-audit");fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,"readiness.json"),JSON.stringify(result,null,2));
  console.log(JSON.stringify({...result,remaining:undefined}));
  if(!audit.ok||!sourceRevisionAudit.ok||pending.length)process.exitCode=1;
}finally{db.close();}
