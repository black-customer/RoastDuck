import {expect,it} from 'vitest';
import {z} from 'zod';
import {assertSelectionIdentity,selectionSchemaForDiagnosis,recoverDiagnosisFromMalformedSelection,type StoredReviewStage} from '@/lib/four-step/selection-identity';
import {diagnosisSchema,type SelectionReview} from '@/lib/four-step/selection-contracts';
import type {MaterialInput} from '@/lib/four-step/material-types';
import {materialStageContracts} from '@/lib/four-step/stage-contracts';
import {hash} from '@/lib/four-step/shared';
import {normalizeUniqueQuoteOccurrences} from '@/lib/four-step/quote-normalization';

function fixture(){
  const source:MaterialInput={sourceType:'ielts_practice',sourceId:'attempt-closed',question:{id:'q-closed',textEn:'What do you use?',textZh:'你用什么？',part:1},mode:'practice',actualAnswer:'I use phone.',intendedMeaningZh:'',spokenStyleVersion:'personal-spoken-v2',selectionPolicyVersion:'evidence-exclusion-v1',sentenceStudyVersion:'sentence-material-v1',registerProfileVersion:'young-us-v1'};
  const raw=diagnosisSchema.parse({units:[{id:'u1',intentZh:'我用手机。',english:[{text:'I use phone.',occurrence:172}],chinese:[],status:'repair',reasonZh:'合成冠词缺失。',gaps:[{id:'g1',kind:'grammar_gap',cueZh:'一部手机',targetEnglish:'a phone',acceptableVariants:[],senseKey:'one-phone',evidenceQuote:'phone',whyNeededZh:'单数名词需要限定词。'}]}]});
  const canonical=normalizeUniqueQuoteOccurrences(source,raw).diagnosis;
  const valid:SelectionReview={approved:true,reasonZh:'独立判断认为可继续。',units:[{unitId:'u1',status:'repair',evidenceQuote:'I use phone.',reasonZh:'本次有英文冠词依据。'}],gaps:[{gapId:'g1',decision:'train',evidenceQuote:'phone',reasonZh:'修复实际缺少的冠词。'}]};
  const contracts=materialStageContracts(source);
  const stage=(name:'diagnosis'|'selection',run:string,input:unknown,output:unknown):StoredReviewStage=>{const inputJson=JSON.stringify(input);return {run_id:run,material_id:'material-closed',stage:name,status:'rejected',prompt_version:contracts[name].prompt,input_hash:hash(contracts[name].prompt,inputJson),input_json:inputJson,output_json:JSON.stringify(output)};};
  const malformed={...valid,approved:false,gaps:[...valid.gaps,{gapId:'g7b',decision:'train' as const,evidenceQuote:'phone',reasonZh:'模型新增了不存在的编号。'}]};
  const diagnosisStage=stage('diagnosis','raw-diagnosis',{source},raw),selectionStage=stage('selection','bad-selection',{source,diagnosis:canonical,diagnosisRunId:diagnosisStage.run_id},malformed);
  return {source,raw,canonical,valid,malformed,diagnosisStage,selectionStage,stage};
}
it('closed schema preserves the existing response fields, binds both ID enums and fixes array lengths',()=>{
  const f=fixture(),schema=selectionSchemaForDiagnosis(f.source,f.canonical);
  expect(schema.parse(f.valid)).toEqual(f.valid);
  const wire=z.toJSONSchema(schema) as unknown as {properties:{units:{minItems:number;maxItems:number;items:{properties:{unitId:{enum:string[]}}}};gaps:{minItems:number;maxItems:number;items:{properties:{gapId:{enum:string[]}}}};approved:{description:string}}};
  expect(wire.properties.units).toMatchObject({minItems:1,maxItems:1,items:{properties:{unitId:{enum:['u1']}}}});
  expect(wire.properties.gaps).toMatchObject({minItems:1,maxItems:1,items:{properties:{gapId:{enum:['g1']}}}});
  expect(wire.properties.approved.description).toContain('必须为 false');
  for(const invalid of [f.malformed,{...f.valid,units:[]},{...f.valid,gaps:[]},{...f.valid,gaps:[{...f.valid.gaps[0],gapId:'g7b'}]}])expect(schema.safeParse(invalid).success).toBe(false);
});
it('valid IDs with approved=false remain a free semantic refusal, never coerced to approval',()=>{
  const f=fixture(),refusal={...f.valid,approved:false,reasonZh:'原意尚未可靠处理，拒绝编译。'};
  expect(selectionSchemaForDiagnosis(f.source,f.canonical).parse(refusal).approved).toBe(false);expect(()=>assertSelectionIdentity(f.canonical,refusal)).not.toThrow();
  expect(recoverDiagnosisFromMalformedSelection(f.source,{...f.selectionStage,output_json:JSON.stringify(refusal)},f.diagnosisStage)).toBeNull();
});
it('valid exclude and uncertain decisions are allowed without requiring approved=true',()=>{
  const f=fixture();for(const decision of ['exclude','uncertain'] as const)for(const approved of [false,true]){
    const result=selectionSchemaForDiagnosis(f.source,f.canonical).parse({...f.valid,approved,gaps:[{...f.valid.gaps[0],decision}]});expect(result.approved).toBe(approved);expect(result.gaps[0].decision).toBe(decision);
  }
});
it('zero-gap diagnosis produces an empty-only gap array, without inventing a placeholder enum ID',()=>{
  const f=fixture(),diagnosis=structuredClone(f.canonical);diagnosis.units[0].gaps=[];
  const schema=selectionSchemaForDiagnosis(f.source,diagnosis),wire=z.toJSONSchema(schema) as unknown as {properties:{gaps:{minItems:number;maxItems:number}}};
  expect(wire.properties.gaps).toMatchObject({minItems:0,maxItems:0});expect(schema.safeParse({...f.valid,gaps:[]}).success).toBe(true);expect(schema.safeParse(f.valid).success).toBe(false);
});
it('duplicate valid IDs cannot replace a missing different ID even at the right array length',()=>{
  const f=fixture(),diagnosis=structuredClone(f.canonical);diagnosis.units.push({...structuredClone(diagnosis.units[0]),id:'u2',gaps:[]});
  const duplicated={...f.valid,units:[f.valid.units[0],f.valid.units[0]]};
  expect(selectionSchemaForDiagnosis(f.source,diagnosis).safeParse(duplicated).success).toBe(false);expect(()=>assertSelectionIdentity(diagnosis,duplicated)).toThrow();
});
it('a malformed reviewer ID may reuse a independently revalidated raw diagnosis without mutating any old record',()=>{
  const f=fixture(),before=structuredClone({diagnosisStage:f.diagnosisStage,selectionStage:f.selectionStage});
  expect(()=>assertSelectionIdentity(f.canonical,f.malformed)).toThrowError(expect.objectContaining({code:'material_selection_identity'}));
  const proof=recoverDiagnosisFromMalformedSelection(f.source,f.selectionStage,f.diagnosisStage);
  expect(proof).toMatchObject({diagnosisRunId:'raw-diagnosis',rejectedSelectionRunId:'bad-selection',reason:'selection_identity_mismatch'});
  expect(proof?.rawDiagnosis.units[0].english[0].occurrence).toBe(172);expect(proof?.diagnosis.units[0].english[0].occurrence).toBe(0);expect(proof?.normalizations).toHaveLength(1);
  expect(f.diagnosisStage).toEqual(before.diagnosisStage);expect(f.selectionStage).toEqual(before.selectionStage);expect(JSON.parse(f.selectionStage.output_json).approved).toBe(false);
});
it('recovery requires same source, same material, referenced run and intact input identity',()=>{
  const f=fixture();
  const sourceChanged={...f.source,actualAnswer:'different'};
  expect(recoverDiagnosisFromMalformedSelection(sourceChanged,f.selectionStage,f.diagnosisStage)).toBeNull();
  expect(recoverDiagnosisFromMalformedSelection(f.source,f.selectionStage,{...f.diagnosisStage,run_id:'unrelated'})).toBeNull();
  expect(recoverDiagnosisFromMalformedSelection(f.source,f.selectionStage,{...f.diagnosisStage,material_id:'other-material'})).toBeNull();
  expect(recoverDiagnosisFromMalformedSelection(f.source,{...f.selectionStage,input_hash:'wrong'},f.diagnosisStage)).toBeNull();
  expect(recoverDiagnosisFromMalformedSelection(f.source,f.selectionStage,{...f.diagnosisStage,status:'pending'})).toBeNull();
});
it('raw diagnosis with invalid coverage or ambiguous repeated references is never revived on an error code alone',()=>{
  const f=fixture(),bad=structuredClone(f.raw);bad.units[0].english=[{text:'I use',occurrence:0}];
  expect(recoverDiagnosisFromMalformedSelection(f.source,f.selectionStage,{...f.diagnosisStage,output_json:JSON.stringify(bad)})).toBeNull();
  const repeatedSource={...f.source,actualAnswer:'I use phone. I use phone.'},raw=structuredClone(f.raw);raw.units[0].english=[{text:'I use phone.',occurrence:13}];
  const d=f.stage('diagnosis','raw-diagnosis',{source:repeatedSource},raw),s=f.stage('selection','bad-selection',{source:repeatedSource,diagnosis:raw,diagnosisRunId:d.run_id},f.malformed);
  expect(recoverDiagnosisFromMalformedSelection(repeatedSource,s,d)).toBeNull();
});
it('the prior reviewer input must equal the canonical raw diagnosis; altered targets cannot be rescued',()=>{
  const f=fixture(),modified=structuredClone(f.canonical);modified.units[0].gaps[0].targetEnglish='a tablet';
  const changed=f.stage('selection','bad-selection',{source:f.source,diagnosis:modified,diagnosisRunId:f.diagnosisStage.run_id},f.malformed);
  expect(recoverDiagnosisFromMalformedSelection(f.source,changed,f.diagnosisStage)).toBeNull();
});
