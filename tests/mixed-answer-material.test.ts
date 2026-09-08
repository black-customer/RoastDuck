import {afterEach,describe,it,expect} from 'vitest';
import fs from 'node:fs';
import {portableTestDatabase} from './helpers/portable-db';
import {createAnswerService} from '@/lib/app-services/answers';
import {createMaterialService} from '@/lib/four-step/core-materials';
import {createRuntimeCalls} from '@/lib/ai/runtime-ledger';
import {MockAiProvider} from '@/lib/ai/mock-provider';
import {selectionMockResolver} from '@/lib/four-step/selection-mock';
import {compileEvidence,validateSelection,type MaterialEvidence} from '@/lib/four-step/selection-contracts';
import {validateMaterial} from '@/lib/four-step/material-validation';
import {speakingAttemptAnalysisSchema} from '@/lib/speaking-practice/schemas';
import {query as sql} from '@/lib/platform/sql';
const opened:ReturnType<typeof portableTestDatabase>[]=[];
afterEach(()=>{for(const f of opened)f.close();opened.length=0;});
async function setup(){
  const f=portableTestDatabase();opened.push(f);let seq=0;
  const clock={now:()=>new Date('2026-09-08T08:00:00Z'),newId:()=>`mixed-${++seq}`,bootId:'test'};
  const materials=createMaterialService({database:f.database,runtime:createRuntimeCalls(f.database,new MockAiProvider(selectionMockResolver),clock),...clock,allowMock:true,loadPrompt:name=>fs.readFileSync(`pipeline/prompts/${name}`,'utf8')});
  const answers=createAnswerService(f.database,materials,{...clock,allowMock:true});
  await f.database.write(tx=>tx.run(sql`INSERT INTO questions(id,book_id,part,text,text_zh,norm_text) VALUES('q-mixed','retired',1,'What do you make at home?','你在家做什么？','q-mixed')`));
  return {...f,materials,answers};
}
describe('mixed raw answer + coverage contract',()=>{
  it('Chinese-only raw input saves before AI, repeats are idempotent and preparation is not an error',async()=>{
    const f=await setup(),draft=await f.answers.start('q-mixed','first');
    const saved=await f.answers.saveDraft(draft.id,{version:draft.version,inputText:'我每天在家准备午饭。'});
    expect(saved.raw_input).toBe('我每天在家准备午饭。');
    expect((await f.answers.saveDraft(draft.id,{version:0,inputText:saved.raw_input})).version).toBe(saved.version);
    const result=await f.answers.submit(draft.id,saved.version);
    expect(await f.answers.submit(draft.id,saved.version)).toEqual(result);
    const detail=await f.answers.detail(result.attemptId);
    expect(detail.attempt.answer_text).toBe(saved.raw_input);
    const finished=await f.materials.process(detail.material!.id);
    expect(finished.status).toBe('ready');
    const analysis=JSON.parse(finished.analysis_json);
    expect(analysis.gapCount).toBe(0);expect(analysis.learningTargetCount).toBe(1);
    expect(analysis.learningMaterials[0].learningBasis).toBe('preparation');
    expect((await f.answers.detail(result.attemptId)).learnable).toBe(true);
  });
  it('independent reanswer cannot use mixed input or bypass English sealing',async()=>{
    const f=await setup(),old=await f.answers.start('q-mixed','original');
    const saved=await f.answers.saveDraft(old.id,{version:0,inputText:'我每天在家准备午饭。'}),submitted=await f.answers.submit(old.id,saved.version);
    const draft=await f.answers.start('q-mixed','independent',submitted.attemptId,'independent');
    await expect(f.answers.saveDraft(draft.id,{version:0,inputText:'先给我中文提示'})).rejects.toMatchObject({code:'english_first'});
  });
  it('clear unproven intention cannot be silently excluded as natural',()=>{
    const source={actualAnswer:'',intendedMeaningZh:'准备午饭',spokenStyleVersion:'personal-spoken-v1' as const};
    const evidence:MaterialEvidence={diagnosis:{units:[{id:'u',intentZh:'准备午饭',english:[],chinese:[{text:'准备午饭',occurrence:0}],status:'missing',reasonZh:'未展示',gaps:[]}]},selection:{approved:true,reasonZh:'测试',units:[{unitId:'u',status:'natural',evidenceQuote:'准备午饭',reasonZh:'可能会'}],gaps:[]},draft:{sentences:[],rows:[],examFeedback:null}};
    expect(()=>validateSelection(evidence.diagnosis,evidence.selection,source)).toThrow('没有英文表达成功证据');
    evidence.selection.units[0].status='missing';
    expect(()=>validateSelection(evidence.diagnosis,evidence.selection,source)).toThrow('必须有学习目标');
    evidence.selection.units[0].status='repair';
    expect(()=>validateSelection(evidence.diagnosis,evidence.selection,source)).toThrow('没有英文尝试证据');
  });
  it('mixed raw coverage cannot omit instruction or uncertainty fragments',()=>{
    const source={actualAnswer:'准备午饭，然后解释一下',intendedMeaningZh:'',rawInput:'准备午饭，然后解释一下',inputFormat:'mixed-v1' as const,spokenStyleVersion:'personal-spoken-v1' as const};
    const evidence:MaterialEvidence={diagnosis:{units:[{id:'u',intentZh:'准备午饭',english:[],chinese:[],raw:[{text:'准备午饭',occurrence:0}],status:'missing',reasonZh:'未展示',gaps:[]}]},selection:{approved:true,reasonZh:'测试',units:[],gaps:[]},draft:{sentences:[],rows:[],examFeedback:null}};
    expect(()=>compileEvidence(source,evidence)).toThrow('部分原文没有诊断归属');
  });
  it('legacy fields cannot inject an unvalidated raw quote',()=>{
    const source={actualAnswer:'I goes home.',intendedMeaningZh:'',spokenStyleVersion:'personal-spoken-v1' as const};
    const evidence:MaterialEvidence={diagnosis:{units:[{id:'u',intentZh:'我回家',english:[{text:source.actualAnswer,occurrence:0}],chinese:[],raw:[{text:'Fabricated evidence.',occurrence:0}],status:'repair',reasonZh:'测试',gaps:[]}]},selection:{approved:true,reasonZh:'测试',units:[],gaps:[]},draft:{sentences:[],rows:[],examFeedback:null}};
    expect(()=>compileEvidence(source,evidence)).toThrow('未绑定来源');
  });
  it('compiler separates two senses with identical English',()=>{
    const source={actualAnswer:'',intendedMeaningZh:'飞机起飞。脱掉外套。',spokenStyleVersion:'personal-spoken-v1' as const};
    const meanings=['飞机起飞。','脱掉外套。'],senses=['aircraft-departure','remove-clothes'];
    const units=meanings.map((text,i)=>({id:`u${i}`,intentZh:text,english:[],chinese:[{text,occurrence:0}],status:'missing' as const,reasonZh:'准备',gaps:[{id:`g${i}`,kind:'unexpressed_intention' as const,cueZh:text,targetEnglish:'take off',acceptableVariants:[],senseKey:senses[i],evidenceQuote:text,whyNeededZh:'准备项'}]}));
    const evidence:MaterialEvidence={diagnosis:{units},selection:{approved:true,reasonZh:'独立测试',units:units.map(u=>({unitId:u.id,status:u.status,evidenceQuote:u.intentZh,reasonZh:'准备'})),gaps:units.map((u,i)=>({gapId:`g${i}`,decision:'train',evidenceQuote:u.intentZh,reasonZh:'不同意思'}))},draft:{sentences:[{id:'s0',intentUnitIds:['u0'],english:'The plane will take off soon.'},{id:'s1',intentUnitIds:['u1'],english:'I will take off my coat.'}],rows:[{gapId:'g0',sentenceId:'s0',surfaceInSentence:'take off'},{gapId:'g1',sentenceId:'s1',surfaceInSentence:'take off'}],examFeedback:null}};
    const analysis=speakingAttemptAnalysisSchema.parse(compileEvidence(source,evidence));
    expect(analysis.learningItems[0].canonicalKey).not.toBe(analysis.learningItems[1].canonicalKey);
    expect(()=>validateMaterial(analysis,{...source,sourceType:'ielts_practice',sourceId:'test',question:null,mode:'practice'})).not.toThrow();
  });
});
