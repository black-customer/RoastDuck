import {expect,it} from 'vitest';
import {recoverApprovedSelection,type StoredReviewStage} from '@/lib/four-step/selection-identity';
import {diagnosisSchema,type SelectionReview} from '@/lib/four-step/selection-contracts';
import type {MaterialInput} from '@/lib/four-step/material-types';
import {materialStageContracts} from '@/lib/four-step/stage-contracts';
import {hash} from '@/lib/four-step/shared';
import {normalizeUniqueQuoteOccurrences} from '@/lib/four-step/quote-normalization';

function fixture(ellipsis=false){
  const english='I use phone.',chinese='我用手机。',text=english+'\n'+chinese;
  const source:MaterialInput={sourceType:'ielts_practice',sourceId:'approved-attempt',question:{id:'approved-question',textEn:'What do you use?',textZh:'你用什么？',part:1},mode:'practice',actualAnswer:text,intendedMeaningZh:'',rawInput:text,inputFormat:'mixed-v1',spokenStyleVersion:'personal-spoken-v2',selectionPolicyVersion:'evidence-exclusion-v1',sentenceStudyVersion:'sentence-material-v1',registerProfileVersion:'young-us-v1'};
  const raw=diagnosisSchema.parse({units:[{id:'u1',intentZh:'我用手机。',english:[{text:english,occurrence:172}],chinese:[{text:chinese,occurrence:674}],raw:[{text:english,occurrence:0},{text:chinese,occurrence:0}],status:'repair',reasonZh:'实际英文缺少冠词。',gaps:[{id:'g1',kind:'grammar_gap',cueZh:'一部手机',targetEnglish:'a phone',acceptableVariants:[],senseKey:'one-phone',evidenceQuote:'phone',whyNeededZh:'单数名词需要限定词。'}]}]});
  const canonical=normalizeUniqueQuoteOccurrences(source,raw).diagnosis;
  const selection:SelectionReview={approved:true,reasonZh:'当前诊断可安全编译。',units:[{unitId:'u1',status:'repair',evidenceQuote:ellipsis?english+' ... '+chinese:english,reasonZh:'英文和中文原意均属于本单元。'}],gaps:[{gapId:'g1',decision:'train',evidenceQuote:'phone',reasonZh:'基于实际英文的冠词问题。'}]};
  const contracts=materialStageContracts(source);
  const stage=(kind:'diagnosis'|'selection',id:string,input:unknown,output:unknown):StoredReviewStage=>{const input_json=JSON.stringify(input);return {run_id:id,material_id:'approved-material',stage:kind,status:'rejected',prompt_version:contracts[kind].prompt,input_hash:hash(contracts[kind].prompt,input_json),input_json,output_json:JSON.stringify(output)};};
  const diagnosisStage=stage('diagnosis','original-diagnosis',{source},raw),selectionStage=stage('selection','original-selection',{source,diagnosis:canonical,diagnosisRunId:diagnosisStage.run_id},selection);
  return {source,raw,selection,diagnosisStage,selectionStage};
}
it.each([false,true])('retains both existing run identities and the approved raw response when strict current evidence is valid (explicit citation list=%s)',ellipsis=>{
  const f=fixture(ellipsis),before=structuredClone(f),proof=recoverApprovedSelection(f.source,f.selectionStage,f.diagnosisStage);
  expect(proof).toMatchObject({diagnosisRunId:'original-diagnosis',selectionRunId:'original-selection',reason:'approved_selection_revalidated'});
  expect(proof?.selection).toEqual(f.selection);expect(proof?.rawDiagnosis).toEqual(f.raw);expect(proof?.diagnosis.units[0].english[0].occurrence).toBe(0);expect(f).toEqual(before);
});
it('never changes a valid negative verdict or accepts an extra gap ID',()=>{
  const f=fixture();
  expect(recoverApprovedSelection(f.source,{...f.selectionStage,output_json:JSON.stringify({...f.selection,approved:false})},f.diagnosisStage)).toBeNull();
  expect(recoverApprovedSelection(f.source,{...f.selectionStage,output_json:JSON.stringify({...f.selection,gaps:[...f.selection.gaps,{...f.selection.gaps[0],gapId:'g7b'}]})},f.diagnosisStage)).toBeNull();
});
it('explicit omission cannot turn partial, altered or unrelated text into a valid citation list',()=>{
  for(const quote of ['I use ... 我用手机。','I use a phone. ... 我用手机。','I use phone. ... 我读小说。']){
    const f=fixture(true),selection=structuredClone(f.selection);selection.units[0].evidenceQuote=quote;
    expect(recoverApprovedSelection(f.source,{...f.selectionStage,output_json:JSON.stringify(selection)},f.diagnosisStage)).toBeNull();
  }
});
it('source, raw diagnosis, prompt, input hash and run linkage must all still agree',()=>{
  const f=fixture();
  expect(recoverApprovedSelection({...f.source,mode:'changed'},f.selectionStage,f.diagnosisStage)).toBeNull();
  expect(recoverApprovedSelection(f.source,{...f.selectionStage,input_hash:'changed'},f.diagnosisStage)).toBeNull();
  expect(recoverApprovedSelection(f.source,{...f.selectionStage,prompt_version:'unknown-review'},f.diagnosisStage)).toBeNull();
  expect(recoverApprovedSelection(f.source,f.selectionStage,{...f.diagnosisStage,run_id:'another-run'})).toBeNull();
  expect(recoverApprovedSelection(f.source,f.selectionStage,{...f.diagnosisStage,status:'pending'})).toBeNull();
  const broken=structuredClone(f.raw);broken.units[0].raw=[];
  expect(recoverApprovedSelection(f.source,f.selectionStage,{...f.diagnosisStage,output_json:JSON.stringify(broken)})).toBeNull();
});
