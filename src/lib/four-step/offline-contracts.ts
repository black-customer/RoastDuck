import { z } from "zod";
import { hash } from "./shared";
import { diagnosisSchema, storedMaterialDraftSchema, recallFieldsSchema,recallEvidenceReviewSchema,evidencedSelectionReviewSchema, evidenceReviewSchema,spokenEvidenceReviewSchema, validateDiagnosis } from "./selection-contracts";

const t=z.string().min(1);
export const recoverySourceSchema=z.object({
  key:t,kind:z.enum(["attempt","personal_answer"]),createdAt:t,questionId:t,questionEn:z.string(),questionZh:z.string(),part:z.number(),english:z.string(),chinese:z.string(),mode:t,index:z.number(),hash:t,
  spokenStyleVersion:z.enum(['personal-spoken-v1','personal-spoken-v2']).optional(),
  selectionPolicyVersion:z.literal('evidence-exclusion-v1').optional(),
  inputFormat:z.literal('mixed-v1').optional(),rawInput:z.string().optional(),
  en:z.array(z.object({index:z.number(),start:z.number(),end:z.number(),text:z.string()})),
  zh:z.array(z.object({index:z.number(),start:z.number(),end:z.number(),text:z.string()})),
});
export type RecoverySource=z.infer<typeof recoverySourceSchema>;
export const revisionBasisSchema=z.object({materialId:t,inputHash:t,analysisHash:t,sourceHash:t});
export const priorLearningItemSchema=z.object({rowIndex:z.number().int().min(0),learningItemId:t,targetEnglish:t,intentionZh:t});
export const authoredMaterialSchema=z.object({
  index:z.number(),sourceHash:t,model:t,contextId:t,
  revisionBasis:revisionBasisSchema.optional(),
  units:z.array(z.object({
    en:z.array(z.number().int()).default([]),zh:z.array(z.number().int()).default([]),
    // 可选原文子串，用于拆分一个长 ASR 片段；和索引引用同样验证全文覆盖。
    enQuotes:z.array(t).default([]),zhQuotes:z.array(t).default([]),
    intent:t,status:z.enum(["natural","repair","missing","uncertain","non_answer"]),reason:t,
    english:z.string().default(""),
    gaps:z.array(z.object({cue:t,target:t,quote:t,why:t,surface:t,variants:z.array(t).default([]),senseKey:z.string().min(1).max(100).optional(),...recallFieldsSchema.partial().shape,priorLearningItem:priorLearningItemSchema.optional()})).default([]),
  })).min(1),
});
export type AuthoredMaterial=z.infer<typeof authoredMaterialSchema>;
export const offlineReviewSchema=z.object({
  authorHash:t,model:t,contextId:t,
  selectionPolicyVersion:z.literal('evidence-exclusion-v1').optional(),
  selection:evidencedSelectionReviewSchema,review:z.union([recallEvidenceReviewSchema,spokenEvidenceReviewSchema,evidenceReviewSchema]),
  continuity:z.array(z.object({gapId:t,learningItemId:t,sameTarget:z.boolean(),sameIntention:z.boolean(),sourceQuote:z.string().trim().min(1),reasonZh:z.string().trim().min(1)})).optional(),
});
export type OfflineReview=z.infer<typeof offlineReviewSchema>;
export function authorHash(author:AuthoredMaterial){return hash(JSON.stringify(authoredMaterialSchema.parse(author)));}
export function expandAuthored(source:RecoverySource,author:AuthoredMaterial){
  if(source.hash!==author.sourceHash||source.index!==author.index) throw new Error("离线来源快照已变化");
  const refs=(indices:number[],quotes:string[],field:"en"|"zh")=>{
    const original=field==="en"?source.english:source.chinese;
    const spans:Array<{start:number;end:number}>=[];
    for(const i of indices){
      const ref=source[field].find(s=>s.index===i);if(!ref)throw new Error("无效来源索引");
      if(original.slice(ref.start,ref.end)!==ref.text)throw new Error("源偏移不一致");
      const last=spans.at(-1);
      if(last?.end===ref.start)last.end=ref.end;else spans.push({start:ref.start,end:ref.end});
    }
    return [...spans.map(span=>{
      const text=original.slice(span.start,span.end);
      return {text,occurrence:original.slice(0,span.start).split(text).length-1};
    }),...quotes.map(text=>({text,occurrence:0}))];
  };
  const diagnosis=diagnosisSchema.parse({units:author.units.map((u,i)=>({id:`u${i}`,intentZh:u.intent,english:refs(u.en,u.enQuotes,"en"),chinese:refs(u.zh,u.zhQuotes,"zh"),status:u.status,reasonZh:u.reason,gaps:u.gaps.map((g,j)=>({id:`g${i}_${j}`,kind:u.status==='missing'||g.quote&&source.chinese.includes(g.quote)&&!source.english.includes(g.quote)?"unexpressed_intention":/语法|时态|复数|单数|冠词|比较级|主谓/.test(g.why)?"grammar_gap":"lexical_gap",cueZh:g.cue,targetEnglish:g.target,acceptableVariants:g.variants,evidenceQuote:g.quote,whyNeededZh:g.why,...(source.spokenStyleVersion?{senseKey:g.senseKey}:{})}))}))});
  if(source.inputFormat==='mixed-v1')for(const unit of diagnosis.units)unit.raw=[...unit.english,...unit.chinese];
  validateDiagnosis({actualAnswer:source.english,intendedMeaningZh:source.chinese,spokenStyleVersion:source.spokenStyleVersion,inputFormat:source.inputFormat,rawInput:source.rawInput},diagnosis);
  const draft=storedMaterialDraftSchema.parse({sentences:author.units.flatMap((u,i)=>["non_answer","uncertain"].includes(u.status)?[]:[{id:`s${i}`,intentUnitIds:[`u${i}`],english:u.english||u.en.map(n=>source.en[n].text).join("")+u.enQuotes.join(" ")}]),rows:author.units.flatMap((u,i)=>u.gaps.map((g,j)=>({gapId:`g${i}_${j}`,sentenceId:`s${i}`,surfaceInSentence:g.surface,...(source.spokenStyleVersion==='personal-spoken-v2'?recallFieldsSchema.parse(g):{})}))),examFeedback:null});
  return {diagnosis,draft};
}
