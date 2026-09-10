import {expect,it} from 'vitest';
import {normalizeUniqueQuoteOccurrences} from '@/lib/four-step/quote-normalization';
import {validateDiagnosis,type Diagnosis,type SelectionSource} from '@/lib/four-step/selection-contracts';

function diagnosis(english:Array<{text:string;occurrence:number}>,chinese:Array<{text:string;occurrence:number}>=[],raw?:Array<{text:string;occurrence:number}>):Diagnosis{
  return {units:[{id:'intent-1',intentZh:'用于测试的原意。',english,chinese,...(raw?{raw}:{}),status:'natural',reasonZh:'合成来源引用。',gaps:[]}]};
}
it('normalizes a unique exact quote with an out-of-range ordinal and retains transformation evidence',()=>{
  const source:SelectionSource={actualAnswer:'I read manga and watch anime.',intendedMeaningZh:'我看漫画，也看动画。'};
  const original=diagnosis([{text:source.actualAnswer,occurrence:172}],[{text:source.intendedMeaningZh,occurrence:674}]);
  const before=structuredClone(original),result=normalizeUniqueQuoteOccurrences(source,original);
  expect(result.diagnosis.units[0].english[0].occurrence).toBe(0);expect(result.diagnosis.units[0].chinese[0].occurrence).toBe(0);
  expect(result.changes).toEqual([
    {unitId:'intent-1',field:'english',sourceField:'actualAnswer',quoteIndex:0,quoteText:source.actualAnswer,fromOccurrence:172,toOccurrence:0,reason:'unique_exact_quote_invalid_ordinal'},
    {unitId:'intent-1',field:'chinese',sourceField:'intendedMeaningZh',quoteIndex:0,quoteText:source.intendedMeaningZh,fromOccurrence:674,toOccurrence:0,reason:'unique_exact_quote_invalid_ordinal'},
  ]);
  expect(original).toEqual(before);expect(()=>validateDiagnosis(source,result.diagnosis)).not.toThrow();
  expect(normalizeUniqueQuoteOccurrences(source,result.diagnosis).changes).toEqual([]);
});
it('leaves valid ordinals intact even when the number also looks like a character offset',()=>{
  const source={actualAnswer:'x x',intendedMeaningZh:''},original=diagnosis([{text:'x',occurrence:1}]);
  const result=normalizeUniqueQuoteOccurrences(source,original);expect(result.changes).toHaveLength(0);expect(result.diagnosis).toEqual(original);
});
it('never guesses repeated quotes, including an invalid ordinal matching an exact UTF-16 start',()=>{
  const source={actualAnswer:'前😀 I read. I read.',intendedMeaningZh:''},start=source.actualAnswer.lastIndexOf('I read.');
  expect(start).toBeGreaterThan(1);
  const original=diagnosis([{text:'I read.',occurrence:start}]),result=normalizeUniqueQuoteOccurrences(source,original);
  expect(result.changes).toHaveLength(0);expect(result.diagnosis.units[0].english[0].occurrence).toBe(start);
  expect(()=>validateDiagnosis(source,result.diagnosis)).toThrow();
});
it('counts overlapping exact matches as repeated instead of claiming unique text',()=>{
  const source={actualAnswer:'aaaa',intendedMeaningZh:''},original=diagnosis([{text:'aaa',occurrence:4}]);
  expect(normalizeUniqueQuoteOccurrences(source,original).changes).toEqual([]);
});
it('does not fuzzy-match, change whitespace, punctuation, case, or Unicode quote forms',()=>{
  const source={actualAnswer:'I’m here.\nI read  manga.',intendedMeaningZh:''};
  for(const quote of ["I'm here.",'i’m here.','I read manga.','I’m here!']){
    const original=diagnosis([{text:quote,occurrence:8}]),result=normalizeUniqueQuoteOccurrences(source,original);
    expect(result.changes).toEqual([]);expect(result.diagnosis).toEqual(original);
  }
});
it('uses each legacy source field separately, never searching English evidence in Chinese text',()=>{
  const source={actualAnswer:'I live alone.',intendedMeaningZh:'我的英文例子是 I read manga.'};
  const result=normalizeUniqueQuoteOccurrences(source,diagnosis([{text:'I read manga.',occurrence:12}]));
  expect(result.changes).toEqual([]);
});
it('binds mixed English, Chinese and raw quotes to the exact saved mixed source',()=>{
  const text='I read manga. 我也看动画。',source:SelectionSource={actualAnswer:text,intendedMeaningZh:'',rawInput:text,inputFormat:'mixed-v1'};
  const original=diagnosis([{text:'I read manga.',occurrence:12}],[{text:'我也看动画。',occurrence:14}],[{text,occurrence:172}]);
  const result=normalizeUniqueQuoteOccurrences(source,original);expect(result.changes).toHaveLength(3);expect(result.changes.every(c=>c.sourceField==='rawInput')).toBe(true);
  expect(()=>validateDiagnosis(source,result.diagnosis)).not.toThrow();
});
it('does not normalize a mismatched raw binding or a forbidden legacy raw reference',()=>{
  const original=diagnosis([{text:'I read.',occurrence:4}],[],[{text:'I read.',occurrence:4}]);
  const mixed:SelectionSource={actualAnswer:'Actual source',intendedMeaningZh:'',rawInput:'I read.',inputFormat:'mixed-v1'};
  expect(normalizeUniqueQuoteOccurrences(mixed,original).changes).toEqual([]);
  const legacy=normalizeUniqueQuoteOccurrences({actualAnswer:'I read.',intendedMeaningZh:'',rawInput:'I read.'},original);
  expect(legacy.changes).toHaveLength(1);expect(legacy.diagnosis.units[0].raw?.[0].occurrence).toBe(4);expect(()=>validateDiagnosis({actualAnswer:'I read.',intendedMeaningZh:''},legacy.diagnosis)).toThrow();
});
it('does not invent default indices for malformed types or repair invalid negative ordinals',()=>{
  for(const occurrence of [-1,1.5,NaN,Infinity,'172',undefined]){
    const original=diagnosis([{text:'I read.',occurrence:occurrence as number}]);
    expect(normalizeUniqueQuoteOccurrences({actualAnswer:'I read.',intendedMeaningZh:''},original).changes).toEqual([]);
  }
});
it('normalization does not waive missing-source coverage or unsupported diagnosis decisions',()=>{
  const source={actualAnswer:'I read manga. I watch anime.',intendedMeaningZh:''};
  const result=normalizeUniqueQuoteOccurrences(source,diagnosis([{text:'I read manga.',occurrence:172}]));
  expect(result.changes).toHaveLength(1);expect(()=>validateDiagnosis(source,result.diagnosis)).toThrow('部分原文没有诊断归属');
});
