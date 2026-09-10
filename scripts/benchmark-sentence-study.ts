import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync,backup} from 'node:sqlite';
const root=path.resolve('test-results/sentence-performance');fs.mkdirSync(root,{recursive:true});
const file=path.join(root,`snapshot-${Date.now()}.db`),source=new DatabaseSync(path.resolve('data/app.db'),{readOnly:true});
try{await backup(source,file);}finally{source.close();}
const scale=process.argv.includes('--scale=10')?10:1;
if(scale>1){
  const clone=new DatabaseSync(file),{materialFingerprint}=await import('../src/lib/light-study/core-catalogue'),{sentenceDisplayVersion}=await import('../src/lib/sentence-study/materials');
  type Row=Record<string,string|number|null>;
  const originals=clone.prepare("SELECT pm.* FROM practice_materials pm JOIN material_validation_cache v ON v.material_id=pm.id WHERE pm.status='ready' AND v.valid=1").all() as Row[];
  const insert=(table:string,row:Row)=>{const keys=Object.keys(row);clone.prepare(`INSERT INTO "${table}" (${keys.map(k=>`"${k}"`).join(',')}) VALUES (${keys.map(()=>'?').join(',')})`).run(...keys.map(k=>row[k]));};
  clone.exec('BEGIN');
  try{for(let batch=1;batch<scale;batch++){
    const copiedQuestions=new Set<string>(),copiedAttempts=new Set<string>();
    for(const original of originals){
      if(original.source_type!=='ielts_practice')continue;
      const tag=`_synthetic_perf_${batch}`,qid=String(original.question_id)+tag,sid=String(original.source_id)+tag,mid=String(original.id)+tag;
      if(!copiedQuestions.has(qid)){const q=clone.prepare('SELECT * FROM questions WHERE id=?').get(original.question_id) as Row;insert('questions',{...q,id:qid,norm_text:String(q.norm_text)+tag});copiedQuestions.add(qid);}
      if(!copiedAttempts.has(sid)){const a=clone.prepare('SELECT * FROM speaking_question_attempts WHERE id=?').get(original.source_id) as Row;insert('speaking_question_attempts',{...a,id:sid,question_id:qid});copiedAttempts.add(sid);}
      const input=JSON.parse(String(original.input_json));input.sourceId=sid;input.question.id=qid;input.syntheticBenchmark=true;
      const m={...original,id:mid,source_id:sid,question_id:qid,input_json:JSON.stringify(input)};insert('practice_materials',m);
      const cache=clone.prepare('SELECT * FROM material_validation_cache WHERE material_id=?').get(original.id) as Row;insert('material_validation_cache',{...cache,material_id:mid,fingerprint:materialFingerprint(m as never),result_json:'{"syntheticBenchmark":true}'});
      for(const u of clone.prepare('SELECT * FROM sentence_learning_units WHERE material_id=? AND active=1').all(original.id) as Row[]){
        const card=JSON.parse(String(u.body_json));card.id+=tag;card.materialId=mid;card.source.id=sid;card.source.questionId=qid;card.source.title='放大数据性能样本';card.version=sentenceDisplayVersion({materialId:mid,chinese:card.chinese,english:card.english,contextZh:card.contextZh,meaningOrigin:card.meaningOrigin,usages:card.usages,notes:card.notes});
        insert('sentence_learning_units',{...u,id:card.id,material_id:mid,source_id:sid,question_id:qid,version:card.version,body_json:JSON.stringify(card)});
      }
    }
  }clone.exec('COMMIT');}catch(e){clone.exec('ROLLBACK');throw e;}finally{clone.close();}
}
process.env.ROASTDUCK_DB='file:./'+path.relative(process.cwd(),file).replaceAll('\\','/');process.env.AI_PROVIDER='mock';process.env.MIMO_API_KEY='';process.env.DEEPSEEK_API_KEY='';process.env.ROASTDUCK_SKIP_DB_BACKUP='1';
const {nodeDatabase}=await import('../src/lib/platform/node/database');
const {createSentenceService}=await import('../src/lib/sentence-study/core-service');
const {query:sql}=await import('../src/lib/platform/sql');
const service=createSentenceService(nodeDatabase,{now:()=>new Date(),newId:randomUUID});
const measurements:Record<string,number[]>={overview:[],create:[],reveal:[],rate:[],resume:[]};
async function measure<T>(name:string,work:()=>Promise<T>){const at=performance.now(),value=await work();measurements[name].push(performance.now()-at);return value;}
const initial=await service.overview();
for(let i=0;i<20;i++){
  const data=await measure('overview',()=>service.overview()),source=data.sources.find(s=>s.newCount>0&&s.type==='question');if(!source)break;
  let v=await measure('create',()=>service.create({scope:{type:'question',id:source.id},mode:'learn',clientRequestId:randomUUID()}));
  const card=v.cards[v.index];v=await measure('reveal',()=>service.event(v.id,{type:'reveal',version:v.version,clientEventId:randomUUID(),sentenceId:card.id,unitVersion:card.version}));
  v=await measure('rate',()=>service.event(v.id,{type:'rate',version:v.version,clientEventId:randomUUID(),sentenceId:card.id,unitVersion:card.version,rating:'remembered'}));
  if(v.status!=='completed'){v=await service.event(v.id,{type:'pause',version:v.version,clientEventId:randomUUID()});v=await measure('resume',()=>service.event(v.id,{type:'resume',version:v.version,clientEventId:randomUUID()}));}
}
const [{materials}]=await nodeDatabase.read(tx=>tx.all<{materials:number}>(sql`SELECT count(*) materials FROM sentence_material_editions`));
const results=Object.fromEntries(Object.entries(measurements).map(([name,values])=>{const sorted=[...values].sort((a,b)=>a-b);return [name,{n:values.length,p50:sorted[Math.floor(sorted.length*.5)]??null,p95:sorted[Math.min(sorted.length-1,Math.floor(sorted.length*.95))]??null,max:sorted.at(-1)??null}];}));
const report={at:new Date().toISOString(),networkCalls:0,scale,syntheticScale:scale>1,isolatedDatabase:path.relative(process.cwd(),file),currentSourceMaterials:materials,eligibleSentences:initial.totalCount,results};
fs.writeFileSync(path.join(root,`latest-${scale}x.json`),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
