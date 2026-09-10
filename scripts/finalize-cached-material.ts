import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync,backup} from 'node:sqlite';
import {createHash} from 'node:crypto';
import type {SqlReader} from '../src/lib/platform/database';

// This maintenance entry never loads .env.local, a Key or an AI provider.
// It can only publish already received and positively reviewed local records.
const id=process.argv[2];if(!/^pm_[a-zA-Z0-9_-]+$/.test(id??''))throw new Error('Provide the exact material ID');
globalThis.fetch=async()=>{throw new Error('Network is forbidden in cache-only finalization');};
process.env.ROASTDUCK_DB='file:./data/app.db';
const {nodeDatabase}=await import('../src/lib/platform/node/database');
const {finalizeCachedMaterial}=await import('../src/lib/four-step/finalize-cached');
const stamp=Date.now(),backupPath=path.resolve('data/backups',`app.db.cache-publication.${stamp}.bak`);
fs.mkdirSync(path.dirname(backupPath),{recursive:true});const raw=new DatabaseSync('data/app.db',{readOnly:true});try{await backup(raw,backupPath);}finally{raw.close();}
async function protectedHash(tx:SqlReader){
 const digest=createHash('sha256');
 for(const statement of ['SELECT id,question_id,answer_text,intended_meaning_zh,created_at FROM speaking_question_attempts ORDER BY id','SELECT * FROM ai_runs ORDER BY run_id','SELECT * FROM runtime_requests ORDER BY logical_key','SELECT * FROM sentence_study_progress ORDER BY rowid','SELECT * FROM light_study_progress ORDER BY rowid'])digest.update(JSON.stringify(await tx.all({sql:statement})));
 return digest.digest('hex');
}
const result=await nodeDatabase.write(async tx=>{
 const before=await protectedHash(tx),stageBefore=await tx.all({sql:'SELECT run_id,status,input_hash,output_json FROM practice_material_stages WHERE material_id=? ORDER BY run_id',args:[id]});
 const finalized=await finalizeCachedMaterial({read:work=>work(tx),write:work=>work(tx)},id);
 if(before!==await protectedHash(tx))throw new Error('Original answers, AI receipts or learning progress changed; rolled back');
 return {...finalized,stageBefore,protectedRecordsUnchanged:true};
});
const directory=path.resolve('data/imports/private/cache-publication');fs.mkdirSync(directory,{recursive:true});
fs.writeFileSync(path.join(directory,`${stamp}.json`),JSON.stringify({at:new Date().toISOString(),backupPath,...result},null,2));
console.log(JSON.stringify({...result,stageBefore:undefined,backupPath}));
