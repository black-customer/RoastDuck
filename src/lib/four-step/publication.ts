import type {SqlWriter} from "@/lib/platform/database";
import {query as sql} from "@/lib/platform/sql";
import type {SpeakingAttemptAnalysis} from "@/lib/speaking-practice/schemas";
import type {MaterialInput,MaterialRow} from "./material-types";
import {normalizeExpression} from "./contracts";
import {hash,TrainingError} from "./shared";

/** Caller holds the publication transaction and has validated independent review evidence. */
export interface ReviewedItemContinuity {learningItemId:string;canonicalKey:string}
export async function publishReviewedItems(tx:SqlWriter,material:MaterialRow,input:MaterialInput,analysis:SpeakingAttemptAnalysis,now:Date,preservedItems?:ReadonlyMap<number,ReviewedItemContinuity>){
  if(input.offlineRevision&&!preservedItems)throw new TrainingError('离线修订缺少已审核的学习项映射',422,'offline_revision_required');
  if(input.sourceType==="ielts_practice"){
    const [source]=await tx.all<{answer_text:string;intended_meaning_zh:string;question_id:string}>(sql`SELECT answer_text,intended_meaning_zh,question_id FROM speaking_question_attempts WHERE id=${input.sourceId}`);
    if(!source||source.answer_text!==input.actualAnswer||source.intended_meaning_zh!==input.intendedMeaningZh||source.question_id!==input.question?.id)throw new TrainingError("回答来源已经变化，旧结果不会覆盖新回答",409,"material_source_changed");
  }else{
    const source=await tx.all<{id:string;role:string;text:string}>(sql`WITH RECURSIVE origins(id) AS (SELECT ${input.sourceId} UNION SELECT b.conversation_id FROM device_sync_chat_branches b JOIN origins o ON b.parent_id=o.id) SELECT id,role,text FROM free_talk_messages WHERE conversation_id IN(SELECT id FROM origins)`);
    if(!input.sourceMessages?.some(row=>row.role==="user")||input.sourceMessages.some(row=>!source.some(actual=>actual.id===row.id&&actual.role===row.role&&actual.text===row.text))||input.actualAnswer!==input.sourceMessages.filter(row=>row.role==="user").map(row=>row.text).join("\n"))throw new TrainingError("对话来源已经变化，原文与结果均保留",409,"material_source_changed");
  }
  const encountered=new Set<string>(),timestamp=now.toISOString();
  for(const [rowIndex,row] of analysis.learningMaterials.entries()){
    const item=analysis.learningItems[rowIndex];
    if(!item)throw new TrainingError("材料中的表达没有对应训练项",422,"material_alignment");
    const preserved=preservedItems?.get(rowIndex);
    let key=preserved?.canonicalKey??normalizeExpression(item.canonicalKey||item.targetEnglish);
    if(input.spokenStyleVersion&&!preserved){
      // Reuse legacy progress only when both reviewed expression and meaning match, not by spelling alone.
      const legacy=await tx.all<{canonical_key:string;target_english:string;intention_zh:string}>(sql`SELECT canonical_key,target_english,intention_zh FROM learning_items WHERE canonical_key=${normalizeExpression(row.englishChunk)}`);
      if(legacy.some(i=>normalizeExpression(i.target_english)===normalizeExpression(row.englishChunk)&&normalizeExpression(i.intention_zh)===normalizeExpression(row.chineseChunk)))key=legacy[0].canonical_key;
    }
    const itemId=`li_${hash(key).slice(0,24)}`;
    const inserted=await tx.run(sql`INSERT INTO learning_items(id,canonical_key,target_english,intention_zh,item_type,example_sentence,first_source_type,first_source_id,created_at,updated_at)
      VALUES(${itemId},${key},${row.englishChunk},${row.chineseChunk},${item.itemType},${row.naturalEnglishSentence},${input.sourceType},${input.sourceId},${timestamp},${timestamp}) ON CONFLICT(canonical_key) DO NOTHING`);
    const [actual]=await tx.all<{id:string}>(sql`SELECT id FROM learning_items WHERE canonical_key=${key}`);
    if(!actual)throw new TrainingError("学习项保存未确认");
    if(preserved&&actual.id!==preserved.learningItemId)throw new TrainingError('旧学习项身份已变化，修订不能重建进度',409,'offline_identity_changed');
    if(!inserted.changes&&!preserved&&!encountered.has(key))await tx.run(sql`UPDATE learning_items SET encounter_count=encounter_count+1,updated_at=${timestamp} WHERE id=${actual.id}`);
    encountered.add(key);
    await tx.run(sql`INSERT INTO practice_material_items(material_id,learning_item_id,row_index) VALUES(${material.id},${actual.id},${rowIndex}) ON CONFLICT DO NOTHING`);
    const gap=analysis.gaps.find(value=>value.key===row.gapId)??analysis.gaps.find(value=>normalizeExpression(value.targetEnglish)===normalizeExpression(row.englishChunk));
    await tx.run(sql`INSERT INTO gap_events(id,learning_item_id,source_type,source_id,question_id,evidence_text,intent_zh,target_english,explanation_zh,gap_type,created_at)
      VALUES(${`ge_${hash(material.id,String(rowIndex)).slice(0,24)}`},${actual.id},${input.sourceType},${input.sourceId},${input.question?.id??null},${gap?.evidence??input.actualAnswer},${row.chineseChunk},${row.englishChunk},${gap?.explanationZh??""},${gap?.gapType??"lexical_gap"},${timestamp}) ON CONFLICT DO NOTHING`);
  }
  await tx.run(sql`UPDATE practice_materials SET status='ready',lease_token=NULL,lease_until=NULL,error_code=NULL,updated_at=${timestamp} WHERE id=${material.id}`);
  if(input.sourceType==="ielts_practice")await tx.run(sql`UPDATE speaking_question_attempts SET status='completed',analysis_json=${JSON.stringify(analysis)},natural_version=${analysis.naturalVersion},gap_count=${analysis.gapCount},updated_at=${timestamp} WHERE id=${input.sourceId}`);
}
