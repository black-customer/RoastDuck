import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {currentReadyMaterialPredicate} from '../src/lib/light-study/current-material';

const root=path.resolve('data/imports/private/sentence-teaching-v1');
if(fs.existsSync(path.join(root,'inventory.json')))throw new Error('Inventory already exists; preserve this run and choose a new version explicitly.');
const db=new DatabaseSync(path.resolve('data/app.db'),{readOnly:true});
const materials=db.prepare(`SELECT pm.id,pm.source_id,pm.source_type,pm.question_id,pm.input_json,pm.analysis_json,COALESCE(q.text,'对话') title FROM practice_materials pm LEFT JOIN questions q ON q.id=pm.question_id WHERE pm.status='ready' AND pm.contract_version='evidence_v2' AND ${currentReadyMaterialPredicate} AND EXISTS(SELECT 1 FROM sentence_learning_units u WHERE u.material_id=pm.id AND u.active=1) ORDER BY pm.id`).all();
fs.mkdirSync(path.join(root,'source'),{recursive:true});
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const manifest=materials.map((raw,index)=>{
  const m=raw as unknown as {id:string;input_json:string;analysis_json:string;title:string};
  const cards=db.prepare('SELECT body_json FROM sentence_learning_units WHERE material_id=? AND active=1 ORDER BY ordinal,id').all(m.id).map(row=>JSON.parse(row.body_json as string));
  const body={index,materialId:m.id,title:m.title,source:JSON.parse(m.input_json),sourceHash:hash(m.input_json),analysisHash:hash(m.analysis_json),cards};
  const file=`source/${String(index).padStart(3,'0')}.json`;
  fs.writeFileSync(path.join(root,file),JSON.stringify(body,null,2));
  return {index,materialId:m.id,title:m.title,count:cards.length,file,sourceHash:body.sourceHash,analysisHash:body.analysisHash};
});
const inventory={at:new Date().toISOString(),materials:manifest.length,sentences:manifest.reduce((n,m)=>n+m.count,0),entries:manifest};
fs.writeFileSync(path.join(root,'inventory.json'),JSON.stringify(inventory,null,2));
db.close();
console.log(JSON.stringify({materials:inventory.materials,sentences:inventory.sentences,path:path.join(root,'inventory.json'),networkCalls:0}));
