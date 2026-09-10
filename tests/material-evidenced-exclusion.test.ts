import {afterEach,expect,it,vi} from 'vitest';
import fs from 'node:fs';
import {compileEvidence,validateSelection,selectionSchemaForSource,evidencedSelectionReviewSchema,selectionReviewSchema,type Diagnosis,type SelectionReview,type MaterialEvidence} from '@/lib/four-step/selection-contracts';
import {materialStageContracts,RECALL_STAGE_CONTRACTS,EVIDENCED_STAGE_CONTRACTS} from '@/lib/four-step/stage-contracts';
import {portableTestDatabase} from './helpers/portable-db';
import {createRuntimeCalls} from '@/lib/ai/runtime-ledger';
import {MockAiProvider} from '@/lib/ai/mock-provider';
import {createMaterialService} from '@/lib/four-step/core-materials';
import {query as sql} from '@/lib/platform/sql';

const english='Actually, I, I live in a city.';
const source={actualAnswer:english,intendedMeaningZh:'',spokenStyleVersion:'personal-spoken-v2' as const,selectionPolicyVersion:'evidence-exclusion-v1' as const};
const open:ReturnType<typeof portableTestDatabase>[]=[];
afterEach(()=>{vi.restoreAllMocks();for(const item of open)item.close();open.length=0;});
function fixture(){
  const diagnosis:Diagnosis={units:[{id:'u0',intentZh:'我住在一个城市。',english:[{text:english,occurrence:0}],chinese:[],status:'repair',reasonZh:'仅清理重复起句；已有完整表达。',gaps:[]}]};
  const selection:SelectionReview={approved:true,reasonZh:'独立审核只允许必要文本整理。',units:[{unitId:'u0',status:'repair',evidenceQuote:english,reasonZh:'原句已展示完整居住意思，重启不独立制卡。',noTrainingNeeded:{kind:'editorial_only',evidenceQuote:'I live in a city.',reasonZh:'完整成功表达在同一来源内，无新意思或确认语言错误。',noConfirmedLanguageError:true,noUnexpressedIntention:true}}],gaps:[]};
  const evidence:MaterialEvidence={diagnosis,selection,draft:{sentences:[{id:'s0',intentUnitIds:['u0'],english:'Actually, I live in a city.'}],rows:[],examFeedback:null}};
  return evidence;
}
it('explicitly versioned evidence permits editorial cleanup without inventing a learning item',()=>{
  const result=compileEvidence(source,fixture());
  expect(result.learningMaterials).toEqual([]);expect(result.gapCount).toBe(0);
  expect(result.naturalVersion).toBe('Actually, I live in a city.');
});
it('older snapshots keep their previous schema, prompt and no-target gate',()=>{
  const previous={...source,selectionPolicyVersion:undefined};
  expect(selectionSchemaForSource(previous)).toBe(selectionReviewSchema);
  expect(selectionSchemaForSource(source)).toBe(evidencedSelectionReviewSchema);
  expect(materialStageContracts(previous)).toBe(RECALL_STAGE_CONTRACTS);
  expect(materialStageContracts(source)).toBe(EVIDENCED_STAGE_CONTRACTS);
  expect(()=>compileEvidence(previous,fixture())).toThrow();
  const missing=fixture();delete missing.selection.units[0].noTrainingNeeded;
  expect(()=>compileEvidence(source,missing)).toThrow('学习目标');
});
it('the exception cannot bypass missing English intentions or use another unit as evidence',()=>{
  const missing=fixture();missing.diagnosis.units[0].status='missing';
  expect(()=>validateSelection(missing.diagnosis,missing.selection,source)).toThrow('零训练裁决');
  const unrelated=fixture();unrelated.selection.units[0].noTrainingNeeded!.evidenceQuote='I can speak English.';
  expect(()=>validateSelection(unrelated.diagnosis,unrelated.selection,source)).toThrow('零训练裁决');
  const chinese=fixture();chinese.selection.units[0].noTrainingNeeded!.evidenceQuote='我住在这里';
  expect(()=>validateSelection(chinese.diagnosis,chinese.selection,source)).toThrow('零训练裁决');
});
it('confirmed errors, conflicting train decisions and undecided targets cannot be waived',()=>{
  const failed=fixture();Reflect.set(failed.selection.units[0].noTrainingNeeded!,'noConfirmedLanguageError',false);
  expect(evidencedSelectionReviewSchema.safeParse(failed.selection).success).toBe(false);
  expect(()=>validateSelection(failed.diagnosis,failed.selection,source)).toThrow();
  for(const decision of ['train','uncertain'] as const){
    const withGap=fixture();withGap.diagnosis.units[0].gaps=[{id:'g0',kind:'grammar_gap',cueZh:'住在城市',targetEnglish:'live in a city',acceptableVariants:[],senseKey:'live_in_city',evidenceQuote:english,whyNeededZh:'测试冲突裁决'}];
    withGap.selection.gaps=[{gapId:'g0',decision,evidenceQuote:english,reasonZh:'测试冲突裁决'}];
    expect(()=>validateSelection(withGap.diagnosis,withGap.selection,source)).toThrow('零训练裁决');
  }
});
it('the new runtime policy performs four independent stages and publishes a verified zero-item result',async()=>{
  const f=portableTestDatabase();open.push(f);let sequence=0;
  const evidence=fixture();
  const runtime=createRuntimeCalls(f.database,new MockAiProvider(request=>{
    if(request.schemaName==='four_step_diagnosis_v4')return evidence.diagnosis;
    if(request.schemaName==='four_step_selection_v4')return evidence.selection;
    if(request.schemaName==='four_step_material_v4')return evidence.draft;
    if(request.schemaName==='four_step_review_v4')return {approved:true,reasonZh:'独立合成审核确认仅为重启整理。',rows:[],sentences:[{sentenceId:'s0',sentenceQuote:'Actually, I live in a city.',meaningPreserved:true,naturalEnglish:true,grammarCorrect:true,sourceUncertaintyHandled:true,reasonZh:'保留居住城市原意并只去掉重复开头。',evidence:[{sourceField:'actualAnswer',sourceQuote:english}]}],wholeAnswer:{meaningPreserved:true,voicePreserved:true,stancePreserved:true,discourseFunctionsPreserved:true,metaphorsPreserved:true,spokenNaturalness:true,noInventedPersonalStyle:true,reasonZh:'未添加事实或训练目标。',evidence:[{sourceField:'actualAnswer',sourceQuote:english,rendering:'Actually, I live in a city.',treatment:'condensed',reasonZh:'只清理口语重启。'}]}};
    throw new Error('unexpected stage');
  }),{now:()=>new Date('2026-09-09T00:00:00Z'),newId:()=>`editorial-${++sequence}`,bootId:'editorial-test'});
  const service=createMaterialService({database:f.database,runtime,now:()=>new Date('2026-09-09T00:00:00Z'),newId:()=>`service-${++sequence}`,bootId:'editorial-test',allowMock:true,loadPrompt:name=>fs.readFileSync(`pipeline/prompts/${name}`,'utf8')});
  await f.database.write(async tx=>{await tx.run(sql`INSERT INTO questions(id,book_id,part,text,text_zh,norm_text) VALUES('q-editorial','retired',1,'Where do you live?','你住在哪里？','q-editorial')`);await tx.run(sql`INSERT INTO speaking_question_attempts(id,question_id,mode,answer_text,intended_meaning_zh,status) VALUES('attempt-editorial','q-editorial','practice',${english},'','pending')`);});
  const material=await service.prepare({...source,sourceType:'ielts_practice',sourceId:'attempt-editorial',question:{id:'q-editorial',textEn:'Where do you live?',textZh:'你住在哪里？',part:1},mode:'practice'});
  expect((await service.process(material.id)).status).toBe('ready');
  expect(await service.inspect(material.id)).toMatchObject({verified:true,analysis:{gapCount:0,learningMaterials:[]}});
  expect(await f.database.read(tx=>tx.all(sql`SELECT * FROM learning_items`))).toHaveLength(0);
  const stages=await f.database.read(tx=>tx.all<{stage:string;prompt_version:string;schema_version:string}>(sql`SELECT s.stage,s.prompt_version,a.schema_version FROM practice_material_stages s JOIN ai_runs a ON a.run_id=s.run_id WHERE s.material_id=${material.id}`));
  expect(stages).toHaveLength(4);expect(stages.find(stage=>stage.stage==='selection')).toMatchObject({prompt_version:'answer_gap_diagnosis.reviewer.v4.md',schema_version:'four-step-selection-v4-evidence-exclusion-v1'});
});
