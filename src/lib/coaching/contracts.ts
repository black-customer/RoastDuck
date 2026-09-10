import {z} from 'zod';
import {AiProviderError} from '@/lib/ai/errors';

export const coachingModeSchema=z.enum(['sentence_guided','answer_guided','answer_independent']);
export type CoachingMode=z.infer<typeof coachingModeSchema>;
export const coachingContextSchema=z.object({
  materialId:z.string().min(1).max(160),sentenceId:z.string().min(1).max(160).optional(),
  practiceId:z.string().min(8).max(160),
  questionId:z.string().min(1).max(160).optional(),mode:coachingModeSchema,
}).refine(v=>v.mode!=='sentence_guided'||!!v.sentenceId,'单句练习需要句子编号');
export type CoachingContext=z.infer<typeof coachingContextSchema>;
export const coachingSubmitSchema=z.object({
  context:coachingContextSchema,clientMessageId:z.string().min(8).max(160),text:z.string().trim().min(1).max(12000),
  correctionHint:z.boolean().default(false),retryFailed:z.boolean().default(false),retryUnknown:z.boolean().default(false),
});
export type CoachingSubmit=z.infer<typeof coachingSubmitSchema>;
export const coachingFindingSchema=z.object({
  kind:z.enum(['confirmed_error','style_suggestion','uncertain']),sourceQuote:z.string().min(1).max(1200),
  correction:z.string().max(1600),explanationZh:z.string().min(1).max(700),
  memoryKey:z.string().regex(/^[a-z0-9][a-z0-9_-]{2,99}$/),
});
export const coachingFeedbackSchema=z.object({
  verdict:z.enum(['natural','incorrect','context_difference','uncertain']),
  extent:z.enum(['full_answer','local_correction','uncertain']),
  messages:z.array(z.object({text:z.string().min(1).max(1500),translationZh:z.string().max(1800).default('')})).min(1).max(2),
  findings:z.array(coachingFindingSchema).max(12),
  usedMemoryIds:z.array(z.string().max(160)).max(2).default([]),
});
export type CoachingFeedback=z.infer<typeof coachingFeedbackSchema>;
/** Provider-side semantic validation runs before a paid response is marked reusable/completed. */
export function assertCoachingFeedback(data:unknown,input:unknown){
  const result=coachingFeedbackSchema.parse(data),source=z.object({latestUserMessage:z.string(),correctionHint:z.boolean(),currentTask:z.object({mode:coachingModeSchema}),relevantMemories:z.array(z.object({id:z.string()}))}).parse(input);
  const max=source.currentTask.mode==='sentence_guided'?1:2;
  if(result.usedMemoryIds.length>max||new Set(result.usedMemoryIds).size!==result.usedMemoryIds.length||result.usedMemoryIds.some(id=>!source.relevantMemories.some(m=>m.id===id)))throw new AiProviderError('回复引用了未提供的学习记忆','invalid_output',true);
  if(result.findings.some(f=>!source.latestUserMessage.includes(f.sourceQuote)))throw new AiProviderError('反馈证据不属于本次输出','invalid_output',true);
  if(result.verdict==='natural'&&result.findings.some(f=>f.kind==='confirmed_error'))throw new AiProviderError('反馈结论与证据矛盾','invalid_output',true);
  if(source.correctionHint&&result.extent==='full_answer')throw new AiProviderError('局部修正被误判为整题回答','invalid_output',true);
}
export const learningErrorReviewSchema=z.object({
  decisions:z.array(z.object({index:z.number().int().nonnegative(),confirmed:z.boolean(),sourceQuote:z.string().max(1200),
    reasonZh:z.string().min(1).max(700),confidence:z.number().min(0).max(1),
  })).max(12),
});
export interface CoachingMaterial {
  materialId:string;questionId:string|null;questionEn:string;questionZh:string;sourceType:string;sourceId:string;
  sentences:Array<{id:string;chinese:string;english:string;notes?:unknown}>;referenceText:string;
}
export interface CoachingMessageView {
  id:string;role:'user'|'teacher';text:string;status:string;clientMessageId:string;createdAt:string;
  feedback?:CoachingFeedback;replyTo?:string;errorCode?:string;assisted:boolean;correctionHint?:boolean;
}
export interface CoachingView {
  threadId:string|null;context:CoachingContext;questionEn:string;questionZh:string;chinese:string|null;
  messages:CoachingMessageView[];pendingMemoryJobs:number;
}
export interface LearningErrorReviewInput {
  kind:'coaching_error_review_v1';threadId:string;messageId:string;text:string;
  intentZh:string;questionEn:string;mode:CoachingMode;assisted:boolean;generatorRunId:string;
  findings:Array<z.infer<typeof coachingFindingSchema>>;
}
