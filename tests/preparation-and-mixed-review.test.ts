import {expect,it} from 'vitest';
import {compileEvidence,isConfirmedGap,validateEvidenceReview,diagnosisSchema,recallEvidenceReviewSchema,type SelectionReview,type MaterialEvidence,type SelectionSource} from '@/lib/four-step/selection-contracts';
import {selectionMockResolver} from '@/lib/four-step/selection-mock';
import type {StructuredAiRequest} from '@/lib/ai/contracts';

function fixture(){
  const parts=[['I like parks.','总的来说，我喜欢公园。'],['I prefer through 图片.','我更喜欢通过图片获取信息。'],['if there is story, and it 被改编成电影','如果我喜欢的故事有电影改编版，我就看电影。']];
  const raw=parts.flat().join('\n'),source:SelectionSource={actualAnswer:raw,rawInput:raw,intendedMeaningZh:'',inputFormat:'mixed-v1',spokenStyleVersion:'personal-spoken-v2',selectionPolicyVersion:'evidence-exclusion-v1',sentenceStudyVersion:'sentence-material-v1',registerProfileVersion:'young-us-v1'};
  const ref=(text:string)=>({text,occurrence:0});
  const diagnosis=diagnosisSchema.parse({units:parts.map(([english,chinese],index)=>({id:`u${index+6}`,intentZh:chinese,english:[ref(index===1?'I prefer through':index===2?'if there is story, and it':english)],chinese:[ref(chinese)],raw:[ref(english),ref(chinese)],status:'repair',reasonZh:'合成完整原意与英文尝试。',gaps:[{
    id:`g${index+6}`,kind:index===0?'lexical_gap':'grammar_gap',cueZh:index===0?'总的来说':index===1?'通过图片获取信息':'一个电影改编版',targetEnglish:index===0?'overall':index===1?'prefer getting information from pictures':'a movie adaptation',acceptableVariants:[],senseKey:`meaning-${index}`,evidenceQuote:index===0?chinese:english,whyNeededZh:index===0?'已有自然英文，但中文总结标记没有对应英文。':'当前混合表达中确实有不完整或错误的英文结构。',
  }]}))});
  const selection:SelectionReview={approved:true,reasonZh:'允许三个学习目标，准备与确认错误分别处理。',units:diagnosis.units.map(u=>({unitId:u.id,status:'repair',evidenceQuote:u.raw![0].text,reasonZh:'本单元原文可定位。'})),gaps:diagnosis.units.flatMap(u=>u.gaps.map(g=>({gapId:g.id,decision:'train' as const,evidenceQuote:g.evidenceQuote,reasonZh:g.whyNeededZh})))};
  const sentences=[{id:'s6',intentUnitIds:['u6'],english:'Overall, I like parks.'},{id:'s7',intentUnitIds:['u7'],english:'I prefer getting information from pictures.'},{id:'s8',intentUnitIds:['u8'],english:"If a story I like has a movie adaptation, I'd watch it."}];
  const surfaces=['Overall','prefer getting information from pictures','a movie adaptation'];
  const evidence:MaterialEvidence={diagnosis,selection,draft:{sentences,rows:sentences.map((s,i)=>({gapId:`g${i+6}`,sentenceId:s.id,surfaceInSentence:surfaces[i],recallPromptZh:parts[i][1],recallAnswerEn:s.english})),examFeedback:null}};
  const analysis=compileEvidence(source,evidence);
  const review=recallEvidenceReviewSchema.parse(selectionMockResolver({schemaName:'four_step_review_v5',input:JSON.stringify({source,compiled:analysis})} as StructuredAiRequest<unknown>));
  review.rows[0].repairNeeded=false;review.rows[0].minimalRepair=false;
  review.sentences.forEach((row,i)=>{row.evidence=[{sourceField:'actualAnswer',sourceQuote:parts[i][1]}];});
  review.wholeAnswer.evidence=[{sourceField:'actualAnswer',sourceQuote:parts[0][0]+' ... '+parts[0][1],rendering:sentences[0].english,treatment:'adapted',reasonZh:'保留自然英文，并补齐中文总结标记。'}];
  return {source,parts,evidence,analysis,review};
}
it('a Chinese-only missing marker is preparation despite English context and a lexical_gap label',()=>{
  const {source,evidence,analysis}=fixture();
  expect(isConfirmedGap(source,evidence.diagnosis.units[0],evidence.diagnosis.units[0].gaps[0],evidence.selection)).toBe(false);
  expect(analysis.learningMaterials[0].learningBasis).toBe('preparation');expect(analysis.gaps[0].learningBasis).toBe('preparation');
  expect(analysis.gapCount).toBe(2);expect(analysis.learningTargetCount).toBe(3);expect(analysis.corrections).toHaveLength(2);
});
it('mixed gap quotes remain confirmed when their actual intervals include the current English attempt',()=>{
  const {source,evidence,analysis}=fixture();
  expect(analysis.learningMaterials.slice(1).every(row=>row.learningBasis==='confirmed_error')).toBe(true);
  for(const unit of evidence.diagnosis.units.slice(1))expect(isConfirmedGap(source,unit,unit.gaps[0],evidence.selection)).toBe(true);
});
it('Latin words in Chinese context do not borrow an unrelated English interval',()=>{
  const {source,parts,evidence}=fixture(),unit=structuredClone(evidence.diagnosis.units[0]),newChinese='我想用AI来总结。';
  source.actualAnswer=source.actualAnswer.replace(parts[0][1],newChinese);source.rawInput=source.actualAnswer;
  unit.chinese[0].text=newChinese;unit.raw![1].text=newChinese;unit.gaps[0].evidenceQuote=newChinese;
  expect(isConfirmedGap(source,unit,unit.gaps[0],evidence.selection)).toBe(false);
});
it('preparation may have repairNeeded=false and minimalRepair=false; both remain unchanged after successful review',()=>{
  const {source,evidence,review}=fixture(),before=structuredClone(review);
  expect(()=>validateEvidenceReview(evidence,review,source)).not.toThrow();expect(review).toEqual(before);
  expect(review.rows[0]).toMatchObject({approved:true,repairNeeded:false,minimalRepair:false,learningTargetNeeded:true});
});
it('confirmed mistakes still require minimal repair and matching repairNeeded, and other quality gates stay mandatory',()=>{
  for(const change of ['minimalRepair','repairNeeded','meaningPreserved','cueUnambiguous','sentenceAligned','clozeValid'] as const){
    const {source,evidence,review}=fixture();review.rows[1][change]=false;
    expect(()=>validateEvidenceReview(evidence,review,source)).toThrow();
  }
  const {source,evidence,review}=fixture();review.rows[0].learningTargetNeeded=false;expect(()=>validateEvidenceReview(evidence,review,source)).toThrow();
});
it('actualAnswer in mixed mode is the raw field, so a cited Chinese segment may prove that sentence source',()=>{
  const {source,evidence,review}=fixture();
  expect(review.sentences.every(s=>s.evidence[0].sourceField==='actualAnswer')).toBe(true);
  expect(()=>validateEvidenceReview(evidence,review,source)).not.toThrow();
  review.sentences[0].evidence=[{sourceField:'intendedMeaningZh',sourceQuote:'总的来说，我喜欢公园。'}];
  expect(()=>validateEvidenceReview(evidence,review,source)).toThrow('逐句审核');
});
it('whole-answer citation lists require complete, exact refs from the same unit and never edited text',()=>{
  for(const value of ['I like ... 总的来说，我喜欢公园。','I like parks. ... 总的来说，我喜欢海滩。','I like parks. ... 我更喜欢通过图片获取信息。']){
    const {source,evidence,review}=fixture();review.wholeAnswer.evidence[0].sourceQuote=value;
    expect(()=>validateEvidenceReview(evidence,review,source)).toThrow('说话风格审核引用');
  }
});
it('old register-less material retains its historical derived classification rather than silently changing scores',()=>{
  const {source,evidence}=fixture();delete source.registerProfileVersion;
  expect(compileEvidence(source,evidence).learningMaterials[0].learningBasis).toBe('confirmed_error');
});
