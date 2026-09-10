import {afterEach,expect,it} from 'vitest';
import fs from 'node:fs';
import {portableTestDatabase} from './helpers/portable-db';
import {MockAiProvider} from '@/lib/ai/mock-provider';
import {createRuntimeCalls} from '@/lib/ai/runtime-ledger';
import type {StructuredAiRequest} from '@/lib/ai/contracts';
import {createMaterialService} from '@/lib/four-step/core-materials';
import {selectionMockResolver} from '@/lib/four-step/selection-mock';
import {normalizeUniqueQuoteOccurrences} from '@/lib/four-step/quote-normalization';
import type {Diagnosis} from '@/lib/four-step/selection-contracts';
import type {MaterialInput} from '@/lib/four-step/material-types';
const opened:Array<ReturnType<typeof portableTestDatabase>>=[];
afterEach(()=>opened.splice(0).forEach(f=>f.close()));
function setup(resolve:(request:StructuredAiRequest<unknown>)=>unknown){
  const f=portableTestDatabase();opened.push(f);let id=0,time=0;
  const platform={now:()=>new Date(Date.parse('2026-09-11T10:00:00Z')+time++),newId:()=>`normalization-run-${++id}`,bootId:'normalization-test',allowMock:true,loadPrompt:(name:string)=>fs.readFileSync('pipeline/prompts/'+name,'utf8')};
  const runtime=createRuntimeCalls(f.database,new MockAiProvider(resolve),platform),materials=createMaterialService({...platform,database:f.database,runtime});
  async function prepare(english:string,chinese:string){
    const source:MaterialInput={sourceType:'ielts_practice',sourceId:'source-normalization',question:{id:'question-normalization',textEn:'What would you like to tell me?',textZh:'你想告诉我什么？',part:1},mode:'practice',actualAnswer:english,intendedMeaningZh:chinese,spokenStyleVersion:'personal-spoken-v2',selectionPolicyVersion:'evidence-exclusion-v1',sentenceStudyVersion:'sentence-material-v1',registerProfileVersion:'young-us-v1'};
    f.connection.prepare("INSERT INTO questions(id,book_id,part,text,text_zh,norm_text) VALUES('question-normalization','retired',1,'What would you like to tell me?','你想告诉我什么？','normalization')").run();
    f.connection.prepare("INSERT INTO speaking_question_attempts(id,question_id,mode,answer_text,intended_meaning_zh,status) VALUES('source-normalization','question-normalization','practice',?,?,'processing')").run(english,chinese);
    return {source,material:await materials.prepare(source)};
  }
  return {...f,materials,prepare};
}
function rawOffsets(request:StructuredAiRequest<unknown>):Diagnosis{
  const value=structuredClone(selectionMockResolver(request)) as Diagnosis;
  for(const unit of value.units){for(const quote of unit.english)quote.occurrence=172;for(const quote of unit.chinese)quote.occurrence=674;}
  return value;
}
it('unique ordinal normalization retains raw Runtime/stage data while canonical downstream evidence passes publication audit',async()=>{
  let raw:Diagnosis|undefined;const sent:Array<StructuredAiRequest<unknown>>=[];
  const f=setup(request=>{sent.push(request);if(request.schemaName.startsWith('four_step_diagnosis'))return raw=rawOffsets(request);return selectionMockResolver(request);});
  const {source,material}=await f.prepare("I'm used to live alone.",'我已经习惯一个人住了。');
  const completed=await f.materials.process(material.id);expect(completed.status).toBe('ready');
  const stage=f.connection.prepare("SELECT * FROM practice_material_stages WHERE material_id=? AND stage='diagnosis' AND status='completed'").get(material.id) as {run_id:string;output_json:string};
  const receipt=f.connection.prepare('SELECT response_json FROM runtime_requests WHERE run_id=?').get(stage.run_id) as {response_json:string};
  expect(JSON.parse(stage.output_json)).toEqual(raw);expect(JSON.parse(receipt.response_json).data).toEqual(raw);
  expect(raw?.units[0].english[0].occurrence).toBe(172);expect(raw?.units[0].chinese[0].occurrence).toBe(674);
  const expected=normalizeUniqueQuoteOccurrences(source,raw!).diagnosis;
  const selectionInput=JSON.parse(sent.find(r=>r.schemaName.startsWith('four_step_selection'))!.input);
  expect(selectionInput.diagnosis).toEqual(expected);expect(JSON.parse(completed.analysis_json).evidence.diagnosis).toEqual(expected);
  expect(sent).toHaveLength(4);expect(sent.some(r=>r.promptVersion.includes('repair'))).toBe(false);
  expect(await f.materials.inspect(material.id)).toMatchObject({verified:true,audit:{ok:true,checked:1,issues:[]}});
  await f.materials.process(material.id,{retry:true});expect(sent).toHaveLength(4);
});
it('rejected repeated quotes stay rejected and later feedback repair quotes the exact referenced raw diagnosis, not its canonical copy',async()=>{
  const sent:Array<StructuredAiRequest<unknown>>=[];let diagnosisCalls=0,selectionCalls=0;
  const f=setup(request=>{
    sent.push(request);
    if(request.schemaName.startsWith('four_step_diagnosis')){
      diagnosisCalls++;const output=rawOffsets(request);
      if(diagnosisCalls===2)output.units[0].english=[{text:'I read',occurrence:8}];
      return output;
    }
    const output=selectionMockResolver(request);
    if(request.schemaName.startsWith('four_step_selection')&&++selectionCalls===1)return {...output as object,approved:false,reasonZh:'合成独立拒绝：需要重新检查相同意思的归并。'};
    return output;
  });
  const {material}=await f.prepare('I read. I read manga.','我读东西，也看漫画。');
  expect((await f.materials.process(material.id)).status).toBe('failed');expect(diagnosisCalls).toBe(1);
  expect((await f.materials.process(material.id,{retry:true})).status).toBe('failed');expect(diagnosisCalls).toBe(2);
  const invalid=f.connection.prepare("SELECT run_id,output_json FROM practice_material_stages WHERE material_id=? AND stage='diagnosis' AND status='rejected' ORDER BY created_at DESC LIMIT 1").get(material.id) as {run_id:string;output_json:string};
  expect(JSON.parse(invalid.output_json).units[0].english[0]).toEqual({text:'I read',occurrence:8});
  const invalidReceipt=f.connection.prepare('SELECT response_json FROM runtime_requests WHERE run_id=?').get(invalid.run_id) as {response_json:string};
  expect(JSON.parse(invalidReceipt.response_json).data.units[0].english[0].occurrence).toBe(8);
  const resumed=await f.materials.process(material.id,{retry:true});
  const repairs=sent.filter(r=>r.schemaName.startsWith('four_step_diagnosis')&&JSON.parse(r.input).correction);
  expect(repairs).toHaveLength(2);
  for(const request of repairs){
    const correction=JSON.parse(request.input).correction;
    const previous=f.connection.prepare('SELECT output_json FROM practice_material_stages WHERE run_id=?').get(correction.previousRunId) as {output_json:string};
    expect(correction.previousDiagnosis).toEqual(JSON.parse(previous.output_json));
  }
  expect(resumed.status).toBe('ready');expect(await f.materials.inspect(material.id)).toMatchObject({verified:true,audit:{ok:true,issues:[]}});
  expect(f.connection.prepare("SELECT output_json FROM practice_material_stages WHERE run_id=?").get(invalid.run_id)).toEqual({output_json:invalid.output_json});

  // With no rejected selection, the next explicit retry resumes the latest structurally rejected
  // raw diagnosis and gives the exact ordinal/count explanation, instead of starting a fresh diagnosis.
  const structuralRequests:Array<StructuredAiRequest<unknown>>=[];let structuralCalls=0;
  const structural=setup(request=>{
    structuralRequests.push(request);
    if(request.schemaName.startsWith('four_step_diagnosis')){const output=rawOffsets(request);if(++structuralCalls<=2)output.units[0].english=[{text:'I read',occurrence:8}];return output;}
    return selectionMockResolver(request);
  });
  const second=await structural.prepare('I read. I read manga.','我读东西，也看漫画。');
  expect((await structural.materials.process(second.material.id)).status).toBe('failed');expect(structuralCalls).toBe(2);
  const lastRejected=structural.connection.prepare("SELECT run_id,output_json FROM practice_material_stages WHERE material_id=? AND stage='diagnosis' AND status='rejected' ORDER BY created_at DESC LIMIT 1").get(second.material.id) as {run_id:string;output_json:string};
  expect((await structural.materials.process(second.material.id,{retry:true})).status).toBe('ready');
  const lastRepair=JSON.parse(structuralRequests.filter(r=>r.schemaName.startsWith('four_step_diagnosis')).at(-1)!.input).correction;
  expect(lastRepair.previousRunId).toBe(lastRejected.run_id);expect(lastRepair.previousDiagnosis).toEqual(JSON.parse(lastRejected.output_json));
  expect(lastRepair.validationIssue).toContain('occurrence是相同引用全文的零起始出现序号');expect(lastRepair.validationIssue).toContain('"validOccurrenceCount":2');
  expect(await structural.materials.inspect(second.material.id)).toMatchObject({verified:true,audit:{ok:true,issues:[]}});
});
