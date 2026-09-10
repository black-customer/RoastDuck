import type {DatabasePort,SqlWriter} from '@/lib/platform/database';
import {query as sql} from '@/lib/platform/sql';
import type {AuthoredMaterial,OfflineReview,RecoverySource} from './offline-contracts';
import {authoredMaterialSchema,authorHash,recoverySourceSchema} from './offline-contracts';
import {compileOfflineMaterial} from './offline-compile';
import {normalizeExpression} from './contracts';
import {hash,TrainingError} from './shared';
import {materialSourceHash} from './revision-source';
import {prepareMaterialIn} from './core-materials';
import {publishReviewedItems,type ReviewedItemContinuity} from './publication';
import {materialStageContracts} from './stage-contracts';
import {validateMaterial} from './material-validation';
import type {MaterialInput,MaterialRow} from './material-types';
import {speakingAttemptAnalysisSchema,type SpeakingAttemptAnalysis} from '@/lib/speaking-practice/schemas';

function reject(message:string,code='offline_revision_stale'):never {throw new TrainingError(message,409,code);}
type PriorItem={row_index:number;id:string;canonical_key:string;target_english:string;intention_zh:string};

/** IDs are resolved from the reviewed parent row in this transaction, never accepted as new IDs. */
async function resolveContinuity(tx:SqlWriter,parent:MaterialRow,input:MaterialInput,author:AuthoredMaterial,review:OfflineReview,analysis:SpeakingAttemptAnalysis){
  const old=speakingAttemptAnalysisSchema.parse(JSON.parse(parent.analysis_json));
  const items=await tx.all<PriorItem>(sql`SELECT mi.row_index,i.id,i.canonical_key,i.target_english,i.intention_zh FROM practice_material_items mi JOIN learning_items i ON i.id=mi.learning_item_id WHERE mi.material_id=${parent.id}`);
  const gaps=author.units.flatMap((unit,i)=>unit.gaps.map((gap,j)=>({gapId:`g${i}_${j}`,gap})));
  const mappings=new Map<number,ReviewedItemContinuity>();
  const continuity=review.continuity??[];
  const expected=gaps.filter(g=>g.gap.priorLearningItem&&analysis.learningMaterials.some(row=>row.gapId===g.gapId));
  if(continuity.length!==expected.length||new Set(continuity.map(item=>item.gapId)).size!==continuity.length)reject('学习项继承必须逐项独立审核，不能遗漏或重复','offline_identity_review');
  for(const [rowIndex,row] of analysis.learningMaterials.entries()){
    const authored=gaps.find(g=>g.gapId===row.gapId)!.gap,prior=authored.priorLearningItem;
    if(!prior){
      if(old.learningMaterials.some(item=>normalizeExpression(item.englishChunk)===normalizeExpression(row.englishChunk)))reject('与旧目标同名的修订必须明确审核旧学习项映射；不能隐式重建或按英文合并义项','offline_identity_required');
      continue;
    }
    const item=items.find(item=>item.row_index===prior.rowIndex),oldRow=old.learningMaterials[prior.rowIndex];
    const verdict=continuity.find(item=>item.gapId===row.gapId);
    if(!item||!oldRow||item.id!==prior.learningItemId||item.target_english!==prior.targetEnglish||item.intention_zh!==prior.intentionZh)reject('旧目标、中文意图或学习项身份与导出快照不一致','offline_identity_changed');
    if(normalizeExpression(oldRow.englishChunk)!==normalizeExpression(row.englishChunk)||normalizeExpression(item.target_english)!==normalizeExpression(row.englishChunk))reject('目标已经改变，不能借用旧学习项进度','offline_identity_changed');
    if(!verdict||verdict.learningItemId!==item.id||!verdict.sameTarget||!verdict.sameIntention||![input.actualAnswer,input.intendedMeaningZh,input.rawInput??''].some(text=>text.includes(verdict.sourceQuote)))reject('保留学习项缺少独立的同目标、同原意来源审核','offline_identity_review');
    const unit=analysis.evidence!.diagnosis.units.find(unit=>unit.gaps.some(gap=>gap.id===row.gapId))!;
    if(![...unit.english,...unit.chinese,...unit.raw??[]].some(ref=>ref.text.includes(verdict.sourceQuote)))reject('学习项继承审核引用不属于当前目标来源','offline_identity_review');
    mappings.set(rowIndex,{learningItemId:item.id,canonicalKey:item.canonical_key});
  }
  return mappings;
}

/** Explicit local append only. No Provider, no progress/preference updates, no automatic application. */
export async function applyReviewedOfflineRevision(database:DatabasePort,rawSource:RecoverySource,rawAuthor:AuthoredMaterial,rawReview:OfflineReview,now=new Date()){
  const sourceSnapshot=recoverySourceSchema.parse(rawSource);
  const authorSnapshot=authoredMaterialSchema.parse(rawAuthor);
  if(!authorSnapshot.revisionBasis)reject('追加修订需要明确的旧材料快照','offline_revision_required');
  const [authority]=await database.read(tx=>tx.all<MaterialRow>(sql`SELECT * FROM practice_materials WHERE id=${authorSnapshot.revisionBasis!.materialId}`));
  if(!authority)reject('旧材料不存在或已变化');
  const authorityInput=JSON.parse(authority.input_json) as MaterialInput;
  const {source,author,review,analysis}=compileOfflineMaterial(sourceSnapshot,authorSnapshot,rawReview,{selectionPolicyVersion:authorityInput.selectionPolicyVersion});
  if(source.kind!=='attempt'||source.spokenStyleVersion!=='personal-spoken-v2'||!author.revisionBasis)reject('追加修订需要新版合同和明确的旧材料快照','offline_revision_required');
  const basis=author.revisionBasis;
  if(source.hash!==basis.sourceHash)reject('修订来源哈希不一致');
  return database.write(async tx=>{
    const [parent]=await tx.all<MaterialRow>(sql`SELECT * FROM practice_materials WHERE id=${basis.materialId}`);
    if(!parent||parent.status!=='ready'||parent.source_type!=='ielts_practice'||parent.source_id!==source.key||parent.input_hash!==basis.inputHash||hash(parent.analysis_json)!==basis.analysisHash)reject('旧材料已撤销、变化或不属于当前回答');
    const originalInput=JSON.parse(parent.input_json) as MaterialInput;
    if(materialSourceHash(originalInput)!==basis.sourceHash||originalInput.actualAnswer!==source.english||originalInput.intendedMeaningZh!==source.chinese||originalInput.question?.id!==source.questionId||originalInput.question.textEn!==source.questionEn||originalInput.question.textZh!==source.questionZh||originalInput.question.part!==source.part||originalInput.mode!==source.mode||originalInput.inputFormat!==source.inputFormat||originalInput.rawInput!==source.rawInput)reject('源回答、题目或输入格式与复核快照不一致');
    const [actual]=await tx.all<{answer_text:string;intended_meaning_zh:string;question_id:string}>(sql`SELECT answer_text,intended_meaning_zh,question_id FROM speaking_question_attempts WHERE id=${source.key}`);
    const [superseded]=await tx.all(sql`SELECT 1 FROM practice_answer_sources pas JOIN personal_answers pa ON pa.id=pas.answer_id WHERE pas.attempt_id=${source.key} AND pa.superseded_by_revision_id IS NOT NULL`);
    const [question]=await tx.all<{text:string;text_zh:string;part:number}>(sql`SELECT text,text_zh,part FROM questions WHERE id=${source.questionId}`);
    if(!actual||actual.answer_text!==source.english||actual.intended_meaning_zh!==source.chinese||actual.question_id!==source.questionId||superseded||!question||question.text!==source.questionEn||question.text_zh!==source.questionZh||question.part!==source.part)reject('真实来源已变化或被替代，不能复活旧内容');
    const artifactHash=hash(authorHash(author),JSON.stringify(review));
    const input:MaterialInput={...originalInput,spokenStyleVersion:'personal-spoken-v2',offlineRevision:{parentMaterialId:parent.id,parentInputHash:parent.input_hash,parentAnalysisHash:basis.analysisHash,sourceHash:basis.sourceHash,artifactHash}};
    validateMaterial(analysis,input);
    const snapshot=JSON.stringify(input),inputHash=hash('four-step-material-evidence-v2',snapshot),newId=`pm_${hash(input.sourceType,input.sourceId,inputHash).slice(0,24)}`;
    const [existing]=await tx.all<MaterialRow>(sql`SELECT * FROM practice_materials WHERE id=${newId}`);
    if(existing?.status==='ready'){
      if(existing.analysis_json!==JSON.stringify(analysis))reject('同一修订凭证对应了不同内容');
      return {id:existing.id,previousMaterialId:parent.id,alreadyApplied:true,preservedItems:author.units.flatMap(unit=>unit.gaps).filter(gap=>gap.priorLearningItem).length};
    }
    if(existing&&!['queued','failed'].includes(existing.status))reject('修订记录已撤销或正在处理');
    const [newer]=await tx.all(sql`SELECT 1 FROM practice_materials WHERE source_type=${parent.source_type} AND source_id=${parent.source_id} AND status='ready' AND contract_version='evidence_v2' AND (julianday(created_at)>julianday(${parent.created_at}) OR julianday(created_at)=julianday(${parent.created_at}) AND id>${parent.id})`);
    if(newer)reject('来源已有更新材料，请重新导出后复核');
    const mappings=await resolveContinuity(tx,parent,input,author,review,analysis);
    const publishedAt=new Date(Math.max(now.getTime(),Date.parse(parent.created_at)+1)),timestamp=publishedAt.toISOString();
    const material=await prepareMaterialIn(tx,input,timestamp);
    const run=(stage:string)=>`offline_${hash(source.key,artifactHash,stage).slice(0,32)}`;
    const evidence=analysis.evidence!;
    const stages={
      diagnosis:{input:{source:input},output:evidence.diagnosis},
      selection:{input:{source:input,diagnosis:evidence.diagnosis,diagnosisRunId:run('diagnosis')},output:evidence.selection},
      material:{input:{source:input,diagnosis:evidence.diagnosis,selection:evidence.selection,selectionRunId:run('selection')},output:evidence.draft},
      review:{input:{source:input,compiled:analysis,generatorRunId:run('material')},output:review.review},
    };
    for(const [stage,spec] of Object.entries(materialStageContracts(input))){
      const record=stages[stage as keyof typeof stages],actor=stage==='selection'||stage==='review'?review:author;
      const inputJson=JSON.stringify(record.input),outputJson=JSON.stringify(record.output);
      await tx.run(sql`INSERT INTO practice_material_stages(run_id,material_id,stage,prompt_version,input_hash,input_json,output_json,status,created_at) VALUES(${run(stage)},${material.id},${stage},${spec.prompt},${hash(spec.prompt,inputJson)},${inputJson},${outputJson},'completed',${timestamp})`);
      await tx.run(sql`INSERT INTO practice_offline_runs(run_id,material_id,stage,model,context_id,prompt_version,input_hash,output_hash,artifact_hash,created_at) VALUES(${run(stage)},${material.id},${stage},${actor.model},${actor.contextId},${spec.prompt},${hash(spec.prompt,inputJson)},${hash(outputJson)},${artifactHash},${timestamp})`);
    }
    const summary={approved:true,reasonZh:review.review.reasonZh,rows:analysis.learningMaterials.map((row,index)=>({index,approved:true,reasonZh:review.review.rows.find(verdict=>verdict.gapId===row.gapId)!.reasonZh})),offlineRevision:{source,author,review}};
    await tx.run(sql`INSERT INTO practice_material_revisions(material_id,generator_run_id,analysis_json,reviewer_run_id,review_json,created_at) VALUES(${material.id},${run('material')},${JSON.stringify(analysis)},${run('review')},${JSON.stringify(summary)},${timestamp})`);
    await tx.run(sql`UPDATE practice_materials SET analysis_json=${JSON.stringify(analysis)},generator_run_id=${run('material')},reviewer_run_id=${run('review')},review_json=${JSON.stringify(summary)} WHERE id=${material.id}`);
    await publishReviewedItems(tx,material,input,analysis,publishedAt,mappings);
    return {id:material.id,previousMaterialId:parent.id,alreadyApplied:false,preservedItems:mappings.size};
  });
}
