import {z} from 'zod';
import type {SentenceHighlight} from './highlights';
import type {SentenceTeaching} from './teaching-contracts';
export const sentenceScopeSchema=z.discriminatedUnion('type',[
  z.object({type:z.literal('all')}),
  z.object({type:z.enum(['question','material','conversation']),id:z.string().min(1).max(160)}),
  z.object({type:z.literal('collection'),id:z.enum(['ielts','free_talk']),questionId:z.string().optional(),topicId:z.string().optional(),seasonId:z.string().optional()}),
]);
export type SentenceScope=z.infer<typeof sentenceScopeSchema>;
export type SentenceMode='learn'|'review';
export type SentenceRating='remembered'|'uncertain'|'forgot';
export interface SentenceCard {
  id:string;version:string;materialId:string;sentenceId:string;ordinal:number;
  chinese:string;english:string;contextZh:string;meaningOrigin:'user_chinese'|'derived_from_english';
  usages:Array<{id:string;text:string;meaningZh:string;start:number;end:number;kind:'confirmed_error'|'preparation'}>;
  notes:Array<{id:string;textZh:string;kind:'correction'|'suggestion';evidence:string}>;
  source:{type:'ielts_practice'|'free_talk';id:string;questionId:string|null;title:string;href:string};
  progressVersion:number;
  userHighlights?:SentenceHighlight[];
  teaching?:SentenceTeaching;
  teachingRevision?:string;
  unavailable?:string;
}
export interface SentenceAssessment {sentenceId:string;rating:SentenceRating;at:string;eventId:string}
export type SentenceStage='recall'|'teaching'|'rated'|'retry'|'retry_reveal';
export interface SentencePractice {revealCount:number;maxRevealCount:number;draft:string;retryDraft:string;retryAttempt:number}
export const emptySentencePractice=():SentencePractice=>({revealCount:0,maxRevealCount:0,draft:'',retryDraft:'',retryAttempt:0});
export const sentenceWordCount=(english:string)=>(english.match(/\S+\s*/gu)??[]).length;
export interface SentenceSession {
  id:string;scope:SentenceScope;mode:SentenceMode;status:'active'|'paused'|'completed';version:number;
  cards:SentenceCard[];index:number;revealed:boolean;assessments:SentenceAssessment[];
  lastRatingEventId:string|null;nextDueAt:string|null;notice:string|null;
  experienceVersion?:'guided-reveal-v1';stage?:SentenceStage;practice?:SentencePractice;
}
export interface SentenceSourceOption {
  id:string;type:'question'|'conversation';title:string;textEn:string;part:number|null;topicId:string|null;topic:string;
  seasons:Array<{id:string;name:string}>;materialId:string|null;totalCount:number;newCount:number;dueCount:number;
  materialStatus:string|null;href:string;
}
export interface SentenceOverview {
  scope:SentenceScope;newCount:number;dueCount:number;totalCount:number;studiedCount:number;unavailableCount:number;
  resumable:Partial<Record<SentenceMode,{id:string;index:number;total:number;title:string}>>;
  sources:SentenceSourceOption[];
}
const id=z.string().min(1).max(160),base={clientEventId:id,version:z.number().int().nonnegative(),experienceVersion:z.literal('guided-reveal-v1').optional()};
export const sentenceCreateSchema=z.object({scope:sentenceScopeSchema,mode:z.enum(['learn','review']),clientRequestId:id,resumeSessionId:id.optional(),selection:z.enum(['scope','random','due']).default('scope'),experienceVersion:z.literal('guided-reveal-v1').optional()});
const unitEvent={...base,sentenceId:id,unitVersion:id};
export const sentenceEventSchema=z.discriminatedUnion('type',[
  z.object({...base,type:z.literal('reveal'),sentenceId:id,unitVersion:id}),
  z.object({...base,type:z.literal('rate'),sentenceId:id,unitVersion:id,rating:z.enum(['remembered','uncertain','forgot'])}),
  z.object({...base,type:z.literal('revise_rating'),targetEventId:id,rating:z.enum(['remembered','uncertain','forgot'])}),
  z.object({...base,type:z.literal('pause')}),
  z.object({...base,type:z.literal('resume')}),
  z.object({...base,type:z.literal('upgrade_experience')}),
  z.object({...unitEvent,type:z.literal('checkpoint'),revealCount:z.number().int().nonnegative(),maxRevealCount:z.number().int().nonnegative(),draft:z.string().max(12000),retryDraft:z.string().max(12000)}),
  z.object({...unitEvent,type:z.enum(['enter_teaching','start_retry','reveal_retry','advance'])}),
]);
export type SentenceEvent=z.infer<typeof sentenceEventSchema>;
export type SentenceCreate=z.input<typeof sentenceCreateSchema>;
export class SentenceStudyError extends Error {constructor(message:string,public status=409,public code='sentence_study_error'){super(message);}}

/** Shared optimistic projection. Authority checks and FSRS run only in the server transaction. */
export function projectSentenceEvent(view:SentenceSession,event:SentenceEvent,at=new Date().toISOString()):SentenceSession {
  const next:SentenceSession=structuredClone(view);next.version++;
  if(event.type==='upgrade_experience'){
    if(!next.experienceVersion){next.experienceVersion='guided-reveal-v1';next.stage=next.revealed?'teaching':'recall';next.practice=emptySentencePractice();}
    return next;
  }
  if(event.type==='pause'){next.status=next.index>=next.cards.length?'completed':'paused';return next;}
  if(event.type==='resume'){next.status=next.index>=next.cards.length?'completed':'active';return next;}
  if(event.type==='revise_rating'){
    const item=next.assessments.find(a=>a.eventId===event.targetEventId);
    if(!item||next.lastRatingEventId!==event.targetEventId)throw new SentenceStudyError('只能修改本次学习最近一次自评',409,'rating_changed');
    item.rating=event.rating;return next;
  }
  const card=next.cards[next.index];
  if(!card||card.id!==event.sentenceId||card.version!==event.unitVersion||next.status!=='active')throw new SentenceStudyError('学习位置已变化，请恢复最新位置',409,'version_conflict');
  if(next.experienceVersion==='guided-reveal-v1'){
    const stage=next.stage??'recall',practice=next.practice??emptySentencePractice();next.practice=practice;
    const assessed=next.assessments.some(a=>a.sentenceId===card.id);
    if(event.type==='checkpoint'){
      const count=sentenceWordCount(card.english);
      if(event.revealCount>count||event.maxRevealCount>count||event.revealCount>event.maxRevealCount)throw new SentenceStudyError('揭晓位置无效',422,'invalid_checkpoint');
      if(stage==='recall')Object.assign(practice,{revealCount:event.revealCount,maxRevealCount:Math.max(practice.maxRevealCount,event.maxRevealCount),draft:event.draft});
      else if(stage==='retry')practice.retryDraft=event.retryDraft;
      else throw new SentenceStudyError('此阶段不能修改回想草稿',409,'stage_changed');
      return next;
    }
    if(event.type==='enter_teaching'||event.type==='reveal'){
      if(stage!=='recall')throw new SentenceStudyError('已进入讲解，请恢复当前步骤',409,'stage_changed');
      next.stage='teaching';next.revealed=true;return next;
    }
    if(event.type==='rate'){
      if(stage!=='teaching'||assessed)throw new SentenceStudyError('本句已经评分或尚未查看讲解',409,'rating_changed');
      next.assessments.push({sentenceId:card.id,rating:event.rating,at,eventId:event.clientEventId});next.lastRatingEventId=event.clientEventId;next.stage='rated';return next;
    }
    if(event.type==='start_retry'){
      if(!assessed||!['rated','retry_reveal'].includes(stage))throw new SentenceStudyError('请先完成本句自评',409,'rating_required');
      next.stage='retry';next.revealed=false;practice.retryDraft='';practice.retryAttempt++;return next;
    }
    if(event.type==='reveal_retry'){
      if(stage!=='retry')throw new SentenceStudyError('当前没有再练草稿',409,'stage_changed');
      next.stage='retry_reveal';next.revealed=true;return next;
    }
    if(event.type==='advance'){
      if(!assessed||!['rated','retry','retry_reveal'].includes(stage))throw new SentenceStudyError('请先评价本句回想',409,'rating_required');
      next.index++;next.revealed=false;next.stage='recall';next.practice=emptySentencePractice();next.status=next.index>=next.cards.length?'completed':'active';return next;
    }
  }
  if(event.type!=='reveal'&&event.type!=='rate')throw new SentenceStudyError('请先更新学习体验',409,'experience_required');
  if(event.type==='reveal'){next.revealed=true;return next;}
  if(!next.revealed)throw new SentenceStudyError('先看自然表达，再评价刚才的回想',409,'reveal_required');
  next.assessments.push({sentenceId:card.id,rating:event.rating,at,eventId:event.clientEventId});next.lastRatingEventId=event.clientEventId;
  next.index++;next.revealed=false;next.status=next.index>=next.cards.length?'completed':'active';return next;
}
