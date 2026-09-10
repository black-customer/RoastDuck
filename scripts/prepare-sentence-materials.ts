import fs from 'node:fs';
import path from 'node:path';
import {nodeDatabase} from '../src/lib/platform/node/database';
import {query as sql} from '../src/lib/platform/sql';
import type {MaterialRow,MaterialInput} from '../src/lib/four-step/material-types';
import {auditPracticeMaterials} from '../src/lib/four-step/audit';
import {speakingAttemptAnalysisSchema} from '../src/lib/speaking-practice/schemas';
import {publishSentenceMaterials,projectSentenceMaterials} from '../src/lib/sentence-study/materials';
import {currentReadyMaterialPredicate} from '../src/lib/light-study/current-material';
const apply=process.argv.includes('--apply');
const rows=await nodeDatabase.read(tx=>tx.all<MaterialRow>(sql`SELECT pm.* FROM practice_materials pm WHERE pm.status='ready' AND pm.contract_version='evidence_v2' AND ${{sql:currentReadyMaterialPredicate}} ORDER BY pm.id`));
const allowMock=process.env.AI_PROVIDER==='mock'&&(process.env.ROASTDUCK_DB??'').includes('test-results/');
const results=[];
for(const row of rows){
  const [edition]=await nodeDatabase.read(tx=>tx.all<{id:string}>(sql`SELECT id FROM sentence_material_editions WHERE material_id=${row.id} LIMIT 1`));
  if(edition){
    const [count]=await nodeDatabase.read(tx=>tx.all<{n:number}>(sql`SELECT COUNT(*) AS n FROM sentence_learning_units WHERE material_id=${row.id} AND active=1`));
    results.push({materialId:row.id,status:'ready',sentences:count.n,preservedReviewedEdition:true});continue;
  }
  const result=await nodeDatabase.read(tx=>auditPracticeMaterials({execute:async q=>({rows:await tx.all<Record<string,unknown>>(typeof q==='string'?{sql:q}:q)})},allowMock,[row.id]));
  if(!result.ok){results.push({materialId:row.id,status:'unavailable',issues:result.issues});continue;}
  const input=JSON.parse(row.input_json) as MaterialInput,analysis=speakingAttemptAnalysisSchema.parse(JSON.parse(row.analysis_json));
  try{
    const cards=projectSentenceMaterials(row.id,input,analysis);
    if(apply)await nodeDatabase.write(async tx=>{
      const [current]=await tx.all<MaterialRow>(sql`SELECT * FROM practice_materials WHERE id=${row.id}`);
      if(current?.analysis_json!==row.analysis_json||current?.review_json!==row.review_json||current.status!=='ready')throw new Error('Material changed during projection');
      await publishSentenceMaterials(tx,row,input,analysis,new Date());
    });
    results.push({materialId:row.id,status:'ready',sentences:cards.length,derivedChinese:cards.filter(c=>c.meaningOrigin==='derived_from_english').length,longUnits:cards.filter(c=>c.english.split(/\s+/).length>50).map(c=>c.sentenceId)});
  }catch(error){results.push({materialId:row.id,status:'unavailable',reason:error instanceof Error?error.message:'projection failed'});}
}
const report={at:new Date().toISOString(),networkCalls:0,apply,materials:rows.length,sentences:results.reduce((n,r)=>n+(r.sentences??0),0),unavailable:results.filter(r=>r.status!=='ready').length,results};
const directory=path.resolve(allowMock?'test-results/sentence-materials':'data/imports/private/sentence-materials');fs.mkdirSync(directory,{recursive:true});const reportPath=path.join(directory,`projection-${Date.now()}.json`);fs.writeFileSync(reportPath,JSON.stringify(report,null,2));
console.log(JSON.stringify({materials:report.materials,sentences:report.sentences,unavailable:report.unavailable,networkCalls:0,apply,reportPath}));if(report.unavailable)process.exitCode=1;
