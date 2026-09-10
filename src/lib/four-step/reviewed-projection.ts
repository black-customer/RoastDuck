import {speakingAttemptAnalysisSchema,type SpeakingAttemptAnalysis} from '@/lib/speaking-practice/schemas';
import type {MaterialInput} from './material-types';

type BasisReview={approved:boolean;rows:Array<{gapId:string;approved:boolean;repairNeeded:boolean;learningTargetNeeded?:boolean}>};
/** Compare the actual reviewed teaching content. Only an explicitly reviewed
 * downgrade from confirmed error to preparation may repair legacy derived labels.
 * Never changes a source, target, sentence, explanation, AI verdict or raw receipt. */
export function matchesReviewedProjection(source:MaterialInput,before:unknown,after:SpeakingAttemptAnalysis,review:BasisReview):boolean{
  const previous=speakingAttemptAnalysisSchema.parse(before);
  if(JSON.stringify(previous)===JSON.stringify(after))return true;
  if(!source.registerProfileVersion||!review.approved||!previous.evidence||JSON.stringify(previous.evidence)!==JSON.stringify(after.evidence))return false;
  const changed=previous.learningMaterials.filter(row=>row.learningBasis!==after.learningMaterials.find(next=>next.gapId===row.gapId)?.learningBasis);
  if(!changed.length||previous.gapCount!==previous.gaps.filter(gap=>gap.learningBasis==='confirmed_error').length)return false;
  const allowed=new Set<string>(),corrections:Array<{original:string;corrected:string;reasonZh:string}>=[];
  for(const row of changed){
    const next=after.learningMaterials.find(item=>item.gapId===row.gapId),verdict=review.rows.find(item=>item.gapId===row.gapId);
    if(!row.gapId||row.learningBasis!=='confirmed_error'||next?.learningBasis!=='preparation'||!verdict?.approved||verdict.repairNeeded||verdict.learningTargetNeeded!==true)return false;
    const unit=previous.evidence.diagnosis.units.find(item=>item.gaps.some(gap=>gap.id===row.gapId)),gap=unit?.gaps.find(item=>item.id===row.gapId);
    if(!unit||!gap)return false;
    allowed.add(row.gapId);corrections.push({original:unit.english.map(q=>q.text).join('\n'),corrected:row.naturalEnglishSentence,reasonZh:gap.whyNeededZh});
  }
  previous.learningMaterials=previous.learningMaterials.map(row=>row.gapId&&allowed.has(row.gapId)?{...row,learningBasis:'preparation'}:row);
  previous.gaps=previous.gaps.map(gap=>allowed.has(gap.key)?{...gap,learningBasis:'preparation'}:gap);
  previous.gapCount=previous.gaps.filter(gap=>gap.learningBasis==='confirmed_error').length;
  previous.corrections=previous.corrections.filter(row=>!corrections.some(removed=>row.original===removed.original&&row.corrected===removed.corrected&&row.reasonZh===removed.reasonZh));
  return JSON.stringify(previous)===JSON.stringify(after);
}
