import {nodeDatabase} from '@/lib/platform/node/database';
import {query as sql} from '@/lib/platform/sql';
import {readSentenceCatalogue} from '@/lib/sentence-study/catalogue';
import type {QuestionFilters} from './schemas';
import {getQuestionDetail,type QuestionListItem,type QuestionTopicSummary} from './service';
import {questionFiltersSchema} from './schemas';
import type {QuestionState} from './activity';
type QuestionRow={id:string;part:number;text:string;text_zh:string;topic_id:string|null;topic_zh:string;topic_en:string;favorite:number;answer_count:number;latest_answer:string|null;latest_status:string|null;last_at:string|null;self_known:number;reattempts:number;open_gaps:number;repeated_gaps:number};
export async function listSentenceQuestions(filters:QuestionFilters,onlyId?:string,excludedIds:readonly string[]=[]){return nodeDatabase.read(async db=>{
  const now=new Date(),catalogue=await readSentenceCatalogue(db,onlyId?{type:'question',id:onlyId}:{type:'all'},now),sources=new Map(catalogue.sources.filter(s=>s.type==='question').map(s=>[s.id,s]));
  const rows=await db.all<QuestionRow>(sql`SELECT q.*,COALESCE(t.name_zh,'') topic_zh,COALESCE(t.name_en,'') topic_en,
    EXISTS(SELECT 1 FROM question_favorites f WHERE f.question_id=q.id) favorite,
    (SELECT COUNT(*) FROM speaking_question_attempts a WHERE a.question_id=q.id)+(SELECT COUNT(*) FROM personal_answers p WHERE p.question_id=q.id AND p.superseded_by_revision_id IS NULL AND NOT EXISTS(SELECT 1 FROM practice_answer_sources s WHERE s.answer_id=p.id)) answer_count,
    (SELECT a.id FROM speaking_question_attempts a WHERE a.question_id=q.id ORDER BY julianday(a.created_at) DESC,a.id DESC LIMIT 1) latest_answer,
    (SELECT a.status FROM speaking_question_attempts a WHERE a.question_id=q.id ORDER BY julianday(a.created_at) DESC,a.id DESC LIMIT 1) latest_status,
    (SELECT MAX(a.created_at) FROM speaking_question_attempts a WHERE a.question_id=q.id) last_at,
    COALESCE((SELECT m.mastered FROM question_mastery m WHERE m.question_id=q.id),0) self_known,
    (SELECT COUNT(*) FROM answer_drafts d JOIN speaking_question_attempts a ON a.id=d.submitted_attempt_id WHERE d.question_id=q.id AND d.kind='independent' AND d.english_committed_at IS NOT NULL AND a.status='completed') reattempts,
    (SELECT COUNT(*) FROM answer_gaps g JOIN personal_answers p ON p.id=g.answer_id WHERE p.question_id=q.id AND p.superseded_by_revision_id IS NULL AND g.status='open' AND g.reviewer_decision IN ('approved','edited')) open_gaps,
    (SELECT COUNT(*) FROM answer_gaps g JOIN personal_answers p ON p.id=g.answer_id JOIN gap_clusters c ON c.id=g.cluster_id WHERE p.question_id=q.id AND p.superseded_by_revision_id IS NULL AND g.status='open' AND g.reviewer_decision IN ('approved','edited') AND c.occurrence_count>1) repeated_gaps
    FROM questions q LEFT JOIN topics t ON t.id=q.topic_id WHERE q.part IN (1,2,3) AND (${onlyId?sql`q.id=${onlyId}`:sql`1=1`}) ORDER BY q.part,q.id`);
  const sets=await db.all<{question_id:string;id:string;name:string;source_slug:string;source_page:number}>(sql`SELECT l.question_id,s.id,s.name_zh name,l.source_slug,l.source_page FROM question_set_links l JOIN question_sets s ON s.id=l.question_set_id ORDER BY s.sort,s.id`);
  const mapped=rows.map(q=>{
    const source=sources.get(q.id),total=source?.totalCount??0,remaining=source?.newCount??0;
    const state:QuestionState=total?(remaining?'learning_incomplete':'learning_completed'):q.latest_status==='processing'?'analysis_pending':q.latest_status==='failed'?'analysis_failed':q.answer_count?'materials_pending':'unanswered';
    const detail=`/questions/${encodeURIComponent(q.id)}`,materials=q.latest_answer?`${detail}/attempts/${encodeURIComponent(q.latest_answer)}`:detail;
    const primaryAction=total?{label:remaining?'学习本题句子':source!.dueCount?'复习本题句子':'查看本题材料',href:remaining||source!.dueCount?`/sentence-study?scope=question&id=${encodeURIComponent(q.id)}&mode=${remaining?'learn':'review'}`:detail}:{label:state==='unanswered'?'开始回答':state==='analysis_pending'?'查看处理进度':state==='analysis_failed'?'查看原因并重试':'查看本题材料',href:state==='unanswered'?`${detail}/practice`:materials};
    const labels:Partial<Record<QuestionState,string>>={unanswered:'未作答',learning_incomplete:'有新句子待学',learning_completed:'句子已过首轮',analysis_pending:'材料处理中',analysis_failed:'分析失败',materials_pending:'材料待处理'};
    const last=catalogue.cards.filter(c=>c.source.questionId===q.id).flatMap(c=>catalogue.progress.has(c.id)?[catalogue.progress.get(c.id)!.last_seen_at]:[]).sort().at(-1);
    const item:QuestionListItem={id:q.id,part:q.part,textEn:q.text,textZh:q.text_zh,topicId:q.topic_id,topicZh:q.topic_zh,topicEn:q.topic_en,setNames:[...new Set(sets.filter(s=>s.question_id===q.id).map(s=>s.name))],answered:q.answer_count>0,favorite:!!q.favorite,sourceCount:new Set(sets.filter(s=>s.question_id===q.id).map(s=>s.source_slug+':'+s.source_page)).size,lastPracticedAt:q.last_at,answerCount:q.answer_count,learningUnitCount:total,requiredRemaining:remaining,openGapCount:q.open_gaps,repeatedGapCount:q.repeated_gaps,reattemptCount:q.reattempts,state,stateLabel:labels[state]??'查看材料',primaryAction,interactiveQuestion:{contentType:'question',contentId:q.id,text:q.text,annotations:[]},daysSinceReview:last?Math.max(0,Math.floor((now.getTime()-Date.parse(last))/86400000)):null,isMastered:!!q.self_known,fourStepCompletedAt:null};return item;
  });
  const filtered=mapped.filter(q=>{
    if(excludedIds.includes(q.id))return false;
    if(filters.part&&q.part!==filters.part||filters.topic&&q.topicId!==filters.topic||filters.set&&!sets.some(s=>s.question_id===q.id&&s.id===filters.set)||filters.favorite&&!q.favorite)return false;
    if(filters.q&&!`${q.textEn} ${q.textZh} ${q.topicZh} ${q.topicEn}`.toLowerCase().includes(filters.q.toLowerCase()))return false;
    switch(filters.status){case'answered':case'has_history':return q.answered;case'unanswered':return !q.answered;case'learning_incomplete':case'ready_to_learn':return q.requiredRemaining>0;case'learning_completed':case'ready_to_reattempt':return q.learningUnitCount>0&&q.requiredRemaining===0;case'has_learning':return q.learningUnitCount>0;case'mastered':return q.isMastered;case'reattempted':return q.reattemptCount>0;case'repeated_gaps':return q.repeatedGapCount>0;default:return true;}
  });
  if(filters.sortBy==='latest')filtered.sort((a,b)=>(b.lastPracticedAt??'').localeCompare(a.lastPracticedAt??''));
  if(filters.sortBy==='longest_unreviewed')filtered.sort((a,b)=>(b.daysSinceReview??1e6)-(a.daysSinceReview??1e6));
  const items=filtered.slice((filters.page-1)*filters.pageSize,filters.page*filters.pageSize);
  if(items.length){const ids={sql:items.map(()=>'?').join(','),args:items.map(q=>q.id)};const annotations=await db.all<{id:string;content_id:string;start_offset:number;end_offset:number;surface:string}>(sql`SELECT * FROM text_annotations WHERE content_type='question' AND content_id IN (${ids}) ORDER BY start_offset,end_offset DESC`);for(const q of items)q.interactiveQuestion.annotations=annotations.filter(a=>a.content_id===q.id).map(a=>({id:a.id,start:a.start_offset,end:a.end_offset,surface:a.surface}));}
  const topics:QuestionTopicSummary[]=[...new Set(mapped.map(q=>q.topicId).filter((id):id is string=>!!id))].map(id=>{const group=mapped.filter(q=>q.topicId===id);return {id,nameZh:group[0].topicZh,nameEn:group[0].topicEn,part:group[0].part,questionCount:group.length};});
  return {items,total:filtered.length,page:filters.page,pageSize:filters.pageSize,pageCount:Math.max(1,Math.ceil(filtered.length/filters.pageSize)),totalPages:Math.ceil(filtered.length/filters.pageSize),topics};
});}
export async function getWebQuestionDetail(id:string){const original=await getQuestionDetail(id);if(!original)return null;const result=await listSentenceQuestions(questionFiltersSchema.parse({}),id);return {...original,...result.items[0]};}
export async function randomSentenceQuestion(filters:QuestionFilters){
  const recent=await nodeDatabase.read(db=>db.all<{question_id:string}>(sql`SELECT question_id FROM question_attempts WHERE origin='random' AND status='viewed' ORDER BY created_at DESC LIMIT 20`));
  const excluded=recent.map(r=>r.question_id),first=await listSentenceQuestions({...filters,page:1,pageSize:1},undefined,excluded);
  if(!first.total)return null;
  const page=1+Math.floor(Math.random()*first.total);
  return page===1?first.items[0]:(await listSentenceQuestions({...filters,page,pageSize:1},undefined,excluded)).items[0]??null;
}
