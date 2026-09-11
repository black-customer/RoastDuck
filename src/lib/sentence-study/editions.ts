import {z} from 'zod';
import type {DatabasePort} from '@/lib/platform/database';
import {query as sql} from '@/lib/platform/sql';
import type {MaterialInput,MaterialRow} from '@/lib/four-step/material-types';
import {speakingAttemptAnalysisSchema} from '@/lib/speaking-practice/schemas';
import {hash} from '@/lib/four-step/shared';
import {sha256Text} from '@/lib/platform/hash';
import {materialSourceHash} from '@/lib/four-step/revision-source';
import {materialFingerprint} from '@/lib/light-study/core-catalogue';
import {projectSentenceMaterials,SENTENCE_VALIDATION_VERSION,sentenceDisplayVersion} from './materials';
import {SentenceStudyError,type SentenceCard} from './contracts';
import {teachingAuthorSchema,teachingReviewSchema,teachingCandidateHash} from './teaching-contracts';
import {compileTeachingSentenceRevision} from './teaching-revisions';
const text=z.string().min(1),usage=z.object({id:text,text,meaningZh:text,kind:z.enum(['confirmed_error','preparation'])});
const note=z.object({id:text,textZh:text,kind:z.enum(['correction','suggestion']),evidence:text});
export const sentenceEditionSchema=z.object({version:z.literal('sentence-material-v1'),materialId:text,sourceHash:text,analysisHash:text,authorContext:text,runId:text,sentences:z.array(z.object({id:text,sourceSentenceId:text,sourceSentenceIds:z.array(text).optional(),chinese:text,english:text,reasonZh:text,status:z.enum(['ready','needs_attention']).default('ready'),usages:z.array(usage).optional(),notes:z.array(note).optional()})),teachingEvidence:z.object({author:teachingAuthorSchema,review:teachingReviewSchema,sourceSentenceIds:z.array(text)}).optional()});
export type SentenceEdition=z.infer<typeof sentenceEditionSchema>;
export const sentenceEditionReviewSchema=z.object({candidateHash:text,reviewerContext:text,runId:text,approved:z.literal(true),sentences:z.array(z.object({id:text,approved:z.literal(true),meaningPreserved:z.literal(true),naturalEnglish:z.literal(true),cueAligned:z.literal(true),sourceQuote:text,reasonZh:text})),coverageReasonZh:text});
export type SentenceEditionReview=z.infer<typeof sentenceEditionReviewSchema>;
export const sentenceEditionHash=(raw:unknown)=>hash(JSON.stringify(sentenceEditionSchema.parse(raw)));
export function compileSentenceEdition(material:MaterialRow,raw:unknown,rawReview:unknown){
  if(raw&&typeof raw==='object'&&'version'in raw&&raw.version==='sentence-teaching-revision-v1'){
    const result=compileTeachingSentenceRevision(material,raw);
    if(JSON.stringify(result.review)!==JSON.stringify(rawReview))throw new SentenceStudyError('句子修订审核记录不一致',422,'edition_review');
    return result;
  }
  const draft=sentenceEditionSchema.parse(raw),review=sentenceEditionReviewSchema.parse(rawReview);
  if(draft.materialId!==material.id||review.candidateHash!==sentenceEditionHash(draft)||review.reviewerContext===draft.authorContext||review.runId===draft.runId)throw new SentenceStudyError('候选已变化或缺少独立审核',422,'edition_review');
  if(draft.teachingEvidence){
    const {author,review:teachingReview,sourceSentenceIds}=draft.teachingEvidence;
    if(!teachingReview.approved||teachingReview.candidateHash!==teachingCandidateHash(author)||teachingReview.reviewerContext===author.authorContext||teachingReview.runId===author.runId||draft.authorContext!==author.authorContext||review.reviewerContext!==teachingReview.reviewerContext||author.materialId!==material.id||author.sourceHash!==sha256Text(material.input_json)||author.analysisHash!==sha256Text(material.analysis_json)||sourceSentenceIds.length!==draft.sentences.length)throw new SentenceStudyError('句子修订没有绑定真实教学审核',422,'edition_teaching_evidence');
    for(const [index,sentence] of draft.sentences.entries()){
      const item=author.sentences.find(s=>s.sentenceId===sourceSentenceIds[index]),verdict=teachingReview.sentences.find(s=>s.sentenceId===sourceSentenceIds[index]);
      if(!item||!verdict?.approved||!verdict.naturalEnglish||!verdict.meaningCovered||!verdict.teachingCorrect||!verdict.examplesCorrect)throw new SentenceStudyError('句子修订未逐项审核',422,'edition_teaching_evidence');
      if(item.issue&&(sentence.english!==item.issue.suggestedEnglish||item.issue.suggestedChinese&&sentence.chinese!==item.issue.suggestedChinese))throw new SentenceStudyError('句子修订漂移于独立审核文本',422,'edition_teaching_evidence');
    }
  }
  const input=JSON.parse(material.input_json) as MaterialInput,analysis=speakingAttemptAnalysisSchema.parse(JSON.parse(material.analysis_json));
  if(materialSourceHash(input)!==draft.sourceHash||sha256Text(material.analysis_json)!==draft.analysisHash)throw new SentenceStudyError('原材料已变化，需要重新核对',409,'edition_source_changed');
  const base=projectSentenceMaterials(material.id,input,analysis),ids=new Set(draft.sentences.map(s=>s.id));
  const covered=new Set(draft.sentences.flatMap(s=>s.sourceSentenceIds??[s.sourceSentenceId]));
  if(ids.size!==draft.sentences.length||base.some(s=>!covered.has(s.sentenceId))||[...covered].some(id=>!base.some(b=>b.sentenceId===id)))throw new SentenceStudyError('句子版本没有完整覆盖原来的意思',422,'edition_coverage');
  if(review.sentences.length!==draft.sentences.length||new Set(review.sentences.map(s=>s.id)).size!==ids.size)throw new SentenceStudyError('逐句审核不完整',422,'edition_review');
  const evidence=[input.actualAnswer,input.intendedMeaningZh,input.rawInput??''];
  const used=new Set<string>();
  const cards=draft.sentences.filter(s=>s.status==='ready').map((sentence,ordinal)=>{
    const verdict=review.sentences.find(r=>r.id===sentence.id);
    if(!verdict||!evidence.some(s=>s.includes(verdict.sourceQuote)))throw new SentenceStudyError('句子审核没有引用真实原文',422,'edition_evidence');
    const parents=base.filter(s=>(sentence.sourceSentenceIds??[sentence.sourceSentenceId]).includes(s.sentenceId));
    const proposed=sentence.usages??parents.flatMap(p=>p.usages).filter(u=>sentence.english.includes(u.text));
    const usages:SentenceCard['usages']=proposed.map(u=>{const start=sentence.english.indexOf(u.text);if(start<0||start!==sentence.english.lastIndexOf(u.text))throw new SentenceStudyError('重点表达需要唯一准确的句内位置',422,'edition_span');used.add(u.id);return {...u,start,end:start+u.text.length};});
    const notes=sentence.notes??parents.flatMap(p=>p.notes).filter(n=>!parents.some(p=>p.usages.some(u=>u.id===n.id))||usages.some(u=>u.id===n.id));
    if(notes.some(n=>!evidence.some(s=>s.includes(n.evidence))))throw new SentenceStudyError('注意点缺少原文依据',422,'edition_evidence');
    const stable=hash(input.sourceType,input.sentenceSourceId??input.sourceId,sentence.chinese.normalize('NFKC'),sentence.english.normalize('NFKC'));
    return {...parents[0],id:`sentence_${stable.slice(0,28)}`,version:hash('sentence-material-v1',sentence.chinese,sentence.english).slice(0,32),sentenceId:sentence.id,ordinal,chinese:sentence.chinese,english:sentence.english,contextZh:ordinal?draft.sentences.filter(s=>s.status==='ready')[ordinal-1].chinese:'',meaningOrigin:parents.some(p=>p.meaningOrigin==='user_chinese')?'user_chinese' as const:'derived_from_english' as const,usages,notes,progressVersion:0};
  }).map(card=>({...card,version:sentenceDisplayVersion({materialId:card.materialId,chinese:card.chinese,english:card.english,contextZh:card.contextZh,meaningOrigin:card.meaningOrigin,usages:card.usages,notes:card.notes})}));
  // Explicitly uncertain source units may wait; every other selected expression must remain findable.
  const waiting=new Set(draft.sentences.filter(s=>s.status==='needs_attention').flatMap(s=>s.sourceSentenceIds??[s.sourceSentenceId]));
  for(const baseCard of base)if(!waiting.has(baseCard.sentenceId))for(const u of baseCard.usages)if(!used.has(u.id))throw new SentenceStudyError(`重点表达缺少新的句内映射：${u.id}`,422,'edition_usage_coverage');
  return {draft,review,cards,attention:draft.sentences.filter(s=>s.status==='needs_attention')};
}
export async function applySentenceEdition(database:DatabasePort,draft:unknown,review:unknown){return database.write(async tx=>{
  const candidate=sentenceEditionSchema.parse(draft),[material]=await tx.all<MaterialRow>(sql`SELECT * FROM practice_materials WHERE id=${candidate.materialId}`);
  if(!material||material.status!=='ready')throw new SentenceStudyError('原材料已撤销或不存在',409,'material_changed');
  const result=compileSentenceEdition(material,candidate,review),id=`edition_${hash(material.id,sentenceEditionHash(candidate)).slice(0,28)}`;
  const [existing]=await tx.all(sql`SELECT id FROM sentence_material_editions WHERE id=${id}`);if(existing)return {id,alreadyApplied:true,sentences:result.cards.length};
  const stamp=new Date().toISOString();
  await tx.run(sql`INSERT INTO sentence_material_editions(id,material_id,source_hash,analysis_hash,author_json,review_json,cards_json,created_at) VALUES(${id},${material.id},${candidate.sourceHash},${candidate.analysisHash},${JSON.stringify(candidate)},${JSON.stringify(result.review)},${JSON.stringify(result.cards)},${stamp})`);
  await tx.run(sql`UPDATE sentence_learning_units SET active=0 WHERE material_id=${material.id}`);
  for(const card of result.cards)await tx.run(sql`INSERT INTO sentence_learning_units(id,material_id,sentence_id,source_type,source_id,question_id,ordinal,version,body_json,active,created_at,updated_at) VALUES(${card.id},${card.materialId},${card.sentenceId},${card.source.type},${card.source.id},${card.source.questionId},${card.ordinal},${card.version},${JSON.stringify(card)},1,${stamp},${stamp}) ON CONFLICT(id) DO UPDATE SET material_id=excluded.material_id,sentence_id=excluded.sentence_id,body_json=excluded.body_json,version=excluded.version,ordinal=excluded.ordinal,active=1,updated_at=excluded.updated_at`);
  await tx.run(sql`INSERT INTO material_validation_cache(material_id,fingerprint,rule_version,valid,result_json,checked_at) VALUES(${material.id},${materialFingerprint(material)},${SENTENCE_VALIDATION_VERSION},1,${JSON.stringify({editionId:id,sentences:result.cards.length,attention:result.attention.map(s=>({chinese:s.chinese,reason:s.reasonZh}))})},${stamp}) ON CONFLICT(material_id) DO UPDATE SET fingerprint=excluded.fingerprint,rule_version=excluded.rule_version,valid=1,result_json=excluded.result_json,checked_at=excluded.checked_at`);
  return {id,alreadyApplied:false,sentences:result.cards.length};
});}
