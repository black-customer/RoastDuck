import {speakingAttemptAnalysisSchema} from '@/lib/speaking-practice/schemas';
import {authoredMaterialSchema,authorHash,expandAuthored,offlineReviewSchema,recoverySourceSchema,type AuthoredMaterial,type OfflineReview,type RecoverySource} from './offline-contracts';
import {compileEvidence,validateEvidenceReview} from './selection-contracts';
import {TrainingError} from './shared';

/** Pure compilation: importing this module never opens a database or creates a Provider. */
export function compileOfflineMaterial(rawSource:RecoverySource,rawAuthor:AuthoredMaterial,rawReview:OfflineReview,options:{selectionPolicyVersion?:'evidence-exclusion-v1'}={}){
  const source=recoverySourceSchema.parse(rawSource),author=authoredMaterialSchema.parse(rawAuthor),review=offlineReviewSchema.parse(rawReview);
  if(review.authorHash!==authorHash(author)||review.contextId===author.contextId)throw new TrainingError('离线审核不独立或候选已变化',422,'offline_review_stale');
  const candidate=expandAuthored(source,author);
  const draft={...candidate.draft,rows:candidate.draft.rows.filter(row=>review.selection.gaps.some(gap=>gap.gapId===row.gapId&&gap.decision==='train'))};
  const evidence={diagnosis:candidate.diagnosis,selection:review.selection,draft};
  const context={actualAnswer:source.english,intendedMeaningZh:source.chinese,...(source.spokenStyleVersion?{spokenStyleVersion:source.spokenStyleVersion}:{}),...(source.inputFormat?{inputFormat:source.inputFormat,rawInput:source.rawInput}:{})};
  const policy=options.selectionPolicyVersion??source.selectionPolicyVersion;
  if(review.selectionPolicyVersion!==policy)throw new TrainingError('审核者不能自行开启或更改选材政策',422,'offline_review_policy');
  const reviewedContext={...context,...(policy?{selectionPolicyVersion:policy}:{})};
  const analysis=speakingAttemptAnalysisSchema.parse(compileEvidence(reviewedContext,evidence));
  validateEvidenceReview(evidence,review.review,reviewedContext);
  return {source,author,review,analysis};
}
