import {beforeAll,expect,it,vi} from 'vitest';
import {sql} from 'drizzle-orm';
import {prepareTestDatabase,assertInsideTestResults} from '../helpers/temp-db';
const temporary=prepareTestDatabase('current-material-retry');assertInsideTestResults(temporary.file);
process.env.ROASTDUCK_DB=temporary.url;process.env.ROASTDUCK_SKIP_DB_BACKUP='1';process.env.AI_PROVIDER='mock';
const background=vi.hoisted(()=>[] as Array<()=>Promise<void>>);
vi.mock('next/server',async original=>({...await original<typeof import('next/server')>(),after:(work:()=>Promise<void>)=>background.push(work)}));
let route:typeof import('@/app/api/materials/[id]/route'),retryRoute:typeof import('@/app/api/speaking-practice/attempts/[id]/retry/route');
const request=(url:string)=>new Request('http://127.0.0.1:3001'+url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({retryUnknown:false})});
beforeAll(async()=>{route=await import('@/app/api/materials/[id]/route');retryRoute=await import('@/app/api/speaking-practice/attempts/[id]/retry/route');});
async function oldFailure(id:string){
  const {getDbReady}=await import('@db/client'),db=await getDbReady();
  await db.run(sql`INSERT INTO questions(id,book_id,part,text,text_zh,norm_text) VALUES(${id+'q'},'retired',1,'Do you live alone?','你一个人住吗？',${id+'q'})`);
  await db.run(sql`INSERT INTO speaking_question_attempts(id,question_id,mode,answer_text,intended_meaning_zh,status) VALUES(${id},${id+'q'},'practice',${"I'm used to live alone."},'我已经习惯一个人住了。','failed')`);
  const {webCompanion}=await import('@/lib/app-services/web');const material=await webCompanion().materials.prepare({sourceType:'ielts_practice',sourceId:id,question:{id:id+'q',textEn:'Do you live alone?',textZh:'你一个人住吗？',part:1},mode:'practice',actualAnswer:"I'm used to live alone.",intendedMeaningZh:'我已经习惯一个人住了。',spokenStyleVersion:'personal-spoken-v2',selectionPolicyVersion:'evidence-exclusion-v1',sentenceStudyVersion:'sentence-material-v1'});
  await db.run(sql`UPDATE practice_materials SET status='failed',error_code='material_review_rejected',review_json='{"approved":false,"reasonZh":"needs alignment","rows":[]}' WHERE id=${material.id}`);
  return {db,material};
}
it('actual material retry returns a successor and GET on the old URL follows it without starting work',async()=>{
  const {db,material}=await oldFailure('material-route-attempt');
  const before=await route.GET(new Request('http://127.0.0.1:3001'),{params:Promise.resolve({id:material.id})});expect((await before.json()).material.id).toBe(material.id);expect(background).toHaveLength(0);
  const response=await route.POST(request('/api/materials/'+material.id),{params:Promise.resolve({id:material.id})});expect(response.status).toBe(202);
  const body=await response.json();expect(body.materialId).not.toBe(material.id);expect(body.transition).toMatchObject({fromMaterialId:material.id,toMaterialId:body.materialId});
  const get=await route.GET(new Request('http://127.0.0.1:3001'),{params:Promise.resolve({id:material.id})});expect((await get.json()).material).toMatchObject({id:body.materialId,status:'queued'});expect(background).toHaveLength(1);
  const duplicate=await route.POST(request('/api/materials/'+material.id),{params:Promise.resolve({id:material.id})});expect((await duplicate.json()).materialId).toBe(body.materialId);
  expect(await db.all(sql`SELECT id FROM practice_materials WHERE source_id='material-route-attempt'`)).toHaveLength(2);
  for(const work of background.splice(0))await work();
  const completed=await route.GET(new Request('http://127.0.0.1:3001'),{params:Promise.resolve({id:material.id})}),result=await completed.json();expect(result.verified).toBe(true);expect(result.material.id).toBe(body.materialId);
  const [old]=await db.all<{status:string;review_json:string}>(sql`SELECT status,review_json FROM practice_materials WHERE id=${material.id}`);expect(old.status).toBe('failed');expect(JSON.parse(old.review_json).approved).toBe(false);
});
it('actual attempt retry stays on the same saved Attempt and binds the current generation contract',async()=>{
  const {db,material}=await oldFailure('attempt-route-attempt');
  const response=await retryRoute.POST(request('/api/speaking-practice/attempts/attempt-route-attempt/retry'),{params:Promise.resolve({id:'attempt-route-attempt'})});expect(response.status).toBe(202);
  const body=await response.json();expect(body.attempt.id).toBe('attempt-route-attempt');expect(body.attempt.materialId).not.toBe(material.id);
  const [next]=await db.all<{input_json:string}>(sql`SELECT input_json FROM practice_materials WHERE id=${body.attempt.materialId}`);expect(JSON.parse(next.input_json)).toMatchObject({registerProfileVersion:'young-us-v1',actualAnswer:"I'm used to live alone.",runtimeRevision:{parentMaterialId:material.id}});
  for(const work of background.splice(0))await work();
  const {getSpeakingAttempt}=await import('@/lib/speaking-practice/service');const actual=await getSpeakingAttempt('attempt-route-attempt');expect(actual?.materialStatus).toBe('ready');expect(actual?.materialTransition?.fromMaterialId).toBe(material.id);
  expect(await db.all(sql`SELECT id FROM speaking_question_attempts WHERE id='attempt-route-attempt'`)).toHaveLength(1);
});
