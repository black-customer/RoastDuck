/** Local-only inventory. Never initializes the source database or creates Runtime providers. */
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import {hash} from './shared';
import {sha256Text} from '@/lib/platform/hash';
import {materialSourceHash} from './revision-source';
import type {MaterialInput,MaterialRow} from './material-types';
import {recoverySourceSchema} from './offline-contracts';
import {currentReadyMaterialPredicate} from '../light-study/current-material';

const segments=(text:string)=>Array.from(text.matchAll(/[^.!?。！？\n]+[.!?。！？\n]*|[.!?。！？\n]+/g)).map((match,index)=>({index,start:match.index,end:match.index+match[0].length,text:match[0]}));

export function exportCurrentMaterialReview(root=process.cwd()){
  const directory=path.resolve(root,'data/imports/private/usability-material-review');
  const database=new DatabaseSync(path.resolve(root,'data/app.db'),{readOnly:true});
  try{
    database.exec('BEGIN');
    const materials=database.prepare(`SELECT pm.* FROM practice_materials pm WHERE pm.status='ready' AND ${currentReadyMaterialPredicate}
      AND NOT EXISTS(SELECT 1 FROM practice_answer_sources pas JOIN personal_answers pa ON pa.id=pas.answer_id WHERE pas.attempt_id=pm.source_id AND pa.superseded_by_revision_id IS NOT NULL)
      ORDER BY pm.source_type,pm.source_id,pm.id`).all() as unknown as MaterialRow[];
    const exports=materials.map((material,index)=>{
      const input=JSON.parse(material.input_json) as MaterialInput,sourceHash=materialSourceHash(input);
      const previous={materialId:material.id,inputHash:material.input_hash,analysisHash:hash(material.analysis_json),sourceHash};
      const items=database.prepare('SELECT mi.row_index rowIndex,i.id learningItemId,i.canonical_key canonicalKey,i.target_english targetEnglish,i.intention_zh intentionZh FROM practice_material_items mi JOIN learning_items i ON i.id=mi.learning_item_id WHERE mi.material_id=? ORDER BY mi.row_index').all(material.id);
      const original=input.sourceType==='ielts_practice'?database.prepare('SELECT id,question_id,answer_text,intended_meaning_zh,mode,created_at FROM speaking_question_attempts WHERE id=?').get(input.sourceId):null;
      const source=input.sourceType==='ielts_practice'&&input.question&&original?recoverySourceSchema.parse({key:input.sourceId,kind:'attempt',createdAt:original.created_at,questionId:input.question.id,questionEn:input.question.textEn,questionZh:input.question.textZh,part:input.question.part,english:input.actualAnswer,chinese:input.intendedMeaningZh,mode:input.mode,index,hash:sourceHash,spokenStyleVersion:'personal-spoken-v2',...(input.selectionPolicyVersion?{selectionPolicyVersion:input.selectionPolicyVersion}:{}),...(input.inputFormat?{inputFormat:input.inputFormat,rawInput:input.rawInput}:{}),en:segments(input.actualAnswer),zh:segments(input.intendedMeaningZh)}):null;
      return {index,previous,source,input,original,analysis:JSON.parse(material.analysis_json),items,createdAt:material.created_at};
    });
    database.exec('COMMIT');
    const sourceFiles=['src/lib/four-step/stage-contracts.ts','src/lib/four-step/selection-contracts.ts','src/lib/four-step/revision-source.ts','src/lib/four-step/export-material-review.ts','src/lib/speaking-practice/schemas.ts','pipeline/prompts/four_step_material.generator.v4.md','pipeline/prompts/four_step_material.reviewer.v4.md'];
    const snapshot={version:1,exportedAt:new Date().toISOString(),sourceReadOnly:true,networkCalls:0,sourceCode:sourceFiles.map(file=>({file,sha256:sha256Text(fs.readFileSync(path.resolve(root,file),'utf8'))})),materials:exports};
    fs.mkdirSync(directory,{recursive:true});
    const output=path.join(directory,`snapshot-${snapshot.exportedAt.replace(/[:.]/g,'-')}.json`);
    fs.writeFileSync(output,JSON.stringify(snapshot,null,2)+'\n',{flag:'wx'});
    return {path:output,materials:exports.length,learningItems:exports.reduce((total,material)=>total+material.items.length,0),networkCalls:0,sourceReadOnly:true};
  }finally{database.close();}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(exportCurrentMaterialReview()));
