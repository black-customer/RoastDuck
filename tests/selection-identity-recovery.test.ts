import {afterEach,expect,it} from 'vitest';
import fs from 'node:fs';
import {portableTestDatabase} from './helpers/portable-db';
import {query as sql} from '@/lib/platform/sql';
import {createMaterialService} from '@/lib/four-step/core-materials';
import {createRuntimeCalls} from '@/lib/ai/runtime-ledger';
import {MockAiProvider} from '@/lib/ai/mock-provider';
import type {StructuredAiRequest} from '@/lib/ai/contracts';
import {selectionMockResolver} from '@/lib/four-step/selection-mock';
import {diagnosisSchema,selectionSchemaForSource,type Diagnosis} from '@/lib/four-step/selection-contracts';
import {normalizeUniqueQuoteOccurrences} from '@/lib/four-step/quote-normalization';
import {materialStageContracts} from '@/lib/four-step/stage-contracts';
import type {MaterialInput} from '@/lib/four-step/material-types';
import {hash} from '@/lib/four-step/shared';
const fixtures:Array<ReturnType<typeof portableTestDatabase>>=[];
afterEach(()=>fixtures.splice(0).forEach(f=>f.close()));

it.each([true,false])('legacy extra reviewer ID reuses the original diagnosis; a new independent approval controls restoration (approved=%s)',async approved=>{
  const f=portableTestDatabase();fixtures.push(f);let sequence=0,tick=0,seeding=true,diagnosisRunId='';
  const requests:Array<StructuredAiRequest<unknown>>=[];
  const platform={now:()=>new Date(Date.parse('2026-09-11T10:00:00Z')+tick++),newId:()=>`closed-recovery-${++sequence}`,bootId:'closed-recovery',allowMock:true,loadPrompt:(name:string)=>fs.readFileSync('pipeline/prompts/'+name,'utf8')};
  const source:MaterialInput={sourceType:'ielts_practice',sourceId:'closed-recovery-attempt',question:{id:'closed-recovery-question',textEn:'Do you live alone?',textZh:'你一个人住吗？',part:1},mode:'practice',actualAnswer:"I'm used to live alone.",intendedMeaningZh:'我已经习惯一个人住了。',spokenStyleVersion:'personal-spoken-v2',selectionPolicyVersion:'evidence-exclusion-v1',sentenceStudyVersion:'sentence-material-v1',registerProfileVersion:'young-us-v1'};
  const provider=new MockAiProvider(request=>{
    requests.push(request);const value=selectionMockResolver(request);
    if(request.schemaName.startsWith('four_step_diagnosis')){const raw=value as Diagnosis;raw.units[0].english[0].occurrence=172;return raw;}
    if(request.schemaName.startsWith('four_step_selection')){
      if(seeding){const result=value as {gaps:Array<{gapId:string}>};return {...result,approved:false,gaps:[...result.gaps,{...result.gaps[0],gapId:'g7b'}]};}
      expect(f.connection.prepare('SELECT status FROM practice_material_stages WHERE run_id=?').get(diagnosisRunId)).toEqual({status:'rejected'});
      return {...value as object,approved};
    }
    if(request.schemaName.startsWith('four_step_material'))expect(f.connection.prepare('SELECT status FROM practice_material_stages WHERE run_id=?').get(diagnosisRunId)).toEqual({status:'completed'});
    return value;
  });
  const runtime=createRuntimeCalls(f.database,provider,platform),materials=createMaterialService({...platform,database:f.database,runtime});
  f.connection.prepare("INSERT INTO questions(id,book_id,part,text,text_zh,norm_text) VALUES('closed-recovery-question','retired',1,'Do you live alone?','你一个人住吗？','closed-recovery-question')").run();
  f.connection.prepare("INSERT INTO speaking_question_attempts(id,question_id,mode,answer_text,intended_meaning_zh,status) VALUES('closed-recovery-attempt','closed-recovery-question','practice',?,?,'failed')").run(source.actualAnswer,source.intendedMeaningZh);
  const material=await materials.prepare(source),contracts=materialStageContracts(source);
  const diagnosisInput=JSON.stringify({source}),diagnosed=await runtime.call({role:'gap_generator',instructions:await platform.loadPrompt(contracts.diagnosis.prompt),input:diagnosisInput,schema:diagnosisSchema,schemaName:'four_step_diagnosis_v5',promptVersion:contracts.diagnosis.prompt,schemaVersion:'four-step-diagnosis-v5',idempotencyKey:'old-diagnosis'});
  diagnosisRunId=diagnosed.runId;
  const canonical=normalizeUniqueQuoteOccurrences(source,diagnosed.data).diagnosis,selectionInput=JSON.stringify({source,diagnosis:canonical,diagnosisRunId});
  const selected=await runtime.call({role:'gap_reviewer',instructions:await platform.loadPrompt(contracts.selection.prompt),input:selectionInput,schema:selectionSchemaForSource(source),schemaName:'four_step_selection_v5',promptVersion:contracts.selection.prompt,schemaVersion:'four-step-selection-v5-evidence-exclusion-v1',idempotencyKey:'old-selection'});
  await f.database.write(async tx=>{
    for(const [run,stage,input,output] of [[diagnosed.runId,'diagnosis',diagnosisInput,diagnosed.data],[selected.runId,'selection',selectionInput,selected.data]] as const){
      await tx.run(sql`INSERT INTO practice_material_stages(run_id,material_id,stage,prompt_version,input_hash,input_json,output_json,status,created_at)
        VALUES(${run},${material.id},${stage},${contracts[stage].prompt},${hash(contracts[stage].prompt,input)},${input},${JSON.stringify(output)},'rejected',${platform.now().toISOString()})`);
    }
    await tx.run(sql`UPDATE practice_materials SET status='failed',error_code='material_selection_rejected' WHERE id=${material.id}`);
  });
  const oldDiagnosis=f.connection.prepare('SELECT * FROM practice_material_stages WHERE run_id=?').get(diagnosisRunId) as Record<string,unknown>;
  const oldSelection=f.connection.prepare('SELECT * FROM practice_material_stages WHERE run_id=?').get(selected.runId);
  const originalReceipt=f.connection.prepare('SELECT response_json FROM runtime_requests WHERE run_id=?').get(diagnosisRunId);
  const before=requests.length;seeding=false;
  const completed=await materials.process(material.id,{retry:true});
  const later=requests.slice(before);
  expect(later.map(r=>r.schemaName)).toEqual(approved?['four_step_selection_v5','four_step_material_v5','four_step_review_v5']:['four_step_selection_v5']);
  expect(later[0].schemaVersion).toContain('closed-ids-v1');expect(JSON.parse(later[0].input).diagnosisRunId).toBe(diagnosisRunId);
  const finalDiagnosis=f.connection.prepare('SELECT * FROM practice_material_stages WHERE run_id=?').get(diagnosisRunId) as Record<string,unknown>;
  expect(finalDiagnosis).toEqual({...oldDiagnosis,status:approved?'completed':'rejected'});
  expect(f.connection.prepare('SELECT * FROM practice_material_stages WHERE run_id=?').get(selected.runId)).toEqual(oldSelection);
  expect(f.connection.prepare('SELECT response_json FROM runtime_requests WHERE run_id=?').get(diagnosisRunId)).toEqual(originalReceipt);
  expect(f.connection.prepare("SELECT * FROM ai_runs WHERE role='gap_generator'").all()).toHaveLength(1);
  expect(completed.status).toBe(approved?'ready':'failed');
  if(approved)expect(await materials.inspect(material.id)).toMatchObject({verified:true,audit:{ok:true,checked:1,issues:[]}});
  else expect(f.connection.prepare('SELECT * FROM practice_material_items').all()).toHaveLength(0);
});
