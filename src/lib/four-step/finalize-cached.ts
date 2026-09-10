import type {DatabasePort} from '@/lib/platform/database';
import {query as sql} from '@/lib/platform/sql';
import {recoverApprovedPipeline} from './approved-pipeline';
import {publishReviewedItems} from './publication';
import {recordReviewedAnswerMemoriesIn} from '@/lib/coaching/learning-memory';
import {auditPracticeMaterials} from './audit';
import {TrainingError} from './shared';
import type {MaterialInput,MaterialRow} from './material-types';

/** Cache-only publication: deliberately has no Provider/Runtime/fetch dependency
 * or fallback. Missing, negative or inconsistent receipts abort the transaction. */
export function finalizeCachedMaterial(database:DatabasePort,id:string,at=new Date(),allowMock=false){
 return database.write(async tx=>{
  const [material]=await tx.all<MaterialRow>(sql`SELECT * FROM practice_materials WHERE id=${id}`);
  if(!material)throw new TrainingError('材料不存在',404,'material_not_found');
  if(!['failed','queued','ready'].includes(material.status)||material.lease_until&&material.lease_until>at.toISOString())throw new TrainingError('材料正在使用或已撤销，不能从缓存发布',409,'cache_publication_unavailable');
  const proof=await recoverApprovedPipeline(tx,material);
  if(!proof)throw new TrainingError('没有完整且通过当前审核的缓存证据；未发起新请求',409,'approved_cache_missing');
  const source=JSON.parse(material.input_json) as MaterialInput;
  if(source.sourceType==='ielts_practice'){
   const [answer]=await tx.all<{answer_text:string;intended_meaning_zh:string}>(sql`SELECT answer_text,intended_meaning_zh FROM speaking_question_attempts WHERE id=${source.sourceId}`);
   if(!answer||answer.answer_text!==source.actualAnswer||answer.intended_meaning_zh!==source.intendedMeaningZh)throw new TrainingError('来源回答已经变化，未修改任何记录',409,'cache_source_changed');
  }
  if(material.status==='ready'){
    const existing=await auditPracticeMaterials({execute:async statement=>({rows:await tx.all<Record<string,unknown>>(typeof statement==='string'?{sql:statement}:statement)})},allowMock,[id]);
    if(!existing.ok)throw new TrainingError('已发布材料需要检查，未重写现有版本',409,'cache_publication_audit');
    return {id,status:'ready' as const,stageRunIds:proof.stageRunIds,sentences:proof.analysis.evidence?.draft.sentences.length??0,targets:proof.analysis.learningMaterials.length,confirmedProblems:proof.analysis.gapCount,networkCalls:0};
  }
  for(const runId of proof.stageRunIds)await tx.run(sql`UPDATE practice_material_stages SET status='completed' WHERE material_id=${id} AND run_id=${runId} AND status='rejected'`);
  await tx.run(sql`INSERT INTO practice_material_revisions(material_id,generator_run_id,analysis_json,reviewer_run_id,review_json,created_at) VALUES(${id},${proof.generatorRunId},${JSON.stringify(proof.analysis)},${proof.reviewed.runId},${JSON.stringify(proof.reviewed.data)},${at.toISOString()}) ON CONFLICT DO NOTHING`);
  await tx.run(sql`UPDATE practice_materials SET analysis_json=${JSON.stringify(proof.analysis)},generator_run_id=${proof.generatorRunId},reviewer_run_id=${proof.reviewed.runId},review_json=${JSON.stringify(proof.reviewed.data)} WHERE id=${id}`);
  await publishReviewedItems(tx,material,source,proof.analysis,at);
  const audit=await auditPracticeMaterials({execute:async statement=>({rows:await tx.all<Record<string,unknown>>(typeof statement==='string'?{sql:statement}:statement)})},allowMock,[id]);
  if(!audit.ok)throw new TrainingError('缓存证据未通过发布审计；已回滚，未发起新请求',409,'cache_publication_audit');
  await recordReviewedAnswerMemoriesIn(tx,id,at,{allowMock});
  if(material.job_id)await tx.run(sql`UPDATE ai_jobs SET status='completed',last_error_code=NULL,updated_at=${at.toISOString()} WHERE id=${material.job_id}`);
  return {id,status:'ready' as const,stageRunIds:proof.stageRunIds,sentences:proof.analysis.evidence?.draft.sentences.length??0,targets:proof.analysis.learningMaterials.length,confirmedProblems:proof.analysis.gapCount,networkCalls:0};
 });
}
