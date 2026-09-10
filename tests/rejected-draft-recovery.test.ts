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
import {diagnosisSchema,selectionSchemaForSource,recallMaterialDraftSchema} from '@/lib/four-step/selection-contracts';
import {materialStageContracts} from '@/lib/four-step/stage-contracts';
import type {MaterialInput} from '@/lib/four-step/material-types';
import {hash} from '@/lib/four-step/shared';
const fixtures:Array<ReturnType<typeof portableTestDatabase>>=[];
afterEach(()=>fixtures.splice(0).forEach(f=>f.close()));

it.each(['pass','review_refuses','changed_draft','forged_source','changed_receipt','receipt_not_completed'] as const)('only exact old generated evidence reaches the one required independent final review (%s)',async scenario=>{
  const f=portableTestDatabase();fixtures.push(f);let sequence=0,tick=0,seeding=true;
  const calls:Array<StructuredAiRequest<unknown>>=[];
  const platform={now:()=>new Date(Date.parse('2026-09-11T13:00:00Z')+tick++),newId:()=>`draft-recovery-${++sequence}`,bootId:'draft-recovery',allowMock:true,loadPrompt:(name:string)=>fs.readFileSync('pipeline/prompts/'+name,'utf8')};
  const source:MaterialInput={sourceType:'ielts_practice',sourceId:'draft-source',question:{id:'draft-question',textEn:'What would you like to say?',textZh:'你想说什么？',part:1},mode:'practice',actualAnswer:'I like reading. I use phone. It easy.',intendedMeaningZh:'我喜欢阅读。我用手机，操作很简单。',spokenStyleVersion:'personal-spoken-v2',selectionPolicyVersion:'evidence-exclusion-v1',sentenceStudyVersion:'sentence-material-v1',registerProfileVersion:'young-us-v1'};
  const diagnosis=diagnosisSchema.parse({units:[
    {id:'u0',intentZh:'我喜欢阅读。',english:[{text:'I like reading.',occurrence:0}],chinese:[{text:'我喜欢阅读。',occurrence:0}],status:'natural',reasonZh:'已经自然表达喜欢阅读。',gaps:[]},
    {id:'u1',intentZh:'我用手机，操作很简单。',english:[{text:'I use phone.',occurrence:0},{text:'It easy.',occurrence:0}],chinese:[{text:'我用手机，操作很简单。',occurrence:0}],status:'repair',reasonZh:'冠词和be需要修复。',gaps:[
      {id:'g1',kind:'grammar_gap',cueZh:'一部手机',targetEnglish:'a phone',acceptableVariants:[],senseKey:'one-phone',evidenceQuote:'phone',whyNeededZh:'单数手机需要限定词。'},
      {id:'g2',kind:'grammar_gap',cueZh:'操作很简单',targetEnglish:"it's easy",acceptableVariants:[],senseKey:'it-is-easy',evidenceQuote:'It easy.',whyNeededZh:'形容词前需要be。'},
    ]},
  ]});
  const draft=recallMaterialDraftSchema.parse({sentences:[{id:'s0',intentUnitIds:['u0'],english:'I enjoy reading.'},{id:'s1',intentUnitIds:['u1'],english:"I use a phone; it's easy."}],rows:[
    {gapId:'g1',sentenceId:'s1',surfaceInSentence:'a phone',recallPromptZh:'我用一部手机。',recallAnswerEn:'I use a phone.'},
    {gapId:'g2',sentenceId:'s1',surfaceInSentence:"it's easy",recallPromptZh:'操作很简单。',recallAnswerEn:"it's easy."},
  ],examFeedback:null});
  const provider=new MockAiProvider(request=>{
    calls.push(request);
    if(request.schemaName.startsWith('four_step_diagnosis'))return diagnosis;
    if(request.schemaName.startsWith('four_step_material')){if(!seeding)throw new AiProviderError('Negative control stops a fresh generation','invalid_output',false);return draft;}
    const value=selectionMockResolver(request);
    return request.schemaName.startsWith('four_step_review')&&scenario==='review_refuses'?{...value as object,approved:false,reasonZh:'独立审核不接受本次材料。'}:value;
  });
  const runtime=createRuntimeCalls(f.database,provider,platform),materials=createMaterialService({...platform,database:f.database,runtime});
  f.connection.prepare("INSERT INTO questions(id,book_id,part,text,text_zh,norm_text) VALUES('draft-question','retired',1,'What would you like to say?','你想说什么？','draft-question')").run();
  f.connection.prepare("INSERT INTO speaking_question_attempts(id,question_id,mode,answer_text,intended_meaning_zh,status) VALUES('draft-source','draft-question','practice',?,?,'failed')").run(source.actualAnswer,source.intendedMeaningZh);
  const material=await materials.prepare(source),contracts=materialStageContracts(source),diagnosisInput=JSON.stringify({source});
  const d=await runtime.call({role:'gap_generator',instructions:await platform.loadPrompt(contracts.diagnosis.prompt),input:diagnosisInput,schema:diagnosisSchema,schemaName:'four_step_diagnosis_v5',promptVersion:contracts.diagnosis.prompt,schemaVersion:'four-step-diagnosis-v5',idempotencyKey:'seed-diagnosis'});
  const selectionInput=JSON.stringify({source,diagnosis,diagnosisRunId:d.runId});
  const s=await runtime.call({role:'gap_reviewer',instructions:await platform.loadPrompt(contracts.selection.prompt),input:selectionInput,schema:selectionSchemaForSource(source),schemaName:'four_step_selection_v5',promptVersion:contracts.selection.prompt,schemaVersion:'four-step-selection-v5',idempotencyKey:'seed-selection'});
  const materialInput=JSON.stringify({source,diagnosis,selection:s.data,selectionRunId:s.runId});
  const generated=await runtime.call({role:'learning_material_compiler',instructions:await platform.loadPrompt(contracts.material.prompt),input:materialInput,schema:recallMaterialDraftSchema,schemaName:'four_step_material_v5',promptVersion:contracts.material.prompt,schemaVersion:'four-step-material-v5',idempotencyKey:'seed-material'});
  await f.database.write(async tx=>{
    for(const [result,name,input,status] of [[d,'diagnosis',diagnosisInput,'completed'],[s,'selection',selectionInput,'completed'],[generated,'material',materialInput,'rejected']] as const){
      await tx.run(sql`INSERT INTO practice_material_stages(run_id,material_id,stage,prompt_version,input_hash,input_json,output_json,status,created_at) VALUES(${result.runId},${material.id},${name},${contracts[name].prompt},${hash(contracts[name].prompt,input)},${input},${JSON.stringify(result.data)},${status},${platform.now().toISOString()})`);
    }
    await tx.run(sql`UPDATE practice_materials SET status='failed',error_code=${scenario==='review_refuses'?'material_recall_alignment':'material_natural_rewritten'} WHERE id=${material.id}`);
  });
  if(scenario==='changed_draft'){const changed=structuredClone(draft);changed.sentences[0].english='I enjoy dancing.';f.connection.prepare('UPDATE practice_material_stages SET output_json=? WHERE run_id=?').run(JSON.stringify(changed),generated.runId);}
  if(scenario==='forged_source')f.connection.prepare('UPDATE practice_material_stages SET input_json=? WHERE run_id=?').run(JSON.stringify({...JSON.parse(materialInput),source:{...source,actualAnswer:'Forged source.'}}),generated.runId);
  if(scenario==='changed_receipt'){
    const row=f.connection.prepare('SELECT response_json FROM runtime_requests WHERE run_id=?').get(generated.runId) as {response_json:string};
    const changed=JSON.parse(row.response_json);changed.data.sentences[0].english='I enjoy dancing.';f.connection.prepare('UPDATE runtime_requests SET response_json=? WHERE run_id=?').run(JSON.stringify(changed),generated.runId);
  }
  if(scenario==='receipt_not_completed')f.connection.prepare("UPDATE runtime_requests SET state='unknown' WHERE run_id=?").run(generated.runId);
  const oldStage=f.connection.prepare('SELECT * FROM practice_material_stages WHERE run_id=?').get(generated.runId) as Record<string,unknown>;
  const oldRun=f.connection.prepare('SELECT * FROM ai_runs WHERE run_id=?').get(generated.runId),oldReceipt=f.connection.prepare('SELECT * FROM runtime_requests WHERE run_id=?').get(generated.runId);
  const before=calls.length;seeding=false;
  const result=await materials.process(material.id,{retry:true}),newCalls=calls.slice(before);
  if(scenario==='pass'||scenario==='review_refuses'){
    expect(newCalls.map(c=>c.schemaName)).toEqual(['four_step_review_v5']);expect(JSON.parse(newCalls[0].input).generatorRunId).toBe(generated.runId);
    expect(JSON.parse(newCalls[0].input).compiled.evidence.draft).toEqual(draft);
  }else expect(newCalls.map(c=>c.schemaName)).toEqual(['four_step_material_v5']);
  expect(result.status).toBe(scenario==='pass'?'ready':'failed');
  if(scenario==='pass')expect(await materials.inspect(material.id)).toMatchObject({verified:true,audit:{ok:true,checked:1,issues:[]}});
  else expect(f.connection.prepare('SELECT * FROM practice_material_items').all()).toHaveLength(0);
  expect(f.connection.prepare('SELECT * FROM practice_material_stages WHERE run_id=?').get(generated.runId)).toEqual({...oldStage,status:scenario==='pass'?'completed':'rejected'});
  expect(f.connection.prepare('SELECT * FROM ai_runs WHERE run_id=?').get(generated.runId)).toEqual(oldRun);expect(f.connection.prepare('SELECT * FROM runtime_requests WHERE run_id=?').get(generated.runId)).toEqual(oldReceipt);
});
