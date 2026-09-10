import {afterEach,describe,it,expect,vi} from 'vitest';
import fs from 'node:fs';
import {portableTestDatabase} from './helpers/portable-db';
import {recallFixture} from './helpers/recall-material';
import {createMaterialService} from '@/lib/four-step/core-materials';
import {createRuntimeCalls} from '@/lib/ai/runtime-ledger';
import {MockAiProvider} from '@/lib/ai/mock-provider';
import {selectionMockResolver} from '@/lib/four-step/selection-mock';
import {applyReviewedOfflineRevision} from '@/lib/four-step/offline-revision';
import {authorHash,type RecoverySource} from '@/lib/four-step/offline-contracts';
import {materialSourceHash} from '@/lib/four-step/revision-source';
import {hash} from '@/lib/four-step/shared';
import {query as sql} from '@/lib/platform/sql';
import type {MaterialInput} from '@/lib/four-step/material-types';
import {auditPracticeMaterials} from '@/lib/four-step/audit';

const open:ReturnType<typeof portableTestDatabase>[]=[];
afterEach(()=>{vi.restoreAllMocks();for(const f of open)f.close();open.length=0;});
async function setup(){
  const f=portableTestDatabase();open.push(f);let sequence=0;
  const clock={now:()=>new Date('2026-09-08T10:00:00Z'),newId:()=>`revision-${++sequence}`,bootId:'test'};
  const service=createMaterialService({...clock,database:f.database,runtime:createRuntimeCalls(f.database,new MockAiProvider(selectionMockResolver),clock),allowMock:true,loadPrompt:name=>fs.readFileSync(`pipeline/prompts/${name}`,'utf8')});
  const input:MaterialInput={sourceType:'ielts_practice',sourceId:'attempt',question:{id:'q',textEn:'Where do you live?',textZh:'你住在哪？',part:1},mode:'practice',actualAnswer:'I am used to live alone.',intendedMeaningZh:'我已经习惯一个人住了。',spokenStyleVersion:'personal-spoken-v1'};
  await f.database.write(async tx=>{await tx.run(sql`INSERT INTO questions(id,book_id,part,text,text_zh,norm_text) VALUES('q','retired',1,'Where do you live?','你住在哪？','q')`);await tx.run(sql`INSERT INTO speaking_question_attempts(id,question_id,mode,answer_text,intended_meaning_zh,status) VALUES('attempt','q','practice',${input.actualAnswer},${input.intendedMeaningZh},'pending')`);});
  const prepared=await service.prepare(input),parent=await service.process(prepared.id);
  expect(parent.status).toBe('ready');
  const [item]=await f.database.read(tx=>tx.all<{rowIndex:number;learningItemId:string;targetEnglish:string;intentionZh:string;canonicalKey:string}>(sql`SELECT mi.row_index rowIndex,i.id learningItemId,i.target_english targetEnglish,i.intention_zh intentionZh,i.canonical_key canonicalKey FROM practice_material_items mi JOIN learning_items i ON i.id=mi.learning_item_id WHERE mi.material_id=${parent.id}`));
  const source:RecoverySource={key:'attempt',kind:'attempt',createdAt:parent.created_at,questionId:'q',questionEn:input.question!.textEn,questionZh:input.question!.textZh,part:1,english:input.actualAnswer,chinese:input.intendedMeaningZh,mode:'practice',index:0,hash:materialSourceHash(input),spokenStyleVersion:'personal-spoken-v2',en:[{index:0,start:0,end:input.actualAnswer.length,text:input.actualAnswer}],zh:[{index:0,start:0,end:input.intendedMeaningZh.length,text:input.intendedMeaningZh}]};
  const fixture=recallFixture(source),{author,review}=fixture;
  author.revisionBasis={materialId:parent.id,inputHash:parent.input_hash,analysisHash:hash(parent.analysis_json),sourceHash:source.hash};
  author.units[0].gaps[0].priorLearningItem={rowIndex:item.rowIndex,learningItemId:item.learningItemId,targetEnglish:item.targetEnglish,intentionZh:item.intentionZh};
  const checkedReview={...review,authorHash:authorHash(author),continuity:[{gapId:'g0_0',learningItemId:item.learningItemId,sameTarget:true,sameIntention:true,sourceQuote:input.actualAnswer,reasonZh:'独立确认仍是习惯构式与同一独居意思，只改具体回想实例'}]};
  return {...f,service,input,parent,item,source,author,review:checkedReview};
}

describe('safe offline material append and stable learning identity',()=>{
  it('an independent reviewer cannot unilaterally enable a policy absent from the parent material',async()=>{
    const f=await setup();
    const unauthorized={...f.review,selectionPolicyVersion:'evidence-exclusion-v1' as const};
    await expect(applyReviewedOfflineRevision(f.database,f.source,f.author,unauthorized)).rejects.toMatchObject({code:'offline_review_policy'});
    expect(await f.database.read(tx=>tx.all(sql`SELECT id FROM practice_materials`))).toHaveLength(1);
  });
  it('appends immutable history, keeps stable ID/progress/preferences, and is idempotent without network',async()=>{
    const f=await setup(),network=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('No Runtime permitted'));
    await f.database.write(async tx=>{await tx.run(sql`INSERT INTO light_study_progress(learning_item_id,first_seen_at,last_seen_at,due_at,version,review_count,fsrs_json,last_rating) VALUES(${f.item.learningItemId},'2026-08-01','2026-09-01','2026-10-01',7,4,'{"state":2}','remembered')`);await tx.run(sql`INSERT INTO expression_preferences(learning_item_id,hidden,favorite,note,version,updated_at,self_known) VALUES(${f.item.learningItemId},1,1,'保留个人备注',9,'2026-09-01',1)`);});
    const state=()=>f.database.read(async tx=>({items:await tx.all(sql`SELECT * FROM learning_items`),progress:await tx.all(sql`SELECT * FROM light_study_progress`),preferences:await tx.all(sql`SELECT * FROM expression_preferences`),learningEvents:await tx.all(sql`SELECT * FROM light_study_events`),ai:await tx.all(sql`SELECT * FROM ai_runs`)}));
    const before=await state(),old=await f.service.get(f.parent.id);
    const result=await applyReviewedOfflineRevision(f.database,f.source,f.author,f.review,new Date('2026-09-08T11:00:00Z'));
    expect(result).toMatchObject({alreadyApplied:false,preservedItems:1,previousMaterialId:f.parent.id});
    expect(result.id).not.toBe(f.parent.id);
    expect(await state()).toEqual(before);
    expect(await f.service.get(f.parent.id)).toEqual(old);
    const links=await f.database.read(tx=>tx.all(sql`SELECT learning_item_id FROM practice_material_items WHERE material_id=${result.id}`));
    expect(links).toEqual([{learning_item_id:f.item.learningItemId}]);
    expect((await f.service.get(result.id)).created_at>f.parent.created_at).toBe(true);
    expect((await applyReviewedOfflineRevision(f.database,f.source,f.author,f.review)).alreadyApplied).toBe(true);
    expect(await f.database.read(tx=>tx.all(sql`SELECT id FROM practice_materials`))).toHaveLength(2);
    expect((await f.service.inspect(result.id)).verified).toBe(true);
    expect(network).not.toHaveBeenCalled();
    await f.database.write(tx=>tx.run(sql`UPDATE practice_material_items SET learning_item_id='invented-id' WHERE material_id=${result.id}`));
    const audit=await f.database.read(tx=>auditPracticeMaterials({execute:async statement=>({rows:await tx.all<Record<string,unknown>>(typeof statement==='string'?{sql:statement}:statement)})},true,[result.id]));
    expect(audit.issues.some(issue=>issue.code==='offline_revision_identity')).toBe(true);
  });
  it.each(['id','target','meaning'] as const)('rejects a forged prior %s even with newly computed author/reviewer hashes',async field=>{
    const f=await setup(),prior=f.author.units[0].gaps[0].priorLearningItem!;
    if(field==='id'){prior.learningItemId='another-learning-id';f.review.continuity[0].learningItemId='another-learning-id';}
    if(field==='target')prior.targetEnglish='take off';
    if(field==='meaning')prior.intentionZh='另一种意思';
    f.review.authorHash=authorHash(f.author);
    await expect(applyReviewedOfflineRevision(f.database,f.source,f.author,f.review)).rejects.toMatchObject({code:'offline_identity_changed'});
    expect(await f.database.read(tx=>tx.all(sql`SELECT id FROM practice_materials`))).toHaveLength(1);
  });
  it('requires an explicit same-target mapping and an independent same-intention verdict',async()=>{
    const f=await setup();
    f.review.continuity[0].sameIntention=false;
    await expect(applyReviewedOfflineRevision(f.database,f.source,f.author,f.review)).rejects.toMatchObject({code:'offline_identity_review'});
    delete f.author.units[0].gaps[0].priorLearningItem;f.review.authorHash=authorHash(f.author);f.review.continuity=[];
    await expect(applyReviewedOfflineRevision(f.database,f.source,f.author,f.review)).rejects.toMatchObject({code:'offline_identity_required'});
  });
  it('rejects changed source hashes and current originals without publishing',async()=>{
    const f=await setup();
    f.author.revisionBasis!.sourceHash='stale';f.review.authorHash=authorHash(f.author);
    await expect(applyReviewedOfflineRevision(f.database,f.source,f.author,f.review)).rejects.toMatchObject({code:'offline_revision_stale'});
    f.author.revisionBasis!.sourceHash=f.source.hash;f.review.authorHash=authorHash(f.author);
    await f.database.write(tx=>tx.run(sql`UPDATE speaking_question_attempts SET answer_text='A changed answer.' WHERE id='attempt'`));
    await expect(applyReviewedOfflineRevision(f.database,f.source,f.author,f.review)).rejects.toMatchObject({code:'offline_revision_stale'});
    expect(await f.database.read(tx=>tx.all(sql`SELECT id FROM practice_materials`))).toHaveLength(1);
  });
  it('does not revive withdrawn materials or allow a fresh revision from an obsolete parent',async()=>{
    const f=await setup();
    await f.database.write(tx=>tx.run(sql`UPDATE practice_materials SET status='hidden' WHERE id=${f.parent.id}`));
    await expect(applyReviewedOfflineRevision(f.database,f.source,f.author,f.review)).rejects.toMatchObject({code:'offline_revision_stale'});
    await f.database.write(tx=>tx.run(sql`UPDATE practice_materials SET status='ready' WHERE id=${f.parent.id}`));
    await applyReviewedOfflineRevision(f.database,f.source,f.author,f.review);
    f.author.contextId='another-author-context';f.review.authorHash=authorHash(f.author);
    await expect(applyReviewedOfflineRevision(f.database,f.source,f.author,f.review)).rejects.toMatchObject({code:'offline_revision_stale'});
  });
});
