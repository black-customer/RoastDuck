import type {SqlReader} from '@/lib/platform/database';
import {query as sql} from '@/lib/platform/sql';
import type {MaterialRow,MaterialInput} from '@/lib/four-step/material-types';
import {currentReadyMaterialPredicate} from '@/lib/light-study/current-material';
import {materialFingerprint} from '@/lib/light-study/core-catalogue';
import {SENTENCE_VALIDATION_VERSION} from './materials';
import {SentenceStudyError,type SentenceCard,type SentenceScope,type SentenceSourceOption,type SentencePreference} from './contracts';
import {projectStoredSentenceHighlights,type StoredSentenceHighlight} from './highlights';
import {readTeachingAttachments,withTeaching} from './teaching-editions';
export interface SentenceProgress {sentence_id:string;first_seen_at:string;last_seen_at:string;due_at:string;fsrs_json:string;review_count:number;version:number;last_rating:string}
export interface SentenceExposure {sentence_id:string;unit_version:string;first_exposed_at:string;last_exposed_at:string;first_review_due_at:string}
export const sentenceIsTarget=(card:SentenceCard)=>!card.unavailable&&!card.preference?.hidden&&!card.preference?.selfKnown;
export const sentenceDueAt=(card:SentenceCard,progress:Map<string,SentenceProgress>)=>progress.get(card.id)?.due_at??card.firstReviewDueAt??null;
export const sentenceIsNew=(card:SentenceCard,progress:Map<string,SentenceProgress>)=>sentenceIsTarget(card)&&!progress.has(card.id)&&!card.firstExposedAt;
type EligibleMaterial=MaterialRow&{cache_fingerprint:string|null;cache_rule:string|null;cache_valid:number|null;title:string;question_en:string;part:number|null;topic_id:string|null;topic:string;actual_answer:string|null;actual_chinese:string|null};
export function sentenceGroup(card:SentenceCard){return card.source.questionId?`question:${card.source.questionId}`:`conversation:${card.source.id}`;}

/** No audit or AI in the click path: verify publication fingerprint, current source and preferences. */
export async function readSentenceCatalogue(db:SqlReader,scope:SentenceScope={type:'all'},now=new Date(),includeTeaching=true){
  const filters=scope.type==='collection'?scope:undefined;
  const where=scope.type==='question'?sql`pm.question_id=${scope.id}`:scope.type==='material'?sql`pm.id=${scope.id}`:scope.type==='conversation'?sql`pm.source_type='free_talk' AND pm.source_id=${scope.id}`:filters?sql`pm.source_type=${filters.id==='ielts'?'ielts_practice':'free_talk'}`:sql`1=1`;
  const materials=await db.all<EligibleMaterial>(sql`SELECT pm.*,v.fingerprint cache_fingerprint,v.rule_version cache_rule,v.valid cache_valid,
    COALESCE(NULLIF(q.text_zh,''),q.text,ft.title,'我的回答') title,COALESCE(q.text,'') question_en,q.part,t.id topic_id,COALESCE(NULLIF(t.name_zh,''),t.name_en,'未标注') topic,
    a.answer_text actual_answer,a.intended_meaning_zh actual_chinese
    FROM practice_materials pm LEFT JOIN material_validation_cache v ON v.material_id=pm.id LEFT JOIN questions q ON q.id=pm.question_id
    LEFT JOIN topics t ON t.id=q.topic_id LEFT JOIN speaking_question_attempts a ON pm.source_type='ielts_practice' AND a.id=pm.source_id
    LEFT JOIN free_talk_conversations ft ON pm.source_type='free_talk' AND ft.id=pm.source_id
    WHERE ${where} AND pm.contract_version='evidence_v2' AND ${{sql:currentReadyMaterialPredicate}}
    AND (${filters?.questionId?sql`pm.question_id=${filters.questionId}`:sql`1=1`})
    AND (${filters?.topicId?sql`q.topic_id=${filters.topicId}`:sql`1=1`})
    AND (${filters?.seasonId?sql`EXISTS(SELECT 1 FROM question_set_links sl WHERE sl.question_id=q.id AND sl.question_set_id=${filters.seasonId})`:sql`1=1`})
    AND NOT EXISTS(SELECT 1 FROM practice_answer_sources map JOIN personal_answers pa ON pa.id=map.answer_id WHERE map.attempt_id=pm.source_id AND pa.superseded_by_revision_id IS NOT NULL)
    ORDER BY julianday(COALESCE(a.created_at,pm.created_at)) DESC,
      COALESCE((SELECT pa.source_order FROM practice_answer_sources map JOIN personal_answers pa ON pa.id=map.answer_id WHERE map.attempt_id=pm.source_id),0) DESC,
      julianday(pm.created_at) DESC,pm.id DESC`);
  const valid=materials.filter(material=>{
    if(material.status!=='ready'||!material.cache_valid||material.cache_rule!==SENTENCE_VALIDATION_VERSION||material.cache_fingerprint!==materialFingerprint(material))return false;
    const input=JSON.parse(material.input_json) as MaterialInput;
    return material.source_type!=='ielts_practice'||input.actualAnswer===material.actual_answer&&input.intendedMeaningZh===material.actual_chinese;
  });
  // At default/question scope the latest published attempt owns the lesson; explicit material reads remain scoped.
  const seen=new Set<string>(),selected=valid.filter(m=>{const key=m.question_id?`q:${m.question_id}`:`c:${m.source_id}`;if(scope.type==='material')return true;if(seen.has(key))return false;seen.add(key);return true;});
  const selectedIds={sql:selected.map(()=>'?').join(',')||'NULL',args:selected.map(m=>m.id)};
  const rows=selected.length?await db.all<{id:string;body_json:string;version:string;material_id:string}>(sql`SELECT id,body_json,version,material_id FROM sentence_learning_units WHERE active=1 AND material_id IN (${selectedIds}) ORDER BY ordinal,id`):[];
  const progressRows=rows.length?await db.all<SentenceProgress>(sql`SELECT p.* FROM sentence_study_progress p JOIN sentence_learning_units u ON u.id=p.sentence_id WHERE u.active=1 AND u.material_id IN (${selectedIds})`):[];
  const progress=new Map(progressRows.map(p=>[p.sentence_id,p]));
  const exposureRows=rows.length?await db.all<SentenceExposure>(sql`SELECT e.* FROM sentence_exposures e JOIN sentence_learning_units u ON u.id=e.sentence_id AND u.version=e.unit_version WHERE u.active=1 AND u.material_id IN (${selectedIds})`):[];
  const exposures=new Map(exposureRows.map(e=>[`${e.sentence_id}:${e.unit_version}`,e]));
  const preferenceRows=rows.length?await db.all<{sentence_id:string;hidden:number;favorite:number;self_known:number;note:string;version:number}>(sql`SELECT p.* FROM sentence_preferences p JOIN sentence_learning_units u ON u.id=p.sentence_id WHERE u.active=1 AND u.material_id IN (${selectedIds})`):[];
  const preferences=new Map(preferenceRows.map(p=>[p.sentence_id,{hidden:!!p.hidden,favorite:!!p.favorite,selfKnown:!!p.self_known,note:p.note,version:p.version} satisfies SentencePreference]));
  const feedback=rows.length?await db.all<{sentence_id:string;unit_version:string}>(sql`SELECT DISTINCT f.sentence_id,f.unit_version FROM sentence_feedback f JOIN sentence_learning_units u ON u.id=f.sentence_id AND u.version=f.unit_version WHERE u.active=1 AND u.material_id IN (${selectedIds}) AND f.kind='incorrect' AND f.status='open'`):[];
  const highlights=rows.length?await db.all<StoredSentenceHighlight>(sql`SELECT h.* FROM sentence_highlights h JOIN sentence_learning_units u ON u.id=h.sentence_id WHERE u.active=1 AND u.material_id IN (${selectedIds}) AND h.state='active'`):[];
  const teaching=includeTeaching?await readTeachingAttachments(db,selected.map(m=>m.id)):new Map();
  const cards:SentenceCard[]=selected.flatMap(material=>rows.filter(r=>r.material_id===material.id).map(row=>{
    const card=JSON.parse(row.body_json) as SentenceCard;
    if(card.id!==row.id||card.version!==row.version||card.materialId!==material.id)throw new SentenceStudyError('句子资料已变化，暂时无法学习',409,'material_changed');
    const userHighlights=(['zh','en'] as const).flatMap(language=>projectStoredSentenceHighlights(highlights,{sentenceId:card.id,language,textVersion:card.version},language==='zh'?card.chinese:card.english).highlights);
    const exposure=exposures.get(`${card.id}:${card.version}`),preference=preferences.get(card.id)??{hidden:false,favorite:false,selfKnown:false,note:'',version:0};
    const available=withTeaching({...card,userHighlights,preference,firstExposedAt:exposure?.first_exposed_at??null,firstReviewDueAt:exposure?.first_review_due_at??null,progressVersion:progress.get(row.id)?.version??0,source:{...card.source,title:material.title}},teaching);
    return feedback.some(f=>f.sentence_id===card.id&&f.unit_version===card.version)?{...available,english:'',chinese:'这句已标记内容问题，等待确认。',contextZh:'',teaching:undefined,usages:[],notes:[],userHighlights:[],unavailable:'内容问题待确认'}:available;
  }));
  const seasons=await db.all<{question_id:string;id:string;name:string}>(sql`SELECT l.question_id,s.id,s.name_zh name FROM question_set_links l JOIN question_sets s ON s.id=l.question_set_id ORDER BY s.sort,s.id`);
  const sources:SentenceSourceOption[]=selected.map(m=>{
    const items=cards.filter(c=>c.materialId===m.id);
    return {id:m.question_id??m.source_id,type:m.question_id?'question':'conversation',title:m.title,textEn:m.question_en,part:m.part,topicId:m.topic_id,topic:m.topic,seasons:seasons.filter(s=>s.question_id===m.question_id).map(s=>({id:s.id,name:s.name})),materialId:m.id,totalCount:items.filter(c=>!c.unavailable).length,newCount:items.filter(c=>sentenceIsNew(c,progress)).length,dueCount:items.filter(c=>sentenceIsTarget(c)&&Date.parse(sentenceDueAt(c,progress)??'')<=now.getTime()).length,materialStatus:m.status,href:m.question_id?`/questions/${m.question_id}`:`/free-talk?conversation=${m.source_id}`};
  });
  return {cards,progress,exposures,sources,seasonLinks:seasons,materialStates:materials.map(m=>({questionId:m.question_id,status:m.status})),unavailableCount:materials.length-valid.length+cards.filter(c=>c.unavailable).length};
}
