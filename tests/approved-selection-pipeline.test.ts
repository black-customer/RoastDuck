import {afterEach,expect,it} from 'vitest';
import fs from 'node:fs';
import {portableTestDatabase} from './helpers/portable-db';
import {query as sql} from '@/lib/platform/sql';
import {createMaterialService} from '@/lib/four-step/core-materials';
import {createRuntimeCalls} from '@/lib/ai/runtime-ledger';
import {MockAiProvider} from '@/lib/ai/mock-provider';
import {AiProviderError} from '@/lib/ai/errors';
import type {StructuredAiRequest} from '@/lib/ai/contracts';
import {selectionMockResolver} from '@/lib/four-step/selection-mock';
import {diagnosisSchema,selectionSchemaForSource,type Diagnosis,type SelectionReview} from '@/lib/four-step/selection-contracts';
import {normalizeUniqueQuoteOccurrences} from '@/lib/four-step/quote-normalization';
import {materialStageContracts} from '@/lib/four-step/stage-contracts';
import type {MaterialInput} from '@/lib/four-step/material-types';
import {hash} from '@/lib/four-step/shared';
const open:Array<ReturnType<typeof portableTestDatabase>>=[];
afterEach(()=>open.splice(0).forEach(f=>f.close()));

it('an existing approved complete-reference citation needs only material/review calls; negative or altered reviews cannot use that recovery',async()=>{
  for(const outcome of ['approved','false','altered'] as const){
    const f=portableTestDatabase();open.push(f);let sequence=0,tick=0,seeding=true;
    const requests:Array<StructuredAiRequest<unknown>>=[];
    const english="I'm used to live alone.",chinese='我已经习惯一个人住了。',raw=english+'\n'+chinese;
    const source:MaterialInput={sourceType:'ielts_practice',sourceId:'approved-source',question:{id:'approved-q',textEn:'Do you live alone?',textZh:'你一个人住吗？',part:1},mode:'practice',actualAnswer:raw,intendedMeaningZh:'',rawInput:raw,inputFormat:'mixed-v1',spokenStyleVersion:'personal-spoken-v2',selectionPolicyVersion:'evidence-exclusion-v1',sentenceStudyVersion:'sentence-material-v1',registerProfileVersion:'young-us-v1'};
    const platform={now:()=>new Date(Date.parse('2026-09-11T12:00:00Z')+tick++),newId:()=>`citation-${++sequence}`,bootId:'citation-test',allowMock:true,loadPrompt:(name:string)=>fs.readFileSync('pipeline/prompts/'+name,'utf8')};
    const provider=new MockAiProvider(request=>{
      requests.push(request);
      if(!seeding&&request.schemaName.startsWith('four_step_diagnosis'))throw new AiProviderError('Negative control stops before a new diagnosis','invalid_output',false);
      const value=selectionMockResolver(request);
      if(request.schemaName.startsWith('four_step_diagnosis')){const d=value as Diagnosis;d.units[0].english=[{text:english,occurrence:172}];d.units[0].chinese=[{text:chinese,occurrence:674}];d.units[0].raw=[{text:english,occurrence:0},{text:chinese,occurrence:0}];return d;}
      if(request.schemaName.startsWith('four_step_selection')){const s=value as SelectionReview;s.units[0].evidenceQuote=english+' ... '+(outcome==='altered'?'我喜欢旅行。':chinese);s.approved=outcome!=='false';return s;}
      if(request.schemaName.startsWith('four_step_review')){
        const review=value as {sentences:Array<{evidence:Array<{sourceField:string;sourceQuote:string}>}>};
        for(const sentence of review.sentences)sentence.evidence=sentence.evidence.map(e=>({...e,sourceField:'rawInput'}));
      }
      return value;
    });
    const runtime=createRuntimeCalls(f.database,provider,platform),materials=createMaterialService({...platform,database:f.database,runtime});
    f.connection.prepare("INSERT INTO questions(id,book_id,part,text,text_zh,norm_text) VALUES('approved-q','retired',1,'Do you live alone?','你一个人住吗？','approved-q')").run();
    f.connection.prepare("INSERT INTO speaking_question_attempts(id,question_id,mode,answer_text,intended_meaning_zh,status) VALUES('approved-source','approved-q','practice',?,'','failed')").run(raw);
    const material=await materials.prepare(source),contracts=materialStageContracts(source),diagnosisInput=JSON.stringify({source});
    const diagnosis=await runtime.call({role:'gap_generator',instructions:await platform.loadPrompt(contracts.diagnosis.prompt),input:diagnosisInput,schema:diagnosisSchema,schemaName:'four_step_diagnosis_v5',promptVersion:contracts.diagnosis.prompt,schemaVersion:'four-step-diagnosis-v5',idempotencyKey:'original-diagnosis'});
    const canonical=normalizeUniqueQuoteOccurrences(source,diagnosis.data).diagnosis,selectionInput=JSON.stringify({source,diagnosis:canonical,diagnosisRunId:diagnosis.runId});
    const selection=await runtime.call({role:'gap_reviewer',instructions:await platform.loadPrompt(contracts.selection.prompt),input:selectionInput,schema:selectionSchemaForSource(source),schemaName:'four_step_selection_v5',promptVersion:contracts.selection.prompt,schemaVersion:'four-step-selection-v5',idempotencyKey:'original-selection'});
    await f.database.write(async tx=>{
      for(const [result,name,input] of [[diagnosis,'diagnosis',diagnosisInput],[selection,'selection',selectionInput]] as const){
        await tx.run(sql`INSERT INTO practice_material_stages(run_id,material_id,stage,prompt_version,input_hash,input_json,output_json,status,created_at)
          VALUES(${result.runId},${material.id},${name},${contracts[name].prompt},${hash(contracts[name].prompt,input)},${input},${JSON.stringify(result.data)},'rejected',${platform.now().toISOString()})`);
      }
      await tx.run(sql`UPDATE practice_materials SET status='failed',error_code='material_selection_evidence' WHERE id=${material.id}`);
    });
    const beforeStages=f.connection.prepare('SELECT * FROM practice_material_stages ORDER BY run_id').all() as Array<Record<string,unknown>>;
    const beforeRuns=f.connection.prepare('SELECT * FROM ai_runs ORDER BY run_id').all() as Array<Record<string,unknown>>;
    const beforeReceipts=f.connection.prepare('SELECT * FROM runtime_requests ORDER BY run_id').all() as Array<Record<string,unknown>>;
    const before=requests.length;seeding=false;
    const result=await materials.process(material.id,{retry:true});
    const later=requests.slice(before);
    if(outcome==='approved'){
      expect(later.map(r=>r.schemaName)).toEqual(['four_step_material_v5','four_step_review_v5']);expect(result.status).toBe('ready');
      expect(JSON.parse(later[0].input).selectionRunId).toBe(selection.runId);
      expect(await materials.inspect(material.id)).toMatchObject({verified:true,audit:{ok:true,checked:1,issues:[]}});
    }else{
      expect(later.map(r=>r.schemaName)).toEqual(['four_step_diagnosis_v5']);expect(result.status).toBe('failed');
      expect(f.connection.prepare('SELECT * FROM practice_material_items').all()).toHaveLength(0);
    }
    for(const original of beforeStages)expect(f.connection.prepare('SELECT * FROM practice_material_stages WHERE run_id=?').get(String(original.run_id))).toEqual({...original,status:outcome==='approved'?'completed':'rejected'});
    for(const original of beforeRuns)expect(f.connection.prepare('SELECT * FROM ai_runs WHERE run_id=?').get(String(original.run_id))).toEqual(original);
    for(const original of beforeReceipts)expect(f.connection.prepare('SELECT * FROM runtime_requests WHERE run_id=?').get(String(original.run_id))).toEqual(original);
  }
});
