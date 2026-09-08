import {expect,it} from 'vitest';
import {assertComparisonOutput} from '@/lib/app-services/answer-comparison';
const input={currentEnglish:'I share a flat with a friend.',oldItems:[{}],currentItems:[{}]};
it('rejects missing/duplicated issues and unsupported improvement without an exact current evidence quote',()=>{
  const valid={comparisons:[{index:0,state:'improved',evidenceQuote:'I share a flat',reasonZh:'本次有对应原句。'}],newItemIndexes:[]};expect(()=>assertComparisonOutput(valid,input)).not.toThrow();
  expect(()=>assertComparisonOutput({...valid,comparisons:[]},input)).toThrow();
  expect(()=>assertComparisonOutput({...valid,comparisons:[{...valid.comparisons[0],evidenceQuote:''}]},input)).toThrow();
  expect(()=>assertComparisonOutput({...valid,comparisons:[{...valid.comparisons[0],evidenceQuote:'Invented evidence'}]},input)).toThrow();
  expect(()=>assertComparisonOutput({...valid,comparisons:[{...valid.comparisons[0],state:'uncertain',evidenceQuote:''}]},input)).not.toThrow();
});
