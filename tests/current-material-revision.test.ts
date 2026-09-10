import {afterEach,expect,it} from 'vitest';
import {portableTestDatabase} from './helpers/portable-db';
import {prepareMaterialIn} from '@/lib/four-step/core-materials';
import {prepareCurrentMaterialRetry,resolveCurrentMaterial} from '@/lib/four-step/current-revision';
import {materialStageContracts} from '@/lib/four-step/stage-contracts';
import type {MaterialInput} from '@/lib/four-step/material-types';
const fixtures:Array<ReturnType<typeof portableTestDatabase>>=[];
afterEach(()=>fixtures.splice(0).forEach(f=>f.close()));
const at=new Date('2026-09-11T10:00:00.000Z');
async function setup(extra:Partial<MaterialInput>={}){
  const f=portableTestDatabase();fixtures.push(f);
  const source:MaterialInput={sourceType:'ielts_practice',sourceId:'retry-attempt',question:{id:'retry-q',textEn:'What do you read?',textZh:'你读什么？',part:1},mode:'practice',actualAnswer:'I read comics. 我读漫画，也看动画。',intendedMeaningZh:'',rawInput:'I read comics. 我读漫画，也看动画。',inputFormat:'mixed-v1',spokenStyleVersion:'personal-spoken-v2',selectionPolicyVersion:'evidence-exclusion-v1',sentenceStudyVersion:'sentence-material-v1',...extra};
  f.connection.prepare("INSERT INTO questions(id,book_id,part,text,text_zh,norm_text) VALUES('retry-q','retired',1,'What do you read?','你读什么？','retry-q')").run();
  f.connection.prepare("INSERT INTO speaking_question_attempts(id,question_id,mode,answer_text,intended_meaning_zh,status,created_at,updated_at) VALUES('retry-attempt','retry-q','practice',?,?,'failed',?,?)").run(source.actualAnswer,source.intendedMeaningZh,at.toISOString(),at.toISOString());
  const original=await f.database.write(tx=>prepareMaterialIn(tx,source,at.toISOString()));
  f.connection.prepare("UPDATE practice_materials SET status='failed',error_code='material_review_rejected',review_json=? WHERE id=?").run(JSON.stringify({approved:false,reasonZh:'原意漏掉了动画',rows:[]}),original.id);
  f.connection.prepare("INSERT INTO practice_material_stages(run_id,material_id,stage,prompt_version,input_hash,input_json,output_json,status,created_at) VALUES('old-review',?,'review','sentence_material.reviewer.v1.md','old-stage-hash','{}',?,'rejected',?)").run(original.id,JSON.stringify({approved:false,reasonZh:'原意需要修正',rows:[]}),at.toISOString());
  return {...f,source,original};
}
it('explicit failed-contract retry appends one new material while retaining the same raw answer and rejected evidence',async()=>{
  const f=await setup(),old=f.connection.prepare('SELECT * FROM practice_materials WHERE id=?').get(f.original.id),oldStages=f.connection.prepare('SELECT * FROM practice_material_stages').all();
  const next=await prepareCurrentMaterialRetry(f.database,f.original.id,at);
  expect(next.created).toBe(true);expect(next.material.id).not.toBe(f.original.id);expect(next.material.source_id).toBe(f.source.sourceId);
  const updated=JSON.parse(next.material.input_json);expect(updated).toMatchObject({...f.source,registerProfileVersion:'young-us-v1',runtimeRevision:{parentMaterialId:f.original.id,parentInputHash:f.original.input_hash}});
  expect(materialStageContracts(updated).diagnosis.prompt).toBe('sentence_intention.generator.v2.md');
  expect(f.connection.prepare('SELECT * FROM practice_materials WHERE id=?').get(f.original.id)).toEqual(old);
  expect(f.connection.prepare('SELECT * FROM practice_material_stages').all()).toEqual(oldStages);
  expect(f.connection.prepare('SELECT answer_text,intended_meaning_zh FROM speaking_question_attempts').all()).toEqual([{answer_text:f.source.actualAnswer,intended_meaning_zh:''}]);
  expect(f.connection.prepare('SELECT * FROM ai_runs').all()).toHaveLength(0);
  expect(f.connection.prepare('SELECT * FROM practice_material_stages WHERE material_id=?').all(next.material.id)).toHaveLength(0);
  expect(next.material.created_at>f.original.created_at).toBe(true);
});
it('GET only follows a saved successor and concurrent retries cannot produce duplicate versions',async()=>{
  const f=await setup();expect((await resolveCurrentMaterial(f.database,f.original.id)).material.id).toBe(f.original.id);expect(f.connection.prepare('SELECT * FROM practice_materials').all()).toHaveLength(1);
  const [a,b]=await Promise.all([prepareCurrentMaterialRetry(f.database,f.original.id,at),prepareCurrentMaterialRetry(f.database,f.original.id,at)]);
  expect(a.material.id).toBe(b.material.id);expect([a.created,b.created].filter(Boolean)).toHaveLength(1);
  const view=await resolveCurrentMaterial(f.database,f.original.id);expect(view.transition).toMatchObject({fromMaterialId:f.original.id,toMaterialId:a.material.id});
  await prepareCurrentMaterialRetry(f.database,a.material.id,at);expect(f.connection.prepare('SELECT * FROM practice_materials').all()).toHaveLength(2);
});
it('a failed current-contract task retains its valid checkpoints and exact snapshot',async()=>{
  const f=await setup({registerProfileVersion:'young-us-v1'}),before=f.connection.prepare('SELECT * FROM practice_materials').all(),stages=f.connection.prepare('SELECT * FROM practice_material_stages').all();
  const value=await prepareCurrentMaterialRetry(f.database,f.original.id,at);expect(value.material.id).toBe(f.original.id);expect(value.created).toBe(false);
  expect(f.connection.prepare('SELECT * FROM practice_materials').all()).toEqual(before);expect(f.connection.prepare('SELECT * FROM practice_material_stages').all()).toEqual(stages);
});
it('an already prepared current contract for the identical saved source is reused by an old link',async()=>{
  const f=await setup(),existing=await f.database.write(tx=>prepareMaterialIn(tx,{...f.source,registerProfileVersion:'young-us-v1'},'2026-09-11T10:00:01Z'));
  const result=await prepareCurrentMaterialRetry(f.database,f.original.id,at);expect(result.material.id).toBe(existing.id);expect(result.created).toBe(false);
  expect((await resolveCurrentMaterial(f.database,f.original.id)).material.id).toBe(existing.id);expect(f.connection.prepare('SELECT * FROM practice_materials').all()).toHaveLength(2);
});
it('active old leases, uncertain receipts, changed original answers and withdrawn content are guarded',async()=>{
  const f=await setup();f.connection.prepare('UPDATE practice_materials SET lease_until=? WHERE id=?').run('2026-09-11T10:10:00Z',f.original.id);
  await expect(prepareCurrentMaterialRetry(f.database,f.original.id,at)).rejects.toMatchObject({code:'material_analysis_running'});
  f.connection.prepare("UPDATE practice_materials SET lease_until=NULL,error_code='result_unknown' WHERE id=?").run(f.original.id);
  await expect(prepareCurrentMaterialRetry(f.database,f.original.id,at)).rejects.toMatchObject({code:'result_unknown'});
  f.connection.prepare("UPDATE practice_materials SET error_code='material_review_rejected' WHERE id=?").run(f.original.id);
  f.connection.prepare("UPDATE speaking_question_attempts SET answer_text='changed' WHERE id='retry-attempt'").run();
  await expect(prepareCurrentMaterialRetry(f.database,f.original.id,at)).rejects.toMatchObject({code:'material_source_changed'});
  f.connection.prepare("UPDATE practice_materials SET status='hidden' WHERE id=?").run(f.original.id);
  await expect(prepareCurrentMaterialRetry(f.database,f.original.id,at)).rejects.toMatchObject({code:'material_unavailable'});
  expect(f.connection.prepare('SELECT * FROM practice_materials').all()).toHaveLength(1);
});
it('an explicitly confirmed unknown retry can create a successor; no network is triggered by preparing it',async()=>{
  const f=await setup();f.connection.prepare("UPDATE practice_materials SET error_code='result_unknown' WHERE id=?").run(f.original.id);
  const next=await prepareCurrentMaterialRetry(f.database,f.original.id,at,{retryUnknown:true});expect(next.created).toBe(true);expect(f.connection.prepare('SELECT * FROM ai_runs').all()).toHaveLength(0);
});
it('ready old content is left alone and previously published failed content is not silently regenerated',async()=>{
  const f=await setup();f.connection.prepare("UPDATE practice_materials SET status='ready' WHERE id=?").run(f.original.id);
  expect((await prepareCurrentMaterialRetry(f.database,f.original.id,at)).created).toBe(false);
  f.connection.prepare("UPDATE practice_materials SET status='failed' WHERE id=?").run(f.original.id);
  f.connection.prepare('INSERT INTO practice_material_items(material_id,learning_item_id,row_index) VALUES(?,?,0)').run(f.original.id,'previously-learned');
  await expect(prepareCurrentMaterialRetry(f.database,f.original.id,at)).rejects.toMatchObject({code:'material_previously_published'});
});
it('offline revision remains offline instead of using a contract upgrade to spend Runtime',async()=>{
  const f=await setup({offlineRevision:{parentMaterialId:'original',parentInputHash:'hash',parentAnalysisHash:'analysis',sourceHash:'source',artifactHash:'artifact'}});
  await expect(prepareCurrentMaterialRetry(f.database,f.original.id,at)).rejects.toMatchObject({code:'offline_revision_required'});
});
it('a malformed successor cannot redirect an old material link to a different original intention',async()=>{
  const f=await setup(),next=await prepareCurrentMaterialRetry(f.database,f.original.id,at),source=JSON.parse(next.material.input_json);
  f.connection.prepare('UPDATE practice_materials SET input_json=? WHERE id=?').run(JSON.stringify({...source,actualAnswer:'different intent'}),next.material.id);
  await expect(resolveCurrentMaterial(f.database,f.original.id)).rejects.toMatchObject({code:'material_successor_conflict'});
});
