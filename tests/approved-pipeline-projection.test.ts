import {afterEach,expect,it} from 'vitest';
import fs from 'node:fs';
import {portableTestDatabase} from './helpers/portable-db';
import {query as sql} from '@/lib/platform/sql';
import {MockAiProvider} from '@/lib/ai/mock-provider';
import {createRuntimeCalls} from '@/lib/ai/runtime-ledger';
import {createMaterialService} from '@/lib/four-step/core-materials';
import type {StructuredAiRequest} from '@/lib/ai/contracts';
import {selectionMockResolver} from '@/lib/four-step/selection-mock';
import {compileEvidence,diagnosisSchema,selectionSchemaForSource,recallMaterialDraftSchema,recallEvidenceReviewSchema} from '@/lib/four-step/selection-contracts';
import {normalizeUniqueQuoteOccurrences} from '@/lib/four-step/quote-normalization';
import {speakingAttemptAnalysisSchema} from '@/lib/speaking-practice/schemas';
import {recoverApprovedPipeline} from '@/lib/four-step/approved-pipeline';
import {matchesReviewedProjection} from '@/lib/four-step/reviewed-projection';
import type {MaterialInput} from '@/lib/four-step/material-types';
import {materialStageContracts} from '@/lib/four-step/stage-contracts';
import {hash} from '@/lib/four-step/shared';

const opened:Array<ReturnType<typeof portableTestDatabase>>=[];
afterEach(()=>opened.splice(0).forEach(f=>f.close()));
async function fixture(){
  const f=portableTestDatabase();opened.push(f);let id=0,tick=0;
  const requests:Array<StructuredAiRequest<unknown>>=[];
  const parts=[['I like parks.','总的来说，我喜欢公园。'],['I use phone.','我用手机。']],raw=parts.flat().join('\n');
  const source:MaterialInput={sourceType:'ielts_practice',sourceId:'positive-source',question:{id:'positive-q',textEn:'What do you like?',textZh:'你喜欢什么？',part:1},mode:'practice',actualAnswer:raw,rawInput:raw,intendedMeaningZh:'',inputFormat:'mixed-v1',spokenStyleVersion:'personal-spoken-v2',selectionPolicyVersion:'evidence-exclusion-v1',sentenceStudyVersion:'sentence-material-v1',registerProfileVersion:'young-us-v1'};
  const ref=(text:string)=>({text,occurrence:0});
  const originalDiagnosis=diagnosisSchema.parse({units:parts.map(([en,zh],i)=>({id:`u${i+6}`,intentZh:zh,english:[{text:en,occurrence:i===0?172:0}],chinese:[ref(zh)],raw:[ref(en),ref(zh)],status:'repair',reasonZh:'合成准备与真实冠词问题。',gaps:[{id:`g${i+6}`,kind:i?'grammar_gap':'lexical_gap',cueZh:i?'一部手机':'总的来说',targetEnglish:i?'a phone':'overall',acceptableVariants:[],senseKey:i?'one-phone':'summary',evidenceQuote:i?'phone':zh,whyNeededZh:i?'单数手机需要限定词。':'中文总结标记缺少英文，但原英文观点已经自然。'}]}))});
  const canonical=normalizeUniqueQuoteOccurrences(source,originalDiagnosis).diagnosis;
  const draft=recallMaterialDraftSchema.parse({sentences:[{id:'s6',intentUnitIds:['u6'],english:'Overall, I like parks.'},{id:'s7',intentUnitIds:['u7'],english:'I use a phone.'}],rows:[{gapId:'g6',sentenceId:'s6',surfaceInSentence:'Overall',recallPromptZh:parts[0][1],recallAnswerEn:'Overall, I like parks.'},{gapId:'g7',sentenceId:'s7',surfaceInSentence:'a phone',recallPromptZh:parts[1][1],recallAnswerEn:'I use a phone.'}],examFeedback:null});
  const platform={now:()=>new Date(Date.parse('2026-09-11T14:00:00Z')+tick++),newId:()=>`pipeline-cache-${++id}`,bootId:'pipeline-cache',allowMock:true,loadPrompt:(name:string)=>fs.readFileSync('pipeline/prompts/'+name,'utf8')};
  const provider=new MockAiProvider(request=>{
    requests.push(request);
    if(request.schemaName.startsWith('four_step_diagnosis'))return originalDiagnosis;
    if(request.schemaName.startsWith('four_step_material'))return draft;
    const value=selectionMockResolver(request);
    if(request.schemaName.startsWith('four_step_review')){
      const reviewed=recallEvidenceReviewSchema.parse(value);reviewed.rows[0].repairNeeded=false;reviewed.rows[0].minimalRepair=false;
      reviewed.sentences.forEach((sentence,i)=>{sentence.evidence=[{sourceField:'actualAnswer',sourceQuote:parts[i][1]}];});
      reviewed.wholeAnswer.evidence=[{sourceField:'actualAnswer',sourceQuote:parts[0][0]+' ... '+parts[0][1],rendering:'Overall, I like parks.',treatment:'adapted',reasonZh:'保留观点并补齐中文总结标记。'}];
      return reviewed;
    }
    return value;
  });
  const runtime=createRuntimeCalls(f.database,provider,platform),materials=createMaterialService({...platform,database:f.database,runtime});
  f.connection.prepare("INSERT INTO questions(id,book_id,part,text,text_zh,norm_text) VALUES('positive-q','retired',1,'What do you like?','你喜欢什么？','positive-q')").run();
  f.connection.prepare("INSERT INTO speaking_question_attempts(id,question_id,mode,answer_text,intended_meaning_zh,status) VALUES('positive-source','positive-q','practice',?,'','failed')").run(raw);
  const material=await materials.prepare(source),contracts=materialStageContracts(source),diagnosisInput=JSON.stringify({source});
  const d=await runtime.call({role:'gap_generator',instructions:await platform.loadPrompt(contracts.diagnosis.prompt),input:diagnosisInput,schema:diagnosisSchema,schemaName:'four_step_diagnosis_v5',promptVersion:contracts.diagnosis.prompt,schemaVersion:'v5',idempotencyKey:'history-d'});
  const selectionInput=JSON.stringify({source,diagnosis:canonical,diagnosisRunId:d.runId});
  const s=await runtime.call({role:'gap_reviewer',instructions:await platform.loadPrompt(contracts.selection.prompt),input:selectionInput,schema:selectionSchemaForSource(source),schemaName:'four_step_selection_v5',promptVersion:contracts.selection.prompt,schemaVersion:'v5',idempotencyKey:'history-s'});
  const materialInput=JSON.stringify({source,diagnosis:canonical,selection:s.data,selectionRunId:s.runId});
  const m=await runtime.call({role:'learning_material_compiler',instructions:await platform.loadPrompt(contracts.material.prompt),input:materialInput,schema:recallMaterialDraftSchema,schemaName:'four_step_material_v5',promptVersion:contracts.material.prompt,schemaVersion:'v5',idempotencyKey:'history-m'});
  const after=speakingAttemptAnalysisSchema.parse(compileEvidence(source,{diagnosis:canonical,selection:s.data,draft:m.data})),before=structuredClone(after);
  // Reproduce only the application's former derived-label bug in the actual historical review input.
  before.learningMaterials[0].learningBasis='confirmed_error';before.gaps[0].learningBasis='confirmed_error';before.gapCount=2;
  before.corrections.unshift({original:parts[0][0],corrected:draft.sentences[0].english,reasonZh:canonical.units[0].gaps[0].whyNeededZh});
  const reviewInput=JSON.stringify({source,compiled:before,generatorRunId:m.runId});
  const r=await runtime.call({role:'reviewer',instructions:await platform.loadPrompt(contracts.review.prompt),input:reviewInput,schema:recallEvidenceReviewSchema,schemaName:'four_step_review_v5',promptVersion:contracts.review.prompt,schemaVersion:'v5',idempotencyKey:'history-r'});
  await f.database.write(async tx=>{
    for(const [result,name,input,status] of [[d,'diagnosis',diagnosisInput,'completed'],[s,'selection',selectionInput,'completed'],[m,'material',materialInput,'rejected'],[r,'review',reviewInput,'rejected']] as const){
      await tx.run(sql`INSERT INTO practice_material_stages(run_id,material_id,stage,prompt_version,input_hash,input_json,output_json,status,created_at) VALUES(${result.runId},${material.id},${name},${contracts[name].prompt},${hash(contracts[name].prompt,input)},${input},${JSON.stringify(result.data)},${status},${platform.now().toISOString()})`);
    }
    await tx.run(sql`UPDATE practice_materials SET status='failed',error_code='material_review_rejected' WHERE id=${material.id}`);
  });
  const readProof=async()=>f.database.read(async tx=>{const [latest]=await tx.all<typeof material>(sql`SELECT * FROM practice_materials WHERE id=${material.id}`);return recoverApprovedPipeline(tx,latest);});
  return {...f,source,material,materials,runtime,requests,platform,before,after,review:r.data,reviewInput,reviewRunId:r.runId,draftRunId:m.runId,readProof};
}
it('the positive cached four-stage chain publishes with zero requests while correcting only a reviewed derived preparation label',async()=>{
  const f=await fixture();expect(matchesReviewedProjection(f.source,f.before,f.after,f.review)).toBe(true);
  const oldStages=f.connection.prepare('SELECT run_id,input_json,output_json FROM practice_material_stages ORDER BY run_id').all();
  const oldRuns=f.connection.prepare('SELECT * FROM ai_runs ORDER BY run_id').all(),oldReceipts=f.connection.prepare('SELECT * FROM runtime_requests ORDER BY run_id').all(),calls=f.requests.length;
  const proof=await f.readProof();expect(proof?.analysis.gapCount).toBe(1);expect(proof?.stageRunIds).toHaveLength(4);expect(f.requests).toHaveLength(calls);
  const published=await f.materials.process(f.material.id,{retry:true});expect(published.status).toBe('ready');expect(f.requests).toHaveLength(calls);
  expect(JSON.parse(published.analysis_json).learningMaterials[0].learningBasis).toBe('preparation');expect(await f.materials.inspect(f.material.id)).toMatchObject({verified:true,audit:{ok:true,checked:1,issues:[]}});
  expect(f.connection.prepare('SELECT run_id,input_json,output_json FROM practice_material_stages ORDER BY run_id').all()).toEqual(oldStages);
  expect(f.connection.prepare('SELECT * FROM ai_runs ORDER BY run_id').all()).toEqual(oldRuns);expect(f.connection.prepare('SELECT * FROM runtime_requests ORDER BY run_id').all()).toEqual(oldReceipts);
  const row=f.connection.prepare('SELECT output_json FROM practice_material_stages WHERE run_id=?').get(f.reviewRunId) as {output_json:string};expect(JSON.parse(row.output_json).rows[0]).toMatchObject({approved:true,repairNeeded:false,minimalRepair:false});
});
it('projection comparison rejects teaching text, target or explanation drift beyond the one derived downgrade',async()=>{
  const f=await fixture();
  for(const kind of ['text','target','reason','other_basis'] as const){const changed=structuredClone(f.after);
    if(kind==='text')changed.naturalVersion='Different unreviewed answer.';
    if(kind==='target')changed.learningMaterials[0].englishChunk='in another case';
    if(kind==='reason')changed.gaps[0].explanationZh='Different unreviewed reason.';
    if(kind==='other_basis')changed.learningMaterials[1].learningBasis='preparation';
    expect(matchesReviewedProjection(f.source,f.before,changed,f.review)).toBe(false);
  }
});
it.each(['negative_latest','orphan_negative_latest','cache_mismatch','source_mismatch'] as const)('cached approval cannot hide a newer refusal or mismatched source/receipt (%s)',async kind=>{
  const f=await fixture();
  if(kind==='negative_latest'||kind==='orphan_negative_latest'){
    const negative={...f.review,approved:false,reasonZh:'最新独立审核明确拒绝。'},prompt=materialStageContracts(f.source).review.prompt;
    const run=await createRuntimeCalls(f.database,new MockAiProvider(()=>negative),{...f.platform,bootId:'negative-review'}).call({role:'reviewer',instructions:await f.platform.loadPrompt(prompt),input:f.reviewInput,schema:recallEvidenceReviewSchema,schemaName:'four_step_review_v5',promptVersion:prompt,schemaVersion:'v5',idempotencyKey:'new-negative'});
    f.connection.prepare("INSERT INTO practice_material_stages(run_id,material_id,stage,prompt_version,input_hash,input_json,output_json,status,created_at) VALUES(?,?,'review',?,?,?,?,'rejected','2026-09-12T00:00:00Z')").run(run.runId,f.material.id,prompt,hash(prompt,f.reviewInput),f.reviewInput,JSON.stringify(negative));
    if(kind==='orphan_negative_latest')f.connection.prepare('DELETE FROM ai_runs WHERE run_id=?').run(run.runId);
  }
  if(kind==='cache_mismatch'){
    const r=f.connection.prepare('SELECT response_json FROM runtime_requests WHERE run_id=?').get(f.reviewRunId) as {response_json:string},changed=JSON.parse(r.response_json);changed.data.reasonZh='Not the stored review';
    f.connection.prepare('UPDATE runtime_requests SET response_json=? WHERE run_id=?').run(JSON.stringify(changed),f.reviewRunId);
  }
  if(kind==='source_mismatch'){
    const input=f.connection.prepare('SELECT input_json FROM practice_material_stages WHERE run_id=?').get(f.draftRunId) as {input_json:string},changed=JSON.parse(input.input_json);changed.source.actualAnswer='Other source';
    f.connection.prepare('UPDATE practice_material_stages SET input_json=? WHERE run_id=?').run(JSON.stringify(changed),f.draftRunId);
  }
  expect(await f.readProof()).toBeNull();expect(f.connection.prepare('SELECT * FROM practice_material_items').all()).toHaveLength(0);
});
