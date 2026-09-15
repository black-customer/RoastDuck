import {z} from 'zod';
import {AiProviderError} from '@/lib/ai/errors';
const id=z.string().min(1).max(160);
export const contextPracticeCreateSchema=z.object({clientRequestId:id,materialId:id,origin:z.enum(['bank','teacher_generated']),questionId:id.optional(),sourceSentenceIds:z.array(id).max(9).optional(),sourceMemoryIds:z.array(id).max(2).optional()}).refine(input=>input.origin!=='bank'||!!input.questionId,'请选择关联题目');
export type ContextPracticeCreate=z.infer<typeof contextPracticeCreateSchema>;
export const relatedQuestionSchema=z.object({promptEn:z.string().trim().min(8).max(1200),promptZh:z.string().trim().min(2).max(1200),targetSentenceIds:z.array(id).max(2),targetMemoryIds:z.array(id).max(2),rationaleZh:z.string().trim().min(1).max(700)});
export function assertRelatedQuestion(data:unknown,raw:unknown){
  const result=relatedQuestionSchema.parse(data),input=z.object({sourceQuestion:z.object({textEn:z.string()}),targets:z.array(z.object({id:z.string()})),memories:z.array(z.object({id:z.string()}))}).parse(raw);
  const sentenceIds=result.targetSentenceIds,memoryIds=result.targetMemoryIds;
  if(sentenceIds.length+memoryIds.length>2||new Set(sentenceIds).size!==sentenceIds.length||new Set(memoryIds).size!==memoryIds.length||sentenceIds.some(id=>!input.targets.some(target=>target.id===id))||memoryIds.some(id=>!input.memories.some(memory=>memory.id===id))||result.promptEn.trim().toLowerCase()===input.sourceQuestion.textEn.trim().toLowerCase())throw new AiProviderError('相关问题未通过来源校验','invalid_output',true);
}
export interface RelatedQuestionCandidate {questionId:string;promptEn:string;promptZh:string;topicId:string;topic:string}
export interface ContextPracticeTask {id:string;materialId:string;sourceQuestionId:string|null;questionId:string|null;sourceSentenceIds:string[];sourceMemoryIds:string[];promptEn:string;promptZh:string;origin:'bank'|'teacher_generated';status:'ready'|'generating'|'failed'|'completed'|'dismissed';version:number;errorCode:string|null;createdAt:string;updatedAt:string}
export interface ContextPracticeTaskRow {id:string;client_request_id:string;input_hash:string;material_id:string;source_question_id:string|null;question_id:string|null;source_sentence_ids_json:string;source_memory_ids_json:string;prompt_en:string;prompt_zh:string;origin:ContextPracticeTask['origin'];status:ContextPracticeTask['status'];request_json:string;run_id:string|null;error_code:string|null;version:number;created_at:string;updated_at:string}
export const projectContextTask=(row:ContextPracticeTaskRow):ContextPracticeTask=>({id:row.id,materialId:row.material_id,sourceQuestionId:row.source_question_id,questionId:row.question_id,sourceSentenceIds:JSON.parse(row.source_sentence_ids_json),sourceMemoryIds:JSON.parse(row.source_memory_ids_json),promptEn:row.prompt_en,promptZh:row.prompt_zh,origin:row.origin,status:row.status,version:row.version,errorCode:row.error_code,createdAt:row.created_at,updatedAt:row.updated_at});
