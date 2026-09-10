import {describe,it,expect,afterEach,vi} from 'vitest';
import fs from 'node:fs';
import {materialStageContracts,STAGE_CONTRACTS,SPOKEN_STAGE_CONTRACTS,RECALL_STAGE_CONTRACTS} from '@/lib/four-step/stage-contracts';
import {compileEvidence,validateDiagnosis,validateSelection,validateEvidenceReview,spokenEvidenceReviewSchema,type MaterialEvidence,recallEvidenceReviewSchema,type Diagnosis,type SelectionReview,type MaterialDraft} from '@/lib/four-step/selection-contracts';
import type {RecoverySource} from '@/lib/four-step/offline-contracts';
import {compileOfflineMaterial} from '@/lib/four-step/offline-compile';
import {recallFixture} from './helpers/recall-material';
import {portableTestDatabase} from './helpers/portable-db';
import {createMaterialService} from '@/lib/four-step/core-materials';
import {createRuntimeCalls} from '@/lib/ai/runtime-ledger';
import {MockAiProvider} from '@/lib/ai/mock-provider';
import {selectionMockResolver} from '@/lib/four-step/selection-mock';
import {query as sql} from '@/lib/platform/sql';

const english='I am used to live alone.',chinese='我已经习惯一个人住了。';
const source:RecoverySource={key:'fixture',kind:'attempt',createdAt:'2026-09-01',questionId:'q',questionEn:'Where do you live?',questionZh:'你住在哪？',part:1,english,chinese,mode:'practice',index:0,hash:'fixture-hash',spokenStyleVersion:'personal-spoken-v2',en:[{index:0,start:0,end:english.length,text:english}],zh:[{index:0,start:0,end:chinese.length,text:chinese}]};
const context={actualAnswer:english,intendedMeaningZh:chinese,spokenStyleVersion:'personal-spoken-v2' as const};
afterEach(()=>vi.restoreAllMocks());

describe('personal-spoken-v2 concrete recall and every-sentence review',()=>{
  it('bilingual FreeTalk fixture retains natural English and prepares the additional Chinese intent',async()=>{
    const source={sourceType:'free_talk',actualAnswer:'I want to change the date of my test. 我最近准备得不够充分，想把考试推迟两周。',intendedMeaningZh:'',spokenStyleVersion:'personal-spoken-v2' as const};
    const mock=async(name:string,input:unknown)=>selectionMockResolver({schemaName:`four_step_${name}_v4`,input:JSON.stringify(input)} as Parameters<typeof selectionMockResolver>[0]);
    const diagnosis=await mock('diagnosis',{source}) as Diagnosis;validateDiagnosis(source,diagnosis);
    const selection=await mock('selection',{source,diagnosis}) as SelectionReview;validateSelection(diagnosis,selection,source);
    const draft=await mock('material',{source,diagnosis,selection}) as MaterialDraft;
    const compiled=compileEvidence(source,{diagnosis,selection,draft});
    const review=recallEvidenceReviewSchema.parse(await mock('review',{source,compiled}));
    expect(()=>validateEvidenceReview({diagnosis,selection,draft},review,source)).not.toThrow();
    expect(compiled.naturalVersion).toContain('I want to change the date of my test.');
    expect(compiled.learningMaterials[0].learningBasis).toBe('preparation');
    expect(compiled.gapCount).toBe(0);
  });
  it('every effective contract contains four separately declared roles and existing versioned prompts',()=>{
    for(const contract of [STAGE_CONTRACTS,SPOKEN_STAGE_CONTRACTS,RECALL_STAGE_CONTRACTS]){
      expect(Object.keys(contract).sort()).toEqual(['diagnosis','material','review','selection']);
      for(const stage of Object.values(contract)){expect(stage.prompt).toMatch(/\.v\d+\.md$/);expect(fs.existsSync(`pipeline/prompts/${stage.prompt}`)).toBe(true);}
      expect(contract.material.role).not.toBe(contract.review.role);
      expect(contract.diagnosis.role).not.toBe(contract.selection.role);
    }
  });
  it('routes legacy snapshots explicitly and adds display fields without changing canonical target',()=>{
    expect(materialStageContracts({})).toBe(STAGE_CONTRACTS);
    expect(materialStageContracts({spokenStyleVersion:'personal-spoken-v1'})).toBe(SPOKEN_STAGE_CONTRACTS);
    expect(materialStageContracts(context)).toBe(RECALL_STAGE_CONTRACTS);
    const f=recallFixture(source),result=compileOfflineMaterial(source,f.author,f.review);
    expect(result.analysis.learningMaterials[0]).toMatchObject({englishChunk:'be used to doing',recallPromptZh:chinese,recallAnswerEn:'I am used to living alone.',pattern:'be used to + noun / -ing'});
    expect(result.analysis.learningItems[0].targetEnglish).toBe('be used to doing');
    const oldSource={...source,spokenStyleVersion:'personal-spoken-v1' as const},old=recallFixture(oldSource);
    expect(compileOfflineMaterial(oldSource,old.author,{...old.review,review:spokenEvidenceReviewSchema.parse(old.review.review)}).analysis.learningMaterials[0]).not.toHaveProperty('recallAnswerEn');
  });
  it('rejects missing, abstract or unrelated recall answers',()=>{
    const f=recallFixture(source);
    const missing=structuredClone(f.evidence);delete missing.draft.rows[0].recallPromptZh;
    expect(()=>compileEvidence(context,missing)).toThrow();
    for(const answer of ['be used to doing','I am used to ...','I enjoy cooking.']){
      const bad=structuredClone(f.evidence);bad.draft.rows[0].recallAnswerEn=answer;
      expect(()=>compileEvidence(context,bad)).toThrow('具体英文');
    }
  });
  it.each(['meaningPreserved','naturalEnglish','grammarCorrect','sourceUncertaintyHandled'] as const)('refuses sentence approval when %s fails',flag=>{
    const f=recallFixture(source);f.review.review.sentences[0][flag]=false;
    expect(()=>validateEvidenceReview(f.evidence,f.review.review,context)).toThrow('当前句子');
  });
  it('requires exact sentence and linked source evidence, not only a whole-answer approval',()=>{
    const f=recallFixture(source),missing={...f.review.review,sentences:[]};
    expect(()=>validateEvidenceReview(f.evidence,missing,context)).toThrow('逐句审核');
    f.review.review.sentences[0].sentenceQuote='An earlier version.';
    expect(()=>validateEvidenceReview(f.evidence,f.review.review,context)).toThrow('当前句子');
    f.review.review.sentences[0].sentenceQuote='I am used to living alone.';
    f.review.review.sentences[0].evidence[0].sourceQuote='fabricated source';
    expect(()=>validateEvidenceReview(f.evidence,f.review.review,context)).toThrow('真实来源');
  });
  it('requires sentence review even when zero gaps are selected',()=>{
    const f=recallFixture(source),natural='I enjoy cooking.';
    const evidence:MaterialEvidence={diagnosis:{units:[{id:'u0',intentZh:'我喜欢做饭。',english:[{text:natural,occurrence:0}],chinese:[],status:'natural',reasonZh:'表达自然',gaps:[]}]},selection:{approved:true,reasonZh:'独立确认自然',units:[{unitId:'u0',status:'natural',evidenceQuote:natural,reasonZh:'自然准确'}],gaps:[]},draft:{sentences:[{id:'s0',intentUnitIds:['u0'],english:natural}],rows:[],examFeedback:null}};
    const review=recallEvidenceReviewSchema.parse({...f.review.review,rows:[],sentences:[],wholeAnswer:{...f.review.review.wholeAnswer,evidence:[{sourceField:'actualAnswer',sourceQuote:natural,rendering:natural,treatment:'retained',reasonZh:'保留自然原话'}]}});
    expect(()=>validateEvidenceReview(evidence,review,{...context,actualAnswer:natural,intendedMeaningZh:''})).toThrow('逐句审核');
    review.sentences=[{sentenceId:'s0',sentenceQuote:natural,meaningPreserved:true,naturalEnglish:true,grammarCorrect:true,sourceUncertaintyHandled:true,reasonZh:'已核对零目标句子的语法与原意',evidence:[{sourceField:'actualAnswer',sourceQuote:natural}]}];
    expect(()=>validateEvidenceReview(evidence,review,{...context,actualAnswer:natural,intendedMeaningZh:''})).not.toThrow();
  });
  it('runs four separate Mock requests with v4 material/review and verifies publication',async()=>{
    const f=portableTestDatabase(),network=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('No network permitted'));
    try{
      let sequence=0;const clock={now:()=>new Date('2026-09-08T10:00:00Z'),newId:()=>`recall-${++sequence}`,bootId:'test'};
      const service=createMaterialService({...clock,database:f.database,runtime:createRuntimeCalls(f.database,new MockAiProvider(selectionMockResolver),clock),allowMock:true,loadPrompt:name=>fs.readFileSync(`pipeline/prompts/${name}`,'utf8')});
      await f.database.write(async tx=>{await tx.run(sql`INSERT INTO questions(id,book_id,part,text,text_zh,norm_text) VALUES('q','retired',1,'Where do you live?','你住在哪？','q')`);await tx.run(sql`INSERT INTO speaking_question_attempts(id,question_id,mode,answer_text,intended_meaning_zh,status) VALUES('fixture','q','practice',${english},${chinese},'pending')`);});
      const material=await service.prepare({...context,sourceType:'ielts_practice',sourceId:'fixture',question:{id:'q',textEn:'Where do you live?',textZh:'你住在哪？',part:1},mode:'practice'});
      expect((await service.process(material.id)).status).toBe('ready');
      expect((await service.inspect(material.id)).verified).toBe(true);
      const stages=await f.database.read(tx=>tx.all<{run_id:string;prompt_version:string}>(sql`SELECT run_id,prompt_version FROM practice_material_stages WHERE material_id=${material.id}`));
      expect(new Set(stages.map(row=>row.run_id)).size).toBe(4);
      expect(stages.map(row=>row.prompt_version)).toContain('four_step_material.reviewer.v4.md');
      expect(network).not.toHaveBeenCalled();
    }finally{f.close();}
  });
});
