import { sql } from "drizzle-orm";
import { getDbReady, withDbTransaction } from "@db/client";
import { speakingAttemptAnalysisSchema } from "@/lib/speaking-practice/schemas";
import { authoredMaterialSchema, authorHash, expandAuthored, offlineReviewSchema, recoverySourceSchema, type AuthoredMaterial, type OfflineReview, type RecoverySource } from "./offline-contracts";
import { compileEvidence, validateEvidenceReview } from "./selection-contracts";
import { getMaterial, prepareMaterial, publishMaterialItems, validateMaterial, type MaterialInput } from "./materials";
import { STAGE_CONTRACTS } from "./diagnostic-pipeline";
import { hash, TrainingError } from "./shared";

/** 离线作品和独立裁决的确定性编译；不创建 Provider，也不调用模型。 */
export function compileOfflineMaterial(rawSource:RecoverySource,rawAuthor:AuthoredMaterial,rawReview:OfflineReview){
  const source=recoverySourceSchema.parse(rawSource),author=authoredMaterialSchema.parse(rawAuthor),review=offlineReviewSchema.parse(rawReview);
  if(review.authorHash!==authorHash(author)||review.contextId===author.contextId)throw new TrainingError("离线审核不独立或候选已变化",422,"offline_review_stale");
  const candidate=expandAuthored(source,author);
  const draft={...candidate.draft,rows:candidate.draft.rows.filter(r=>review.selection.gaps.some(g=>g.gapId===r.gapId&&g.decision==="train"))};
  const evidence={diagnosis:candidate.diagnosis,selection:review.selection,draft};
  const analysis=speakingAttemptAnalysisSchema.parse(compileEvidence({actualAnswer:source.english,intendedMeaningZh:source.chinese},evidence));
  validateEvidenceReview(evidence,review.review);
  return {source,author,review,analysis};
}

/** 仅本机 CLI 使用。先核对真实来源再原子发布；真实学习进度不变。 */
export async function applyOfflineMaterial(rawSource:RecoverySource,rawAuthor:AuthoredMaterial,rawReview:OfflineReview){
  const {source,author,review,analysis}=compileOfflineMaterial(rawSource,rawAuthor,rawReview);
  return withDbTransaction(async()=>{
    const db=await getDbReady();
    let attemptId=source.key;
    const [question]=await db.all<{id:string;text:string;text_zh:string;part:number}>(sql`SELECT id,text,text_zh,part FROM questions WHERE id=${source.questionId}`);
    if(!question||question.text!==source.questionEn||question.part!==source.part)throw new TrainingError("题目来源已变化，需要重新导出",409,"offline_source_changed");
    if(source.kind==="personal_answer"){
      const [original]=await db.all<{raw_text:string;question_id:string;superseded_by_revision_id:string|null}>(sql`SELECT raw_text,question_id,superseded_by_revision_id FROM personal_answers WHERE id=${source.key}`);
      if(!original||original.raw_text!==source.english||source.chinese!==""||original.question_id!==source.questionId||original.superseded_by_revision_id)throw new TrainingError("历史原文已变化或被修订",409,"offline_source_changed");
      attemptId=`sqa_hist_${hash(source.key).slice(0,24)}`;
      const [mapping]=await db.all<{attempt_id:string;source_hash:string}>(sql`SELECT * FROM practice_answer_sources WHERE answer_id=${source.key}`);
      if(mapping&&(mapping.source_hash!==source.hash||mapping.attempt_id!==attemptId))throw new TrainingError("历史来源映射冲突",409,"offline_source_changed");
      await db.run(sql`INSERT INTO speaking_question_attempts(id,question_id,mode,answer_text,intended_meaning_zh,status,created_at,updated_at)
        VALUES(${attemptId},${source.questionId},'practice',${source.english},'','processing',${source.createdAt},${source.createdAt}) ON CONFLICT DO NOTHING`);
      await db.run(sql`INSERT INTO practice_answer_sources(answer_id,attempt_id,source_hash,created_at) VALUES(${source.key},${attemptId},${source.hash},${new Date().toISOString()}) ON CONFLICT DO NOTHING`);
    }
    const [original]=await db.all<{answer_text:string;intended_meaning_zh:string;question_id:string}>(sql`SELECT answer_text,intended_meaning_zh,question_id FROM speaking_question_attempts WHERE id=${attemptId}`);
    if(!original||original.answer_text!==source.english||original.intended_meaning_zh!==source.chinese||original.question_id!==source.questionId)throw new TrainingError("回答来源已变化",409,"offline_source_changed");
    const input:MaterialInput={sourceType:"ielts_practice",sourceId:attemptId,question:{id:question.id,textEn:question.text,textZh:question.text_zh,part:question.part},mode:source.mode,actualAnswer:source.english,intendedMeaningZh:source.chinese};
    validateMaterial(analysis,input);
    const material=await prepareMaterial(input);
    if(material.status==="ready"){
      if(JSON.stringify(JSON.parse(material.analysis_json))!==JSON.stringify(analysis))throw new TrainingError("已发布版本不可覆盖",409,"offline_revision_conflict");
      return {id:material.id,attemptId,alreadyApplied:true};
    }
    if(material.lease_until&&material.lease_until>new Date().toISOString())throw new TrainingError("Runtime 正在处理此回答，稍后再应用",409,"offline_busy");
    const revisionHash=hash(authorHash(author),JSON.stringify(review));
    const run=(stage:string)=>`offline_${hash(source.key,revisionHash,stage).slice(0,32)}`;
    const evidence=analysis.evidence!;
    const stages={
      diagnosis:{input:{source:input},output:evidence.diagnosis},
      selection:{input:{source:input,diagnosis:evidence.diagnosis,diagnosisRunId:run("diagnosis")},output:evidence.selection},
      material:{input:{source:input,diagnosis:evidence.diagnosis,selection:evidence.selection,selectionRunId:run("selection")},output:evidence.draft},
      review:{input:{source:input,compiled:analysis,generatorRunId:run("material")},output:review.review},
    };
    const now=new Date().toISOString();
    await db.run(sql`UPDATE practice_material_stages SET status='rejected' WHERE material_id=${material.id} AND status='completed'`);
    for(const [stage,spec] of Object.entries(STAGE_CONTRACTS)){
      const record=stages[stage as keyof typeof stages];
      const inputJson=JSON.stringify(record.input),outputJson=JSON.stringify(record.output);
      const actor=stage==="selection"||stage==="review"?review:author;
      await db.run(sql`INSERT INTO practice_material_stages(run_id,material_id,stage,prompt_version,input_hash,input_json,output_json,status,created_at)
        VALUES(${run(stage)},${material.id},${stage},${spec.prompt},${hash(spec.prompt,inputJson)},${inputJson},${outputJson},'completed',${now})`);
      await db.run(sql`INSERT INTO practice_offline_runs(run_id,material_id,stage,model,context_id,prompt_version,input_hash,output_hash,artifact_hash,created_at)
        VALUES(${run(stage)},${material.id},${stage},${actor.model},${actor.contextId},${spec.prompt},${hash(spec.prompt,inputJson)},${hash(outputJson)},${revisionHash},${now})`);
    }
    const summary={approved:true,reasonZh:review.review.reasonZh,rows:analysis.learningMaterials.map((r,index)=>({index,approved:true,reasonZh:review.review.rows.find(v=>v.gapId===r.gapId)!.reasonZh}))};
    await db.run(sql`INSERT INTO practice_legacy_analyses(attempt_id,analysis_json,natural_version,archived_at) SELECT id,analysis_json,natural_version,${now} FROM speaking_question_attempts WHERE id=${attemptId} AND analysis_json!='{}' ON CONFLICT DO NOTHING`);
    await db.run(sql`INSERT INTO practice_material_revisions(material_id,generator_run_id,analysis_json,reviewer_run_id,review_json,created_at)
      VALUES(${material.id},${run("material")},${JSON.stringify(analysis)},${run("review")},${JSON.stringify(summary)},${now})`);
    await db.run(sql`UPDATE practice_materials SET analysis_json=${JSON.stringify(analysis)},generator_run_id=${run("material")},reviewer_run_id=${run("review")},review_json=${JSON.stringify(summary)} WHERE id=${material.id}`);
    await publishMaterialItems(material,input,analysis);
    if(material.job_id)await db.run(sql`UPDATE ai_jobs SET status='completed',last_error_code=NULL,updated_at=${now} WHERE id=${material.job_id}`);
    return {id:(await getMaterial(material.id)).id,attemptId,alreadyApplied:false};
  });
}
