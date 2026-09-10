import {expect,it} from 'vitest';
import {selectionFixture} from '../pipeline/golden/material-selection-v2';
import {validateSelection} from '@/lib/four-step/selection-contracts';

it('an explicit omission can cite whole English and Chinese references without rewriting either source',()=>{
 const {source,evidence}=selectionFixture();
 const unit=evidence.diagnosis.units[0],review=evidence.selection.units.find(row=>row.unitId===unit.id)!;
 review.evidenceQuote=unit.english[0].text+' ... '+unit.chinese[0].text;
 expect(()=>validateSelection(evidence.diagnosis,evidence.selection,source)).not.toThrow();
});
it.each(['plain-join','invented','partial-fragment'])('does not accept an unmarked or altered reference list: %s',kind=>{
 const {source,evidence}=selectionFixture();
 const unit=evidence.diagnosis.units[0],review=evidence.selection.units.find(row=>row.unitId===unit.id)!;
 review.evidenceQuote=kind==='plain-join'?unit.english[0].text+' '+unit.chinese[0].text:kind==='invented'?unit.english[0].text+' ... 我喜欢另一个城市。':unit.english[0].text.slice(0,-2)+' ... '+unit.chinese[0].text;
 expect(()=>validateSelection(evidence.diagnosis,evidence.selection,source)).toThrow();
});
