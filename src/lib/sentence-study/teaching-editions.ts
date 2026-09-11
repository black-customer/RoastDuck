import type {SqlReader,SqlWriter} from '@/lib/platform/database';
import {query as sql} from '@/lib/platform/sql';
import {sha256Text} from '@/lib/platform/hash';
import type {MaterialRow,MaterialInput} from '@/lib/four-step/material-types';
import {SentenceStudyError,type SentenceCard} from './contracts';
import {teachingAuthorSchema,teachingReviewSchema,teachingCandidateHash,teachingTextHash,validateTeachingAnchors,type SentenceTeaching} from './teaching-contracts';

export interface TeachingAttachment {sentenceId:string;textVersion:string;textHash:string;teaching:SentenceTeaching}
export interface TeachingEditionRow {id:string;material_id:string;source_hash:string;candidate_hash:string;author_json:string;review_json:string;teachings_json:string;status:string}

/** Author/reviewer artifacts refer to a fixed source. Only an independent positive
 * decision can publish; literal coverage below does not grant content approval. */
export function compileTeachingEdition(material:MaterialRow,cards:SentenceCard[],rawAuthor:unknown,rawReview:unknown,mapping:Record<string,string>={},sourceCards:SentenceCard[]=[]){
  const author=teachingAuthorSchema.parse(rawAuthor),review=teachingReviewSchema.parse(rawReview),candidateHash=teachingCandidateHash(author);
  if(author.materialId!==material.id||author.sourceHash!==sha256Text(material.input_json)||author.analysisHash!==sha256Text(material.analysis_json))throw new SentenceStudyError('教学对应的原材料已改变',409,'teaching_source_changed');
  const attention=author.sentences.filter(item=>item.issue?.needsConfirmation&&review.sentences.some(r=>r.sentenceId===item.sentenceId&&!r.approved&&r.decision==='needs_attention'));
  if(attention.length&&(review.approved||review.partialApproval!==true))throw new SentenceStudyError('待确认内容需要明确的部分批准，不能宣称整份通过',422,'teaching_review');
  if((!review.approved&&!(review.partialApproval&&attention.length))||review.candidateHash!==candidateHash||review.reviewerContext===author.authorContext||review.runId===author.runId)throw new SentenceStudyError('教学缺少当前版本的独立审核',422,'teaching_review');
  if(new Set(author.sentences.map(s=>s.sentenceId)).size!==author.sentences.length||new Set(review.sentences.map(s=>s.sentenceId)).size!==review.sentences.length||author.sentences.length!==review.sentences.length||cards.length!==author.sentences.length-attention.length)throw new SentenceStudyError('教学与审核句子覆盖不完整',422,'teaching_coverage');
  const input=JSON.parse(material.input_json) as MaterialInput,source=[input.actualAnswer,input.intendedMeaningZh,input.rawInput??''];
  for(const item of attention){const verdict=review.sentences.find(r=>r.sentenceId===item.sentenceId)!;if(!source.some(s=>s.includes(verdict.sourceQuote)))throw new SentenceStudyError('待确认内容缺少原文引用',422,'teaching_review');}
  const attachments=author.sentences.filter(item=>!attention.includes(item)).map(item=>{
    const sentenceId=mapping[item.sentenceId]??item.sentenceId,card=cards.find(c=>c.id===sentenceId),verdict=review.sentences.find(r=>r.sentenceId===item.sentenceId);
    if(!card||!verdict||!verdict.approved||!verdict.meaningCovered||!verdict.naturalEnglish||!verdict.teachingCorrect||!verdict.examplesCorrect||!source.some(s=>s.includes(verdict.sourceQuote)))throw new SentenceStudyError('本句教学未通过有来源证据的独立审核',422,'teaching_review');
    if(item.issue?.needsConfirmation)throw new SentenceStudyError('原意仍待确认，不能发布教学',422,'teaching_attention');
    if(!item.issue&&card.version!==item.textVersion){const original=sourceCards.find(c=>c.id===item.sentenceId&&c.version===item.textVersion);
      if(!original||original.english!==card.english||original.chinese!==card.chinese)throw new SentenceStudyError('教学句子版本已变化',409,'teaching_text_changed');
    }
    if(item.issue&&(card.english!==item.issue.suggestedEnglish||item.issue.suggestedChinese&&card.chinese!==item.issue.suggestedChinese))throw new SentenceStudyError('必须先发布审核过的句子修订',409,'teaching_revision_required');
    const teaching=item.issue?.correctedTeaching??item.teaching;
    validateTeachingAnchors(teaching,card.chinese,card.english);
    return {sentenceId:card.id,textVersion:card.version,textHash:teachingTextHash(card.chinese,card.english),teaching};
  });
  if(new Set(attachments.map(a=>a.sentenceId)).size!==cards.length)throw new SentenceStudyError('教学句子映射重复',422,'teaching_coverage');
  return {author,review,attachments,candidateHash,attention};
}

export async function applyTeachingEdition(tx:SqlWriter,material:MaterialRow,cards:SentenceCard[],author:unknown,review:unknown,mapping:Record<string,string>={},sourceCards:SentenceCard[]=[]){
  if(material.status!=='ready')throw new SentenceStudyError('材料已撤销',409,'material_changed');
  const result=compileTeachingEdition(material,cards,author,review,mapping,sourceCards),id=`teaching_${sha256Text(result.candidateHash+JSON.stringify(result.attachments)).slice(0,28)}`;
  await tx.run(sql`INSERT INTO sentence_teaching_editions(id,material_id,source_hash,candidate_hash,author_json,review_json,teachings_json,created_at) VALUES(${id},${material.id},${result.author.sourceHash},${result.candidateHash},${JSON.stringify(result.author)},${JSON.stringify(result.review)},${JSON.stringify(result.attachments)},${new Date().toISOString()}) ON CONFLICT(id) DO NOTHING`);
  return {id,sentences:result.attachments.length};
}

export async function readTeachingAttachments(db:SqlReader,materialIds:string[]){
  // Click paths need only the latest attachment, not every private author/review
  // artifact or older teaching revision. Audit reads those explicitly elsewhere.
  const rows=materialIds.length?await db.all<TeachingEditionRow>(sql`SELECT t.id,t.material_id,t.teachings_json,t.status FROM sentence_teaching_editions t WHERE t.material_id IN (${{sql:materialIds.map(()=>'?').join(','),args:materialIds}}) AND NOT EXISTS(SELECT 1 FROM sentence_teaching_editions newer WHERE newer.material_id=t.material_id AND (newer.created_at>t.created_at OR newer.created_at=t.created_at AND newer.id>t.id)) ORDER BY t.material_id`):[];
  const found=new Map<string,{attachment:TeachingAttachment;revision:string}>(),seen=new Set<string>();
  for(const row of rows){if(seen.has(row.material_id))continue;seen.add(row.material_id);if(row.status!=='ready')continue;
    for(const attachment of JSON.parse(row.teachings_json) as TeachingAttachment[])found.set(attachment.sentenceId,{attachment,revision:row.id});
  }
  return found;
}
export function withTeaching(card:SentenceCard,attachments:Awaited<ReturnType<typeof readTeachingAttachments>>):SentenceCard {
  const entry=attachments.get(card.id);return entry&&entry.attachment.textVersion===card.version&&entry.attachment.textHash===teachingTextHash(card.chinese,card.english)?{...card,teaching:entry.attachment.teaching,teachingRevision:entry.revision}:card;
}
