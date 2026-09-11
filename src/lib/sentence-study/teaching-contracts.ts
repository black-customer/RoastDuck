import {z} from 'zod';
import {sha256Text} from '@/lib/platform/hash';

const text=z.string().trim().min(1).max(4000);
export const sentenceTeachingSchema=z.object({
  version:z.literal('sentence-teaching-v1'),
  overviewZh:text,
  parts:z.array(z.object({
    cueZh:text,quoteEn:text,explanationZh:text,
    pattern:z.string().max(800).default(''),
    examples:z.array(z.object({english:text,chinese:text})).max(2).default([]),
    alternatives:z.array(z.object({english:text,chinese:text,whenZh:text})).max(3).default([]),
    contrastZh:z.string().max(3000).default(''),
  })).min(1).max(30),
});
export type SentenceTeaching=z.infer<typeof sentenceTeachingSchema>;
export const teachingTextHash=(chinese:string,english:string)=>sha256Text(JSON.stringify([chinese,english]));
const teachingIssueSchema=z.object({reasonZh:text,suggestedChinese:z.string().default(''),suggestedEnglish:text,correctedTeaching:sentenceTeachingSchema,needsConfirmation:z.boolean().optional()});
export const teachingAuthorSchema=z.object({materialId:text,sourceHash:text,analysisHash:text,authorContext:text,runId:text,sentences:z.array(z.object({sentenceId:text,textVersion:text,teaching:sentenceTeachingSchema,issue:teachingIssueSchema.optional()})).min(1)});
export type TeachingAuthor=z.infer<typeof teachingAuthorSchema>;
export const teachingReviewSchema=z.object({candidateHash:text,reviewerContext:text,runId:text,approved:z.boolean(),partialApproval:z.boolean().optional(),sentences:z.array(z.object({sentenceId:text,approved:z.boolean(),decision:z.enum(['ready','needs_attention']).optional(),sourceQuote:text,reasonZh:text,meaningCovered:z.boolean(),naturalEnglish:z.boolean(),teachingCorrect:z.boolean(),examplesCorrect:z.boolean()})).min(1),coverageReasonZh:text});
export type TeachingReview=z.infer<typeof teachingReviewSchema>;
export const teachingCandidateHash=(candidate:unknown)=>sha256Text(JSON.stringify(teachingAuthorSchema.parse(candidate)));

/** Shape and literal anchors are safeguards, never a linguistic content approval. */
export function validateTeachingAnchors(teaching:SentenceTeaching,chinese:string,english:string){
  const coverage=new Uint8Array(chinese.length);
  for(const part of teaching.parts){
    const zh=chinese.indexOf(part.cueZh),en=english.indexOf(part.quoteEn);
    if(zh<0||en<0)throw new Error('讲解片段必须准确引用当前中英文句子');
    let index=-1;while((index=chinese.indexOf(part.cueZh,index+1))>=0)coverage.fill(1,index,index+part.cueZh.length);
  }
  for(let i=0;i<chinese.length;i++)if(!coverage[i]&&!/[\s\p{P}]/u.test(chinese[i]))throw new Error('教学没有覆盖完整中文意思');
}
