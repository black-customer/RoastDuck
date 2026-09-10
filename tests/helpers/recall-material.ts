import {authoredMaterialSchema,authorHash,expandAuthored,type RecoverySource} from '@/lib/four-step/offline-contracts';
import {compileEvidence,recallEvidenceReviewSchema,type SelectionReview} from '@/lib/four-step/selection-contracts';

export function recallFixture(source:RecoverySource){
  const author=authoredMaterialSchema.parse({index:source.index,sourceHash:source.hash,model:'synthetic author',contextId:'author-context',units:[{
    en:[0],zh:source.zh.length?[0]:[],intent:'我已经习惯一个人住了。',status:'repair',reason:'习惯构式需动名词',english:'I am used to living alone.',
    gaps:[{cue:'已经习惯做某事',target:'be used to doing',senseKey:'habituation',quote:'used to live alone',why:'be used to 后接动名词',surface:'used to living',recallPromptZh:'我已经习惯一个人住了。',recallAnswerEn:'I am used to living alone.',pattern:'be used to + noun / -ing'}],
  }]});
  const expanded=expandAuthored(source,author);
  const selection:SelectionReview={approved:true,reasonZh:'合成独立诊断审核',units:[{unitId:'u0',status:'repair',evidenceQuote:source.english,reasonZh:'原句存在动名词构式问题'}],gaps:[{gapId:'g0_0',decision:'train',evidenceQuote:'used to live alone',reasonZh:'仅修复习惯构式'}]};
  const evidence={...expanded,selection},analysis=compileEvidence({actualAnswer:source.english,intendedMeaningZh:source.chinese,spokenStyleVersion:source.spokenStyleVersion},evidence);
  const review={authorHash:authorHash(author),model:'synthetic reviewer',contextId:'reviewer-context',selection,review:recallEvidenceReviewSchema.parse({approved:true,reasonZh:'合成独立逐句审核',rows:[{gapId:'g0_0',approved:true,evidenceQuote:'used to live alone',reasonZh:'当前句修复live到living并保留独居原意',repairNeeded:true,learningTargetNeeded:true,meaningPreserved:true,minimalRepair:true,cueUnambiguous:true,sentenceAligned:true,clozeValid:true,recallCueUnambiguous:true,recallAnswerConcrete:true,recallAligned:true}],
    wholeAnswer:{meaningPreserved:true,voicePreserved:true,stancePreserved:true,discourseFunctionsPreserved:true,metaphorsPreserved:true,spokenNaturalness:true,noInventedPersonalStyle:true,reasonZh:'忠实保留第一人称习惯',evidence:[{sourceField:'actualAnswer',sourceQuote:source.english,rendering:'I am used to living alone.',treatment:'adapted',reasonZh:'仅修复构式'}]},
    sentences:[{sentenceId:'s0',sentenceQuote:'I am used to living alone.',meaningPreserved:true,naturalEnglish:true,grammarCorrect:true,sourceUncertaintyHandled:true,reasonZh:'与原话对应且语法自然',evidence:[{sourceField:'actualAnswer',sourceQuote:source.english}]}],
  })};
  return {author,review,evidence,analysis};
}
