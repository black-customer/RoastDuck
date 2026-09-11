import type {SqlWriter} from '@/lib/platform/database';
import {query as sql} from '@/lib/platform/sql';
import type {MaterialInput,MaterialRow} from '@/lib/four-step/material-types';
import type {SpeakingAttemptAnalysis} from '@/lib/speaking-practice/schemas';
import {hash} from '@/lib/four-step/shared';
import {materialFingerprint} from '@/lib/light-study/core-catalogue';
import type {SentenceCard} from './contracts';
import {teachingTextHash} from './teaching-contracts';
export const SENTENCE_MATERIAL_VERSION='sentence-material-v1';
export const SENTENCE_VALIDATION_VERSION='sentence-validation-v1';
export function sentenceDisplayVersion(card:Pick<SentenceCard,'materialId'|'chinese'|'english'|'contextZh'|'meaningOrigin'|'usages'|'notes'>){return hash(SENTENCE_MATERIAL_VERSION,JSON.stringify(card)).slice(0,32);}

/** Pure projection of already-reviewed sentences and intentions. It invents no teaching text. */
export function projectSentenceMaterials(materialId:string,input:MaterialInput,analysis:SpeakingAttemptAnalysis):SentenceCard[]{
  if(!analysis.evidence)return [];
  const {diagnosis,draft}=analysis.evidence;
  return draft.sentences.map((sentence,ordinal)=>{
    const units=sentence.intentUnitIds.map(id=>diagnosis.units.find(u=>u.id===id)).filter(u=>!!u);
    const chinese=units.map(u=>u.intentZh).join('\n');
    if(!chinese.trim()||!sentence.english.trim())throw new Error('句子缺少已审核的中文意思或英文');
    const key=hash(input.sourceType,input.sentenceSourceId??input.sourceId,chinese.normalize('NFKC'),sentence.english.normalize('NFKC'));
    const rows=analysis.learningMaterials.filter(row=>row.sentenceId===sentence.id);
    const usages:SentenceCard['usages']=[];
    for(const row of rows){
      const text=row.surfaceInSentence??row.englishChunk,start=sentence.english.indexOf(text);
      if(start<0)throw new Error('已审核表达缺少可靠的句内位置');
      usages.push({id:row.gapId??hash(text,row.chineseChunk),text,meaningZh:row.chineseChunk,start,end:start+text.length,kind:row.learningBasis??'confirmed_error'});
    }
    const notes:SentenceCard['notes']=[];
    for(const row of rows){
      const gap=analysis.gaps.find(g=>g.key===row.gapId);
      if(gap&&gap.learningBasis!=='preparation'&&gap.explanationZh.trim())notes.push({id:gap.key,textZh:gap.explanationZh,kind:'correction',evidence:gap.evidence});
    }
    const userChinese=units.some(u=>[...u.chinese,...u.english,...u.raw??[]].some(r=>/[\u4e00-\u9fff]/.test(r.text)));
    return {id:`sentence_${key.slice(0,28)}`,version:hash(SENTENCE_MATERIAL_VERSION,chinese,sentence.english).slice(0,32),materialId,sentenceId:sentence.id,ordinal,chinese,english:sentence.english,contextZh:ordinal>0?diagnosis.units.filter(u=>draft.sentences[ordinal-1].intentUnitIds.includes(u.id)).map(u=>u.intentZh).join(' '):'',meaningOrigin:userChinese?'user_chinese':'derived_from_english',usages,notes,source:{type:input.sourceType,id:input.sourceId,questionId:input.question?.id??null,title:input.question?.textZh||input.question?.textEn||'这段对话',href:input.question?`/questions/${encodeURIComponent(input.question.id)}/attempts/${encodeURIComponent(input.sourceId)}`:`/free-talk?conversation=${encodeURIComponent(input.sourceId)}`},progressVersion:0};
  }).map((card,index)=>({...card,version:sentenceDisplayVersion({materialId:card.materialId,chinese:card.chinese,english:card.english,contextZh:card.contextZh,meaningOrigin:card.meaningOrigin as SentenceCard['meaningOrigin'],usages:card.usages,notes:card.notes}),meaningOrigin:card.meaningOrigin as SentenceCard['meaningOrigin'],...(draft.sentences[index].teaching?{teaching:draft.sentences[index].teaching,teachingRevision:teachingTextHash(card.chinese,card.english)}:{})}));
}

/** Only called after independent material validation, inside its publication transaction. */
export async function publishSentenceMaterials(tx:SqlWriter,material:MaterialRow,input:MaterialInput,analysis:SpeakingAttemptAnalysis,now:Date){
  const [edition]=await tx.all<{id:string}>(sql`SELECT id FROM sentence_material_editions WHERE material_id=${material.id} LIMIT 1`);
  if(edition)throw new Error('此材料已有独立句子修订，不能用旧投影覆盖；请追加审核后的句子版本');
  const cards=projectSentenceMaterials(material.id,input,analysis),stamp=now.toISOString();
  await tx.run(sql`UPDATE sentence_learning_units SET active=0 WHERE material_id=${material.id}`);
  for(const card of cards){
    // Identical meaning/English in a later version keeps identity; provenance follows its current version.
    await tx.run(sql`INSERT INTO sentence_learning_units(id,material_id,sentence_id,source_type,source_id,question_id,ordinal,version,body_json,created_at,updated_at)
      VALUES(${card.id},${material.id},${card.sentenceId},${input.sourceType},${input.sourceId},${input.question?.id??null},${card.ordinal},${card.version},${JSON.stringify(card)},${stamp},${stamp})
      ON CONFLICT(id) DO UPDATE SET material_id=excluded.material_id,sentence_id=excluded.sentence_id,source_type=excluded.source_type,source_id=excluded.source_id,question_id=excluded.question_id,ordinal=excluded.ordinal,version=excluded.version,body_json=excluded.body_json,active=1,updated_at=excluded.updated_at`);
  }
  await tx.run(sql`INSERT INTO material_validation_cache(material_id,fingerprint,rule_version,valid,result_json,checked_at) VALUES(${material.id},${materialFingerprint(material)},${SENTENCE_VALIDATION_VERSION},1,${JSON.stringify({source:'independently_reviewed_material',sentences:cards.length})},${stamp}) ON CONFLICT(material_id) DO UPDATE SET fingerprint=excluded.fingerprint,rule_version=excluded.rule_version,valid=1,result_json=excluded.result_json,checked_at=excluded.checked_at`);
  return cards;
}
