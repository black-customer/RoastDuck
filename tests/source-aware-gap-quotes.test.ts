import {expect,it} from 'vitest';
import {compileEvidence,validateDiagnosis,validateSelection,validateEvidenceReview,recallEvidenceReviewSchema,type Diagnosis,type SelectionReview,type SelectionSource} from '@/lib/four-step/selection-contracts';
import {selectionMockResolver} from '@/lib/four-step/selection-mock';
import type {StructuredAiRequest} from '@/lib/ai/contracts';

const first='I use phone.',second='It easy.',english=first+' '+second;
const chineseFirst='我用手机。',chineseSecond='操作很简单。',chinese=chineseFirst+' '+chineseSecond;
const ref=(text:string,occurrence=0)=>({text,occurrence});
function example(mixed=false){
  const raw=english+' '+chinese;
  const source:SelectionSource={actualAnswer:mixed?raw:english,intendedMeaningZh:mixed?'':chinese,spokenStyleVersion:'personal-spoken-v2',selectionPolicyVersion:'evidence-exclusion-v1',...(mixed?{inputFormat:'mixed-v1' as const,rawInput:raw}:{})};
  const diagnosis:Diagnosis={units:[{id:'u1',intentZh:'我用手机，操作很简单。',english:[ref(first),ref(second)],chinese:[ref(chineseFirst),ref(chineseSecond)],...(mixed?{raw:[ref(first),ref(second),ref(chineseFirst),ref(chineseSecond)]}:{}),status:'repair',reasonZh:'合成句子中的手机缺少冠词，后句缺少be。',gaps:[{id:'g1',kind:'grammar_gap',cueZh:'一部手机',targetEnglish:'a phone',acceptableVariants:[],senseKey:'one-phone',evidenceQuote:english,whyNeededZh:'合成手机冠词与上下句表达依据。'}]}]};
  const selection:SelectionReview={approved:true,reasonZh:'合成独立审核只用同一意思的逐字依据。',units:[{unitId:'u1',status:'repair',evidenceQuote:english,reasonZh:'两条相邻引用同属当前意思。'}],gaps:[{gapId:'g1',decision:'train',evidenceQuote:english,reasonZh:'依据精确覆盖两句。'}]};
  return {source,diagnosis,selection};
}
it.each([false,true])('accepts an exact quote across adjacent refs, through diagnosis, selection and final review (mixed=%s)',mixed=>{
  const {source,diagnosis,selection}=example(mixed),original=structuredClone(diagnosis);
  expect(()=>validateDiagnosis(source,diagnosis)).not.toThrow();expect(()=>validateSelection(diagnosis,selection,source)).not.toThrow();
  const analysis=compileEvidence(source,{diagnosis,selection,draft:{sentences:[{id:'s1',intentUnitIds:['u1'],english:"I use a phone, and it's easy."}],rows:[{gapId:'g1',sentenceId:'s1',surfaceInSentence:'a phone',recallPromptZh:'我用手机，操作很简单。',recallAnswerEn:"I use a phone, and it's easy."}],examFeedback:null}});
  const review=recallEvidenceReviewSchema.parse(selectionMockResolver({schemaName:'four_step_review_v5',input:JSON.stringify({source,compiled:analysis})} as StructuredAiRequest<unknown>));
  review.rows[0].evidenceQuote=english;
  review.sentences[0].evidence=[{sourceField:mixed?'rawInput':'actualAnswer',sourceQuote:english},{sourceField:mixed?'rawInput':'intendedMeaningZh',sourceQuote:chinese}];
  expect(()=>validateEvidenceReview(analysis.evidence,review,source)).not.toThrow();expect(diagnosis).toEqual(original);
});
it('only whitespace between source refs may be uncovered; punctuation is still required',()=>{
  const {source,diagnosis}=example();source.actualAnswer=first+'\r\n\t'+second;diagnosis.units[0].gaps[0].evidenceQuote=source.actualAnswer;
  expect(()=>validateDiagnosis(source,diagnosis)).not.toThrow();
  diagnosis.units[0].english[0]=ref('I use phone');
  expect(()=>validateDiagnosis(source,diagnosis)).toThrow('问题证据不属于当前意思单元');
});
it('rejects a literal whole quote that includes a word covered only by another unit',()=>{
  const {source,diagnosis}=example();source.actualAnswer=first+' Actually, '+second;diagnosis.units[0].gaps[0].evidenceQuote=source.actualAnswer;
  diagnosis.units.push({id:'u2',intentZh:'口语插入',english:[ref('Actually,')],chinese:[],status:'non_answer',reasonZh:'合成另一单元，仅验证来源边界。',gaps:[]});
  expect(()=>validateDiagnosis(source,diagnosis)).toThrow('问题证据不属于当前意思单元');
});
it('rejects punctuation changes and removal of intervening source words rather than fuzzy matching',()=>{
  for(const value of [english.replace('.',','),english.replace(' phone',''),english.replace(' ',''),english.toLowerCase()]){
    const {source,diagnosis}=example();diagnosis.units[0].gaps[0].evidenceQuote=value;
    expect(()=>validateDiagnosis(source,diagnosis)).toThrow('问题证据不属于当前意思单元');
  }
});
it('cannot borrow another unit even when global source coverage is complete',()=>{
  const {source,diagnosis}=example();diagnosis.units[0].english=[ref(first)];
  diagnosis.units.push({id:'u2',intentZh:'第二句',english:[ref(second)],chinese:[],status:'uncertain',reasonZh:'另一个意思单元。',gaps:[]});
  expect(()=>validateDiagnosis(source,diagnosis)).toThrow('问题证据不属于当前意思单元');
});
it('does not concatenate the two legacy source fields into a fictional source buffer',()=>{
  const {source,diagnosis}=example();diagnosis.units[0].gaps[0].evidenceQuote=english+' '+chinese;
  expect(()=>validateDiagnosis(source,diagnosis)).toThrow('问题证据不属于当前意思单元');
});
it('respects repeated-reference ordinals instead of assembling pieces from different occurrences',()=>{
  const {source,diagnosis}=example();source.actualAnswer='A B A B';diagnosis.units[0].english=[ref('A',0),ref('B',1)];diagnosis.units[0].gaps[0].evidenceQuote='A B';
  diagnosis.units.push({id:'u2',intentZh:'其余片段',english:[ref('A',1),ref('B',0)],chinese:[],status:'non_answer',reasonZh:'另一单元的相同文本。',gaps:[]});
  expect(()=>validateDiagnosis(source,diagnosis)).toThrow('问题证据不属于当前意思单元');
});
it('validates source occurrence even on the single-reference fast path; missing source retains narrow legacy behavior',()=>{
  const {source,diagnosis,selection}=example();diagnosis.units[0].english=[ref(english,10)];
  expect(()=>validateSelection(diagnosis,selection,source)).toThrow('诊断引用不在原文中');
  const split=example();expect(()=>validateSelection(split.diagnosis,split.selection)).toThrow('审核未引用当前原文');
});
it('selection and sentence review cannot cite adjacent text outside the current unit',()=>{
  const {source,diagnosis,selection}=example();diagnosis.units[0].gaps[0].evidenceQuote=first;selection.gaps[0].evidenceQuote=first;selection.units[0].evidenceQuote=first;
  source.actualAnswer=english+' Extra context.';diagnosis.units.push({id:'u2',intentZh:'其他内容',english:[ref('Extra context.')],chinese:[],status:'non_answer',reasonZh:'不能借用的外部上下文。',gaps:[]});
  selection.units.push({unitId:'u2',status:'non_answer',evidenceQuote:'Extra context.',reasonZh:'另一个来源单元。'});
  expect(()=>validateDiagnosis(source,diagnosis)).not.toThrow();
  selection.gaps[0].evidenceQuote=source.actualAnswer;
  expect(()=>validateSelection(diagnosis,selection,source)).toThrow('Gap 裁决缺少原文证据');
});
