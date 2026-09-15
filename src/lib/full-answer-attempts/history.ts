import type {SqlReader} from '@/lib/platform/database';
import {query as sql} from '@/lib/platform/sql';
import type {FullAnswer} from '@/lib/answer-audio/contracts';

export async function answerIsRevision(db:SqlReader,refs:FullAnswer['refs']){
  if(refs.draftId||refs.attemptId){
    const [draft]=await db.all<{kind:string}>(sql`SELECT kind FROM answer_drafts WHERE id=${refs.draftId??null} OR submitted_attempt_id=${refs.attemptId??null} LIMIT 1`);
    if(draft?.kind==='edit')return true;
  }
  if(refs.coachingMessageId){
    const [message]=await db.all<{metadata_json:string}>(sql`SELECT metadata_json FROM companion_messages WHERE id=${refs.coachingMessageId}`);
    const metadata=message?JSON.parse(message.metadata_json):{};
    if(metadata.correctionHint||metadata.payload?.correctionHint)return true;
    const replies=await db.all<{metadata_json:string}>(sql`SELECT metadata_json FROM companion_messages WHERE role='teacher' AND json_extract(metadata_json,'$.replyTo')=${refs.coachingMessageId}`);
    if(replies.some(row=>JSON.parse(row.metadata_json).feedback?.extent==='local_correction'))return true;
  }
  return false;
}
/** Read-only projection: original IDs and dates stay authoritative; GET creates no new attempt. */
export async function projectHistoricalAnswers(db:SqlReader,questionId:string,current:FullAnswer[]):Promise<FullAnswer[]>{
  const result:FullAnswer[]=[],seenAttempts=new Set(current.map(a=>a.refs.attemptId).filter(Boolean)),seenDrafts=new Set(current.map(a=>a.refs.draftId).filter(Boolean)),seenMessages=new Set(current.map(a=>a.refs.coachingMessageId).filter(Boolean));
  const rows=await db.all<{id:string;answer_text:string;intended_meaning_zh:string;created_at:string;updated_at:string;draft_id:string|null;kind:string|null;english_committed_at:string|null}>(sql`SELECT a.id,a.answer_text,a.intended_meaning_zh,a.created_at,a.updated_at,d.id draft_id,d.kind,d.english_committed_at FROM speaking_question_attempts a LEFT JOIN answer_drafts d ON d.submitted_attempt_id=a.id WHERE a.question_id=${questionId} AND a.status NOT IN ('deleted','removed') AND TRIM(a.answer_text||a.intended_meaning_zh)!='' AND NOT EXISTS(SELECT 1 FROM practice_answer_sources s JOIN personal_answers p ON p.id=s.answer_id WHERE s.attempt_id=a.id AND (p.superseded_by_revision_id IS NOT NULL OR p.status IN ('deleted','removed'))) ORDER BY a.created_at,a.id`);
  for(const row of rows){
    if(seenAttempts.has(row.id)||row.draft_id&&seenDrafts.has(row.draft_id)||row.kind==='edit')continue;seenAttempts.add(row.id);
    const independent=row.kind==='independent'&&!!row.english_committed_at;
    result.push({id:row.id,questionId,sourceKey:`legacy-attempt:${row.id}`,stage:independent?'independent':'initial',promptCondition:independent?'历史无提示回答，英文已封存':'历史回答，提示条件未记录',materialId:null,text:[row.answer_text,row.intended_meaning_zh].filter(Boolean).join('\n\n'),refs:{attemptId:row.id,...(row.draft_id?{draftId:row.draft_id}:{})},createdAt:row.created_at,updatedAt:row.updated_at,audio:[],legacy:true,countsAsAttempt:true,sourceHref:`/questions/${encodeURIComponent(questionId)}/attempts/${encodeURIComponent(row.id)}`});
  }
  const saved=await db.all<{id:string;raw_text:string;created_at:string;updated_at:string}>(sql`SELECT p.id,p.raw_text,p.created_at,p.updated_at FROM personal_answers p WHERE p.question_id=${questionId} AND p.superseded_by_revision_id IS NULL AND p.status NOT IN ('deleted','removed','draft') AND TRIM(p.raw_text)!='' AND NOT EXISTS(SELECT 1 FROM practice_answer_sources s WHERE s.answer_id=p.id) ORDER BY p.created_at,p.id`);
  for(const row of saved)result.push({id:row.id,questionId,sourceKey:`legacy-answer:${row.id}`,stage:'initial',promptCondition:'历史原回答，提示条件未记录',materialId:null,text:row.raw_text,refs:{},createdAt:row.created_at,updatedAt:row.updated_at,audio:[],legacy:true,countsAsAttempt:true,sourceHref:`/questions/${encodeURIComponent(questionId)}`});
  const outputs=await db.all<{id:string;text:string;created_at:string;metadata_json:string;source_id:string}>(sql`SELECT m.id,m.text,m.created_at,m.metadata_json,m.source_id FROM companion_messages m JOIN companion_threads t ON t.id=m.thread_id WHERE m.role='user' AND m.source_type='coaching_output' AND t.status!='deleted' AND json_extract(m.metadata_json,'$.context.questionId')=${questionId} ORDER BY m.created_at,m.sequence_no,m.id`);
  const practices=new Set<string>();
  for(const row of outputs){
    const meta=JSON.parse(row.metadata_json),context=meta.context??{};
    if(context.mode==='sentence_guided'||!context.practiceId||meta.correctionHint||meta.payload?.correctionHint)continue;
    const practice=String(context.practiceId);if(practices.has(practice))continue;
    const replies=await db.all<{metadata_json:string}>(sql`SELECT metadata_json FROM companion_messages WHERE role='teacher' AND json_extract(metadata_json,'$.replyTo')=${row.id}`);
    if(!replies.some(reply=>JSON.parse(reply.metadata_json).feedback?.extent==='full_answer'))continue;
    practices.add(practice);if(seenMessages.has(row.id)||current.some(a=>a.sourceKey===`coaching:${practice}`))continue;
    result.push({id:row.id,questionId,sourceKey:`coaching:${practice}`,stage:context.relatedTaskId?'transfer':context.mode==='answer_independent'?'independent':'guided',promptCondition:context.mode==='answer_independent'?'历史无提示输出；以原帮助记录为准':'历史中文辅助整题输出',materialId:row.source_id,text:row.text,refs:{coachingMessageId:row.id,...(context.relatedTaskId?{taskId:context.relatedTaskId}:{})},createdAt:row.created_at,updatedAt:row.created_at,audio:[],legacy:true,countsAsAttempt:true});
  }
  return result;
}
