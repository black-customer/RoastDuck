import { beforeAll, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createClient } from "@libsql/client";
import { prepareTestDatabase } from "../helpers/temp-db";
import { authoredMaterialSchema, authorHash, type RecoverySource, type OfflineReview } from "@/lib/four-step/offline-contracts";
const temp=prepareTestDatabase("offline-practice");
process.env.ROASTDUCK_DB=temp.url;
process.env.ROASTDUCK_SKIP_DB_BACKUP="1";
process.env.AI_PROVIDER="mock";
let db:Awaited<ReturnType<typeof import("@db/client").getDbReady>>;
beforeAll(async()=>{db=await(await import("@db/client")).getDbReady();});
const en="I am used to live alone.",zh="我习惯一个人住。";
const source:RecoverySource={key:"historical-one",kind:"personal_answer",createdAt:"2026-01-02T10:00:00Z",questionId:"offline-q",questionEn:"Do you live alone?",questionZh:"独居吗？",part:1,english:en,chinese:"",mode:"practice",index:0,hash:"fixture-source",en:[{index:0,start:0,end:en.length,text:en}],zh:[]};
const author=authoredMaterialSchema.parse({index:0,sourceHash:source.hash,model:"synthetic test author",contextId:"test-author",units:[{en:[0],intent:zh,status:"repair",reason:"used to 后名词性形式",english:"I am used to living alone.",gaps:[{cue:"习惯一个人住",target:"be used to living alone",quote:"used to live alone",why:"be used to 后接动名词而非原形",surface:"used to living alone"}]}]});
const review:OfflineReview={authorHash:authorHash(author),model:"synthetic test reviewer",contextId:"test-reviewer",selection:{approved:true,reasonZh:"测试中审阅动名词构式",units:[{unitId:"u0",status:"repair",evidenceQuote:en,reasonZh:"有明确构式问题"}],gaps:[{gapId:"g0_0",decision:"train",evidenceQuote:"used to live alone",reasonZh:"习惯用法需要动名词"}]},review:{approved:true,reasonZh:"测试修复保留独居原意",rows:[{gapId:"g0_0",approved:true,evidenceQuote:"used to live alone",reasonZh:"修复live为living，填空对应",repairNeeded:true,meaningPreserved:true,minimalRepair:true,cueUnambiguous:true,sentenceAligned:true,clozeValid:true}]}};

it("离线历史材料原子发布，不消耗API、不复制回答统计、不创建学习进度，可完成四步",async()=>{
  const schema=await import("@db/schema");
  await db.insert(schema.questions).values({id:source.questionId,bookId:"retired",part:1,text:source.questionEn,textZh:source.questionZh,normText:"offline-q"});
  await db.insert(schema.personalAnswers).values({id:source.key,questionId:source.questionId,inputLanguage:"en",rawText:en,status:"ready",createdAt:source.createdAt});
  const network=vi.spyOn(globalThis,"fetch").mockRejectedValue(new Error("测试禁止网络"));
  try{
    const {applyOfflineMaterial}=await import("@/lib/four-step/offline-apply");
    const published=await applyOfflineMaterial(source,author,review);
    expect((await applyOfflineMaterial(source,author,review)).alreadyApplied).toBe(true);
    expect(await db.all(sql`SELECT * FROM ai_runs`)).toHaveLength(0);
    expect(await db.all(sql`SELECT * FROM learning_item_schedule`)).toHaveLength(0);
    const {getQuestionActivity}=await import("@/lib/questions/activity");
    const state=await getQuestionActivity(source.questionId);
    expect(state).toMatchObject({totalAnswerCount:1,state:"learning_incomplete",latestAnswerType:"ielts_practice",currentMaterialId:published.id,currentUnitCount:1});
    const pack=await(await import("@/lib/questions/learning-pack-service")).getQuestionLearningPack(source.questionId);
    expect(pack?.summary).toMatchObject({answerCount:1,requiredTotal:1,requiredCompleted:0,gapCount:1});
    expect(pack?.currentPractice).toMatchObject({attemptId:published.attemptId,materialId:published.id,status:"ready",completed:false});
    expect(pack?.currentPractice?.rows[0].englishChunk).toBe("be used to living alone");
    expect(pack?.currentPractice?.ledger[0].evidence).toBe(en);
    const client=createClient({url:temp.url});
    try{expect(await(await import("@/lib/four-step/audit")).auditPracticeMaterials(client)).toMatchObject({ok:true,checked:1});}finally{client.close();}
    const training=await import("@/lib/four-step/training");
    let view=await training.createTraining(published.id);
    const steps=new Set<number>();
    while(view.status==="active"){
      steps.add(view.step);
      const [row]=await db.all<{state_json:string}>(sql`SELECT state_json FROM four_step_sessions WHERE id=${view.id}`);
      const task=JSON.parse(row.state_json).tasks[view.step-1][view.taskIndex];
      view=await training.applyTrainingEvent(view.id,{type:"submit",input:task.answer,stepVersion:view.stepVersion,clientEventId:`pass-${view.stepVersion}`});
      expect(view.passed).toBe(true);
      view=await training.applyTrainingEvent(view.id,{type:"continue",stepVersion:view.stepVersion,clientEventId:`next-${view.stepVersion}`});
    }
    expect([...steps]).toEqual([1,2,3,4]);
    expect((await getQuestionActivity(source.questionId))?.state).toBe("learning_completed");
    expect((await(await import("@/lib/questions/learning-pack-service")).getQuestionLearningPack(source.questionId))?.summary.requiredCompleted).toBe(1);
    expect((await db.all<{raw_text:string}>(sql`SELECT raw_text FROM personal_answers WHERE id=${source.key}`))[0].raw_text).toBe(en);
    expect(network).not.toHaveBeenCalled();
  }finally{network.mockRestore();}
});
it("相同上下文审核和修订后旧裁决不能发布",async()=>{
  const {compileOfflineMaterial}=await import("@/lib/four-step/offline-apply");
  expect(()=>compileOfflineMaterial(source,author,{...review,contextId:author.contextId})).toThrow("不独立");
  expect(()=>compileOfflineMaterial(source,{...author,contextId:"changed-author"},review)).toThrow("候选已变化");
});
it("来源变化拒绝适配，不创建虚假回答；审核哈希篡改会被发布审计发现",async()=>{
  const {applyOfflineMaterial}=await import("@/lib/four-step/offline-apply");
  await db.run(sql`UPDATE personal_answers SET raw_text='changed' WHERE id=${source.key}`);
  await expect(applyOfflineMaterial(source,author,review)).rejects.toMatchObject({code:"offline_source_changed"});
  await db.run(sql`UPDATE personal_answers SET raw_text=${en} WHERE id=${source.key}`);
  await db.run(sql`UPDATE practice_offline_runs SET output_hash='changed' WHERE stage='review'`);
  const client=createClient({url:temp.url});
  try{expect((await(await import("@/lib/four-step/audit")).auditPracticeMaterials(client)).ok).toBe(false);}finally{client.close();}
});
