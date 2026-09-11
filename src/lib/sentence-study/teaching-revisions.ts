import {z} from 'zod';
import type {SqlWriter} from '@/lib/platform/database';
import {query as sql} from '@/lib/platform/sql';
import {hash} from '@/lib/four-step/shared';
import {materialFingerprint} from '@/lib/light-study/core-catalogue';
import type {MaterialRow,MaterialInput} from '@/lib/four-step/material-types';
import {sentenceTeachingSchema,teachingAuthorSchema,teachingReviewSchema,teachingCandidateHash} from './teaching-contracts';
import {sha256Text} from '@/lib/platform/hash';
import {compileTeachingEdition} from './teaching-editions';
import {sentenceDisplayVersion,SENTENCE_VALIDATION_VERSION} from './materials';
import {SentenceStudyError,type SentenceCard} from './contracts';

export const teachingRevisionSchema=z.object({version:z.literal('sentence-teaching-revision-v1'),compilerVersion:z.literal('exact-targets-v2').optional(),parentEditionId:z.string().nullable(),replacesEditionId:z.string().nullable().optional(),expectedActiveHash:z.string().optional(),sourceCards:z.array(z.custom<SentenceCard>()),author:teachingAuthorSchema,review:teachingReviewSchema});
export function compileTeachingSentenceRevision(material:MaterialRow,raw:unknown){
  const revision=teachingRevisionSchema.parse(raw),input=JSON.parse(material.input_json) as MaterialInput;
  if(revision.sourceCards.length!==revision.author.sentences.length)throw new SentenceStudyError('句子修订未覆盖原学习包',422,'teaching_coverage');
  const mapping:Record<string,string>={},attention:Array<{chinese:string;reasonZh:string}>=[];
  const cards:SentenceCard[]=[];
  for(const sourceCard of revision.sourceCards){
    const item=revision.author.sentences.find(s=>s.sentenceId===sourceCard.id);
    if(!item||sourceCard.version!==item.textVersion||sourceCard.materialId!==material.id)throw new SentenceStudyError('修订快照与作者版本不一致',422,'teaching_source_changed');
    if(item.issue?.needsConfirmation){attention.push({chinese:sourceCard.chinese,reasonZh:item.issue.reasonZh});continue;}
    const english=item.issue?.suggestedEnglish??sourceCard.english,chinese=item.issue?.suggestedChinese||sourceCard.chinese;
    const changed=english!==sourceCard.english||chinese!==sourceCard.chinese;
    const id=changed?`sentence_${hash(input.sourceType,input.sentenceSourceId??input.sourceId,chinese.normalize('NFKC'),english.normalize('NFKC')).slice(0,28)}`:sourceCard.id;
    const exact=(text:string)=>english.includes(text)&&english.indexOf(text)===english.lastIndexOf(text);
    // v1 remains replayable as historical evidence. New revisions never invent
    // a full-sentence replacement for an obsolete target/meaning pair.
    const retained=revision.compilerVersion?sourceCard.usages.filter(u=>exact(u.text)):sourceCard.usages;
    const usages=retained.map(u=>{const text=exact(u.text)?u.text:english,start=english.indexOf(text);return {...u,text,start,end:start+text.length};});
    const removed=new Set(sourceCard.usages.filter(u=>!retained.some(r=>r.id===u.id)).map(u=>u.id));
    const notes=revision.compilerVersion?sourceCard.notes.filter(n=>!removed.has(n.id)):sourceCard.notes;
    const card={...sourceCard,id,chinese,english,ordinal:cards.length,contextZh:cards.at(-1)?.chinese??'',usages,notes};
    card.version=sentenceDisplayVersion({materialId:card.materialId,chinese,english,contextZh:card.contextZh,meaningOrigin:card.meaningOrigin,usages,notes});
    // Teaching remains a separate reviewed attachment, not part of text identity.
    delete card.teaching;delete card.teachingRevision;delete card.userHighlights;
    mapping[sourceCard.id]=id;cards.push(card);
  }
  const teaching=compileTeachingEdition(material,cards,revision.author,revision.review,mapping,revision.sourceCards);
  for(const item of teaching.attachments)sentenceTeachingSchema.parse(item.teaching);
  return {draft:revision,review:revision.review,cards,attention,teaching,mapping};
}
export async function applyTeachingSentenceRevision(tx:SqlWriter,material:MaterialRow,raw:unknown){
  const result=compileTeachingSentenceRevision(material,raw),id=`edition_teaching_${hash(JSON.stringify(result.draft)).slice(0,28)}`;
  const [prior]=await tx.all(sql`SELECT id FROM sentence_material_editions WHERE id=${id}`);if(prior)return {id,...result};
  const live=await tx.all<{body_json:string}>(sql`SELECT body_json FROM sentence_learning_units WHERE material_id=${material.id} AND active=1 ORDER BY ordinal,id`);
  const liveJson=JSON.stringify(live.map(r=>JSON.parse(r.body_json)));
  const [latest]=await tx.all<{id:string;author_json:string;cards_json:string}>(sql`SELECT id,author_json,cards_json FROM sentence_material_editions WHERE material_id=${material.id} ORDER BY created_at DESC,id DESC LIMIT 1`);
  if(latest&&latest.cards_json===liveJson&&liveJson===JSON.stringify(result.cards)){
    const old=teachingRevisionSchema.safeParse(JSON.parse(latest.author_json));
    if(old.success&&old.data.compilerVersion===result.draft.compilerVersion&&teachingCandidateHash(old.data.author)===teachingCandidateHash(result.draft.author)&&JSON.stringify(old.data.review)===JSON.stringify(result.review))return {id:latest.id,...result};
  }
  if(liveJson!==JSON.stringify(result.draft.sourceCards)){
    const previous=latest?teachingRevisionSchema.safeParse(JSON.parse(latest.author_json)):null;
    if(!latest||latest.id!==result.draft.replacesEditionId||latest.cards_json!==liveJson||sha256Text(liveJson)!==result.draft.expectedActiveHash||!previous?.success||teachingCandidateHash(previous.data.author)!==teachingCandidateHash(result.draft.author)||JSON.stringify(previous.data.review)!==JSON.stringify(result.review))throw new SentenceStudyError('发布期间句子已更新',409,'teaching_source_changed');
  }
  const stamp=new Date().toISOString();
  await tx.run(sql`INSERT INTO sentence_material_editions(id,material_id,source_hash,analysis_hash,author_json,review_json,cards_json,created_at) VALUES(${id},${material.id},${result.draft.author.sourceHash},${result.draft.author.analysisHash},${JSON.stringify(result.draft)},${JSON.stringify(result.review)},${JSON.stringify(result.cards)},${stamp})`);
  await tx.run(sql`UPDATE sentence_learning_units SET active=0 WHERE material_id=${material.id}`);
  for(const c of result.cards)await tx.run(sql`INSERT INTO sentence_learning_units(id,material_id,sentence_id,source_type,source_id,question_id,ordinal,version,body_json,active,created_at,updated_at) VALUES(${c.id},${c.materialId},${c.sentenceId},${c.source.type},${c.source.id},${c.source.questionId},${c.ordinal},${c.version},${JSON.stringify(c)},1,${stamp},${stamp}) ON CONFLICT(id) DO UPDATE SET body_json=excluded.body_json,version=excluded.version,ordinal=excluded.ordinal,active=1,updated_at=excluded.updated_at`);
  const [old]=await tx.all<{result_json:string}>(sql`SELECT result_json FROM material_validation_cache WHERE material_id=${material.id}`);
  const existing=old?JSON.parse(old.result_json).attention??[]:[];
  await tx.run(sql`UPDATE material_validation_cache SET fingerprint=${materialFingerprint(material)},rule_version=${SENTENCE_VALIDATION_VERSION},result_json=${JSON.stringify({editionId:id,sentences:result.cards.length,attention:[...existing,...result.attention.map(a=>({chinese:a.chinese,reason:a.reasonZh}))]})},checked_at=${stamp} WHERE material_id=${material.id}`);
  return {id,...result};
}
