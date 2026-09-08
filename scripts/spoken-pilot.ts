/** Explicit offline 10-question pilot. No Runtime provider is created. Originals are immutable. */
import fs from 'node:fs';
import path from 'node:path';
import {createClient} from '@libsql/client';
import {hash} from '../src/lib/four-step/shared';
import {recoverySourceSchema} from '../src/lib/four-step/offline-contracts';
import {authoredMaterialSchema,offlineReviewSchema} from '../src/lib/four-step/offline-contracts';

const directory=path.resolve('data/imports/private/spoken-pilot-v1');
const mode=process.argv[2]??'status';
const location=path.join(directory,'sources.json');
if(mode==='export'){
  if(fs.existsSync(location))throw new Error('Pilot snapshot exists; use status, do not overwrite original sources');
  const client=createClient({url:process.env.ROASTDUCK_DB??'file:./data/app.db'});
  await client.execute('PRAGMA query_only=ON');
  const rows=(await client.execute(`SELECT a.*,q.text question_en,q.text_zh question_zh,q.part,q.topic_id FROM speaking_question_attempts a JOIN questions q ON q.id=a.question_id WHERE length(a.answer_text)+length(a.intended_meaning_zh) BETWEEN 120 AND 2400 ORDER BY (length(a.intended_meaning_zh)>0) DESC, a.updated_at DESC,a.id`)).rows;
  const chosen:typeof rows=[],topics=new Set();
  for(const row of rows){if(chosen.some(v=>v.question_id===row.question_id))continue;if(topics.has(row.topic_id)&&chosen.length<7)continue;chosen.push(row);topics.add(row.topic_id);if(chosen.length===10)break;}
  for(const row of rows){if(chosen.length===10)break;if(!chosen.some(v=>v.question_id===row.question_id))chosen.push(row);}
  if(chosen.length!==10)throw new Error('Need ten distinct source questions');
  const segments=(text:string)=>Array.from(text.matchAll(/[^.!?。！？\n]+[.!?。！？\n]*|[.!?。！？\n]+/g)).map((m,index)=>({index,start:m.index!,end:m.index!+m[0].length,text:m[0]}));
  const sources=chosen.map((r,index)=>{const base={key:String(r.id),kind:'attempt' as const,createdAt:String(r.created_at),questionId:String(r.question_id),questionEn:String(r.question_en),questionZh:String(r.question_zh),part:Number(r.part),english:String(r.answer_text),chinese:String(r.intended_meaning_zh),mode:String(r.mode),index,spokenStyleVersion:'personal-spoken-v1' as const};return recoverySourceSchema.parse({...base,hash:hash(JSON.stringify(base)),en:segments(base.english),zh:segments(base.chinese)});});
  fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(location,JSON.stringify(sources,null,2)+'\n',{flag:'wx'});client.close();
  console.log(JSON.stringify({sources:sources.length,characters:sources.map(s=>({index:s.index,en:s.english.length,zh:s.chinese.length})),networkCalls:0}));
}else if(mode==='validate'||mode==='apply'){
  const {compileOfflineMaterial,applyOfflineMaterial}=await import('../src/lib/four-step/offline-apply');
  const sources=JSON.parse(fs.readFileSync(location,'utf8')) as unknown[];
  const candidates=JSON.parse(fs.readFileSync(path.join(directory,'candidates.json'),'utf8')) as Array<{source:unknown;author:unknown}>;
  const reviews=JSON.parse(fs.readFileSync(path.join(directory,'reviews.json'),'utf8')) as Array<{index:number}>;
  if(candidates.length!==10||new Set(candidates.map(c=>recoverySourceSchema.parse(c.source).index)).size!==10)throw new Error('Pilot must contain exactly ten distinct source snapshots');
  const prepared=candidates.map(c=>{
    const source=recoverySourceSchema.parse(c.source),author=authoredMaterialSchema.parse(c.author),review=offlineReviewSchema.parse(reviews.find(r=>r.index===source.index));
    if(JSON.stringify(c.source)!==JSON.stringify(sources[source.index]))throw new Error(`Source snapshot changed: ${source.index}`);
    return compileOfflineMaterial(source,author,review);
  });
  const progressDigest=async()=>{const client=createClient({url:process.env.ROASTDUCK_DB??'file:./data/app.db'});try{await client.execute('PRAGMA query_only=ON');return hash(JSON.stringify((await client.execute('SELECT learning_item_id,first_seen_at,last_seen_at,due_at,fsrs_json,review_count,version,last_rating FROM light_study_progress ORDER BY learning_item_id')).rows));}finally{client.close();}};
  const before=mode==='apply'?await progressDigest():null,results=[];
  for(const item of prepared){const result=mode==='apply'?await applyOfflineMaterial(item.source,item.author,item.review):null;results.push({index:item.source.index,rows:item.analysis.learningMaterials.length,confirmedErrors:item.analysis.gapCount,attention:item.analysis.needsAttention?.length??0,publication:result});}
  const after=mode==='apply'?await progressDigest():null;
  const report={mode,networkCalls:0,progressUnchanged:before===after,results};
  fs.writeFileSync(path.join(directory,`${mode}-report.json`),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));if(before!==after)throw new Error('Unexpected progress change: original progress must be investigated, never silently reset');
}else if(mode==='status'){
  console.log(JSON.stringify({exists:fs.existsSync(location),files:fs.existsSync(directory)?fs.readdirSync(directory):[],networkCalls:0}));
}else throw new Error('Use export, status, validate or apply');
