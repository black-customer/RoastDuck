import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync,backup} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {nodeDatabase} from '../src/lib/platform/node/database';
import type {DatabasePort,SqlReader} from '../src/lib/platform/database';
import {query as sql} from '../src/lib/platform/sql';
import {compileSentenceEdition,applySentenceEdition} from '../src/lib/sentence-study/editions';
import type {MaterialRow} from '../src/lib/four-step/material-types';
const root=path.resolve('data/imports/private/sentence-materials'),apply=process.argv.includes('--apply');
const read=(file:string)=>JSON.parse(fs.readFileSync(file,'utf8'));
const snapshot=read(path.join(root,'reviewer/snapshot.json'));
async function protectedHash(tx:SqlReader){const records=await Promise.all(['light_study_progress','light_study_events','expression_preferences','speaking_question_attempts','four_step_sessions'].map(table=>tx.all({sql:`SELECT * FROM ${table}`})));return createHash('sha256').update(JSON.stringify(records)).digest('hex');}
const database:DatabasePort={read:work=>nodeDatabase.read(work),write:work=>nodeDatabase.write(async tx=>{const before=await protectedHash(tx),result=await work(tx);if(before!==await protectedHash(tx))throw new Error('Protected answers/legacy learning changed');return result;})};
let backupPath:string|null=null;
if(apply){const url=process.env.ROASTDUCK_DB??'file:./data/app.db';if(!url.startsWith('file:'))throw new Error('Local database only');const source=new DatabaseSync(path.resolve(url.slice(5)),{readOnly:true});backupPath=path.resolve('data/backups',`app.db.sentence-editions.${Date.now()}.bak`);try{await backup(source,backupPath);}finally{source.close();}}
const results=[];
for(const item of snapshot.materials){
  const batch=item.index<50?'a':'b',name=String(item.index).padStart(3,'0');
  const candidate=read(path.join(root,`author-${batch}/candidate-${name}.json`)),review=read(path.join(root,`review-${batch}/review-${name}.json`));
  const [material]=await nodeDatabase.read(tx=>tx.all<MaterialRow>(sql`SELECT * FROM practice_materials WHERE id=${item.materialId}`));
  const compiled=compileSentenceEdition(material,candidate,review);
  if(new Set(compiled.cards.map(c=>c.id)).size!==compiled.cards.length)throw new Error(`Duplicate sentence identity: ${item.index}`);
  const result=apply?await applySentenceEdition(database,candidate,review):{};
  results.push({index:item.index,materialId:material.id,sentences:compiled.cards.length,attention:compiled.attention.length,...result});
}
const report={at:new Date().toISOString(),mode:apply?'apply':'check',networkCalls:0,backupPath,materials:results.length,sentences:results.reduce((n,r)=>n+r.sentences,0),attention:results.reduce((n,r)=>n+r.attention,0),protectedRecordsUnchanged:apply,results};
const file=path.join(root,`${apply?'apply':'coverage'}-${Date.now()}.json`);fs.writeFileSync(file,JSON.stringify(report,null,2));console.log(JSON.stringify({...report,results:undefined,reportPath:file}));
