import {afterEach,expect,it} from "vitest";
import fs from "node:fs";
import path from "node:path";
import {portableTestDatabase} from "./helpers/portable-db";
import {MockAiProvider} from "@/lib/ai/mock-provider";
import {selectionMockResolver} from "@/lib/four-step/selection-mock";
import {createRuntimeCalls} from "@/lib/ai/runtime-ledger";
import {createMaterialService} from "@/lib/four-step/core-materials";
import {createAnswerService} from "@/lib/app-services/answers";
import {createLightService} from "@/lib/light-study/core-service";
import {createQuestionService} from "@/lib/app-services/queries";
const opened:Array<ReturnType<typeof portableTestDatabase>>=[];
afterEach(()=>{for(const fixture of opened.splice(0))fixture.close();});
function setup(resolver=selectionMockResolver){
  const fixture=portableTestDatabase();opened.push(fixture);const {database,connection}=fixture;let seq=0;
  connection.exec("INSERT INTO questions(id,book_id,part,text,text_zh,norm_text) VALUES('q','removed',1,'Do you live alone?','你一个人住吗？','q')");
  const clock={now:()=>new Date("2026-09-07T12:00:00Z"),newId:()=>`app-${++seq}`,bootId:"app-test"};
  const runtime=createRuntimeCalls(database,new MockAiProvider(resolver),clock);
  const materials=createMaterialService({database,runtime,...clock,allowMock:true,loadPrompt:name=>fs.readFileSync(path.join("pipeline/prompts",name),"utf8")});
  return {database,connection,clock,materials,answers:createAnswerService(database,materials,{...clock,allowMock:true}),questions:createQuestionService(database)};
}
it("English/Chinese draft → independent material pipeline → click-only learning without books or duplicated answers",async()=>{
  const {database,connection,clock,materials,answers,questions}=setup();
  expect((await questions.list()).total).toBe(1);await questions.get("q");
  expect(connection.prepare("SELECT * FROM speaking_question_attempts").all()).toHaveLength(0);
  let draft=await answers.start("q","tap-start");expect((await answers.start("q","tap-start")).id).toBe(draft.id);
  draft=await answers.saveDraft(draft.id,{version:draft.version,english:"I'm used to live alone.",chinese:"我已经习惯一个人住了。",englishUnknown:false});
  const saved=await answers.submit(draft.id,draft.version);expect(await answers.submit(draft.id,draft.version)).toEqual(saved);
  const pending=await answers.detail(saved.attemptId);expect(pending.learnable).toBe(false);expect(pending.material?.status).toBe("queued");
  expect((await materials.process(pending.material!.id)).status).toBe("ready");
  const detail=await answers.detail(saved.attemptId);expect(detail.audit?.ok).toBe(true);expect(detail.learnable).toBe(true);
  expect(detail.analysis?.evidence?.draft.sentences[0].teaching?.version).toBe('sentence-teaching-v1');
  expect(connection.prepare("SELECT * FROM ai_runs").all()).toHaveLength(4);
  expect(connection.prepare("SELECT * FROM speaking_question_attempts").all()).toHaveLength(1);
  const light=createLightService(database,{...clock,enabled:()=>true,allowMock:true});
  let view=await light.createLightSession({scope:{type:"material",id:detail.material!.id},mode:"learn",clientRequestId:"light"});
  expect(view.revealed).toBe(false);view=await light.applyLightEvent(view.id,{type:"reveal",version:view.version,clientEventId:"show"});
  expect((await light.applyLightEvent(view.id,{type:"rate",rating:"forgot",version:view.version,clientEventId:"rate"})).status).toBe("completed");
  expect(connection.prepare("SELECT * FROM ai_runs").all()).toHaveLength(4);
  await materials.process(pending.material!.id);expect(connection.prepare("SELECT * FROM ai_runs").all()).toHaveLength(4);
});
it("explicitly unknown English preserves an empty attempt and derives selected gaps only from Chinese evidence",async()=>{
  const {answers,materials}=setup();let draft=await answers.start("q","unknown");
  draft=await answers.saveDraft(draft.id,{version:0,english:"",chinese:"我今年大四，在青岛学计算机，之前从化学转了专业。",englishUnknown:true});
  const {attemptId}=await answers.submit(draft.id,draft.version),pending=await answers.detail(attemptId);
  expect(pending.attempt.answer_text).toBe("");
  await materials.process(pending.material!.id);const result=await answers.detail(attemptId);
  expect(result.audit?.ok).toBe(true);expect(result.analysis?.learningMaterials).toHaveLength(2);
  expect(result.analysis?.corrections).toHaveLength(0);
});
it("draft responses lost after save are idempotent; stale different text cannot overwrite or edit a submitted answer",async()=>{
  const {answers}=setup();const draft=await answers.start("q","draft");
  const input={version:0,english:"I live alone.",chinese:"我一个人住。",englishUnknown:false};
  const first=await answers.saveDraft(draft.id,input);expect(await answers.saveDraft(draft.id,input)).toEqual(first);
  await expect(answers.saveDraft(draft.id,{...input,english:"Overwrite"})).rejects.toMatchObject({code:"draft_version_conflict"});
  await answers.submit(draft.id,first.version);
  await expect(answers.saveDraft(draft.id,{...input,version:first.version})).rejects.toMatchObject({code:"draft_submitted"});
});
it('independent English is sealed before optional Chinese; old facts are not copied and editing creates a separate version',async()=>{
  const {answers}=setup();let first=await answers.start('q','first');first=await answers.saveDraft(first.id,{version:0,english:'I live alone.',chinese:'我一个人住。',englishUnknown:false});const source=await answers.submit(first.id,first.version);
  let retry=await answers.start('q','retry',source.attemptId,'independent');expect(retry.chinese_text).toBe('');
  await expect(answers.saveDraft(retry.id,{version:0,english:'I now share a flat.',chinese:'新观点',englishUnknown:false})).rejects.toMatchObject({code:'english_first'});
  retry=await answers.saveDraft(retry.id,{version:0,english:'I now share a flat.',chinese:'',englishUnknown:false});retry=await answers.commitEnglish(retry.id,retry.version);
  await expect(answers.saveDraft(retry.id,{version:retry.version,english:'Changed',chinese:'',englishUnknown:false})).rejects.toMatchObject({code:'english_committed'});
  const saved=await answers.submit(retry.id,retry.version),detail=await answers.detail(saved.attemptId);
  expect(detail.attempt.intended_meaning_zh).toBe('');expect(detail.previous?.answer_text).toBe('I live alone.');expect(detail.origin?.kind).toBe('independent');
  const edit=await answers.start('q','edit',source.attemptId,'edit');expect(edit.english_text).toBe('I live alone.');expect(edit.english_committed_at).toBeNull();
});

it.each(['negative','missing'])('does not publish when the independent teaching review is %s',async outcome=>{
  const {answers,materials,connection}=setup(request=>{
    const result=selectionMockResolver(request) as {teaching?:Array<{explanationsCorrect:boolean}>};
    if(request.schemaName==='four_step_review_v6'){if(outcome==='missing')delete result.teaching;else result.teaching![0].explanationsCorrect=false;}
    return result;
  });
  let draft=await answers.start('q',`bad-teaching-${outcome}`);draft=await answers.saveDraft(draft.id,{version:0,english:"I'm used to live alone.",chinese:'我已经习惯一个人住了。',englishUnknown:false});
  const saved=await answers.submit(draft.id,draft.version),pending=await answers.detail(saved.attemptId);
  expect((await materials.process(pending.material!.id)).status).not.toBe('ready');
  expect(connection.prepare('SELECT * FROM sentence_learning_units').all()).toHaveLength(0);
  expect((await answers.detail(saved.attemptId)).learnable).toBe(false);
});

it('legacy v5 material keeps its creation contract and does not require invented teaching',async()=>{
  const {materials,connection}=setup();const answer="I'm used to live alone.",meaning='我已经习惯一个人住了。';
  connection.prepare("INSERT INTO speaking_question_attempts(id,question_id,mode,answer_text,intended_meaning_zh,status) VALUES('legacy','q','practice',?,?,'processing')").run(answer,meaning);
  const material=await materials.prepare({sourceType:'ielts_practice',sourceId:'legacy',mode:'practice',actualAnswer:answer,intendedMeaningZh:meaning,question:{id:'q',textEn:'Do you live alone?',textZh:'你一个人住吗？',part:1},spokenStyleVersion:'personal-spoken-v2',selectionPolicyVersion:'evidence-exclusion-v1',sentenceStudyVersion:'sentence-material-v1',registerProfileVersion:'young-us-v1'});
  expect((await materials.process(material.id)).status).toBe('ready');
  expect(connection.prepare("SELECT prompt_version FROM ai_runs WHERE role='learning_material_compiler'").get()).toMatchObject({prompt_version:'sentence_material.generator.v2.md'});
});
