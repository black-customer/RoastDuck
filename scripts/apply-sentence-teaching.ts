import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync,backup} from 'node:sqlite';
import {nodeDatabase} from '../src/lib/platform/node/database';
import type {SqlReader} from '../src/lib/platform/database';
import {sha256Text} from '../src/lib/platform/hash';
import type {MaterialRow} from '../src/lib/four-step/material-types';
import type {SentenceCard} from '../src/lib/sentence-study/contracts';
import {teachingAuthorSchema,teachingReviewSchema} from '../src/lib/sentence-study/teaching-contracts';
import {compileTeachingEdition,applyTeachingEdition} from '../src/lib/sentence-study/teaching-editions';
import {compileTeachingSentenceRevision,applyTeachingSentenceRevision} from '../src/lib/sentence-study/teaching-revisions';

const root=path.resolve('data/imports/private/sentence-teaching-v1'),apply=process.argv.includes('--apply'),only=process.argv.find(a=>a.startsWith('--indices='))?.slice(10).split(',').map(Number);
const read=(file:string)=>JSON.parse(fs.readFileSync(path.join(root,file),'utf8'));
const inventory=read('inventory.json') as {entries:Array<{index:number;materialId:string;file:string}>};
const protectedTables=['speaking_question_attempts','personal_answers','free_talk_messages','sentence_study_progress','sentence_study_events','light_study_progress','light_study_events','four_step_sessions','expression_preferences','sentence_highlights'];
async function protectedHash(tx:SqlReader){const values=[];for(const table of protectedTables)values.push(await tx.all({sql:'SELECT * FROM '+table+' ORDER BY rowid'}));return sha256Text(JSON.stringify(values));}
let backupPath:string|null=null;
if(apply){backupPath=path.resolve('data/backups','app.db.sentence-teaching.'+Date.now()+'.bak');const db=new DatabaseSync(path.resolve('data/app.db'),{readOnly:true});try{await backup(db,backupPath);}finally{db.close();}}
const results=[];
for(const entry of inventory.entries.filter(e=>!only||only.includes(e.index))){
  const name=String(entry.index).padStart(3,'0'),side=entry.index<52?'a':'b';
  if(!fs.existsSync(path.join(root,'review-'+side+'/'+name+'.json'))){results.push({index:entry.index,status:'awaiting_review'});continue;}
  try{
    const source=read(entry.file) as {cards:SentenceCard[]},author=teachingAuthorSchema.parse(read('author-'+side+'/'+name+'.json')),review=teachingReviewSchema.parse(read('review-'+side+'/'+name+'.json'));
    const [material]=await nodeDatabase.read(tx=>tx.all<MaterialRow>({sql:'SELECT * FROM practice_materials WHERE id=?',args:[entry.materialId]}));
    if(!material||material.status!=='ready')throw new Error('材料已撤销或缺失');
    const parents=await nodeDatabase.read(tx=>tx.all<{id:string;cards_json:string}>({sql:'SELECT id,cards_json FROM sentence_material_editions WHERE material_id=? ORDER BY created_at DESC,id DESC',args:[material.id]}));
    const parent=parents.find(p=>p.cards_json===JSON.stringify(source.cards));
    const revision=author.sentences.some(s=>s.issue)?{version:'sentence-teaching-revision-v1' as const,compilerVersion:'exact-targets-v2' as const,parentEditionId:parent?.id??null,replacesEditionId:parents[0]?.id??null,expectedActiveHash:sha256Text(parents[0]?.cards_json??JSON.stringify(source.cards)),sourceCards:source.cards,author,review}:null;
    const compiled=revision?compileTeachingSentenceRevision(material,revision):null;
    const cards=compiled?.cards??source.cards,mapping=compiled?.mapping??{};
    compileTeachingEdition(material,cards,author,review,mapping,compiled?source.cards:[]);
    if(apply)await nodeDatabase.write(async tx=>{
      const before=await protectedHash(tx);
      const [current]=await tx.all<MaterialRow>({sql:'SELECT * FROM practice_materials WHERE id=?',args:[material.id]});
      if(!current||current.status!=='ready'||current.input_json!==material.input_json||current.analysis_json!==material.analysis_json)throw new Error('处理期间来源改变');
      if(revision)await applyTeachingSentenceRevision(tx,current,revision);
      const live=await tx.all<{id:string;version:string}>({sql:'SELECT id,version FROM sentence_learning_units WHERE material_id=? AND active=1',args:[material.id]});
      if(cards.length!==live.length||cards.some(c=>!live.some(l=>l.id===c.id&&l.version===c.version)))throw new Error('发布期间句子改变');
      await applyTeachingEdition(tx,current,cards,author,review,mapping,compiled?source.cards:[]);
      if(before!==await protectedHash(tx))throw new Error('原回答或学习记录发生意外变化');
    });
    results.push({index:entry.index,status:apply?'published':'validated',sentences:cards.length,attention:compiled?.attention.length??0,revised:author.sentences.filter(s=>s.issue&&!s.issue.needsConfirmation).length});
  }catch(error){results.push({index:entry.index,status:'blocked',error:error instanceof Error?error.message:'invalid'});}
}
const report={at:new Date().toISOString(),mode:apply?'apply':'check',backupPath,networkCalls:0,materials:results.length,sentences:results.reduce((n,r)=>n+(r.sentences??0),0),attention:results.reduce((n,r)=>n+(r.attention??0),0),results};
fs.writeFileSync(path.join(root,(apply?'apply':'coverage')+'-'+Date.now()+'.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({...report,results:results.filter(r=>r.status==='blocked'||r.status==='awaiting_review')}));
if(results.some(r=>r.status==='blocked'||r.status==='awaiting_review'))process.exitCode=1;
