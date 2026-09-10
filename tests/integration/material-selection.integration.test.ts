import { afterEach,beforeAll,describe,expect,it,vi } from "vitest";
import { sql } from "drizzle-orm";
import { createClient } from "@libsql/client";
import { prepareTestDatabase } from "../helpers/temp-db";
import { MockAiProvider } from "@/lib/ai/mock-provider";
const temporary=prepareTestDatabase("evidence-material");
process.env.ROASTDUCK_DB=temporary.url;
process.env.ROASTDUCK_SKIP_DB_BACKUP="1";
process.env.AI_PROVIDER="mock";
let db:Awaited<ReturnType<typeof import("@db/client").getDbReady>>;
let materials:typeof import("@/lib/four-step/materials");
let service:typeof import("@/lib/speaking-practice/service");
beforeAll(async()=>{
  db=await (await import("@db/client")).getDbReady();
  materials=await import("@/lib/four-step/materials");
  service=await import("@/lib/speaking-practice/service");
  const schema=await import("@db/schema");
  await db.insert(schema.questions).values({id:"evidence_q",bookId:"retired",part:1,text:"Do you live alone?",normText:"evidence_q"});
});
afterEach(()=>vi.restoreAllMocks());
const answer={questionId:"evidence_q",mode:"practice" as const,answerText:"I'm used to live alone.",intendedMeaningZh:"我已经习惯一个人住了。"};
describe("选材四阶段恢复、审计与旧分析兼容",()=>{
  it("坏草稿被Schema提前拒绝，显式重试复用前两阶段而不缓存错误输出",async()=>{
    const original=MockAiProvider.prototype.generate;
    const spy=vi.spyOn(MockAiProvider.prototype,"generate").mockImplementation(async function(this:MockAiProvider,request){
      const result=await original.call(this,request);
      if(request.schemaName==="four_step_material_v5") (result.data as {sentences:Array<{english:string}>}).sentences[0].english="I'm used to living alone. "+"An oversized synthetic sentence. ".repeat(80);
      return result;
    });
    const attempt=await service.createSpeakingAttempt(answer);
    expect(attempt.status).toBe("failed");
    expect((await materials.getMaterial(attempt.materialId!)).error_code).toBe("material_ai_invalid_output");
    expect(spy).toHaveBeenCalledTimes(3);
    const checkpoints=await db.all<{run_id:string;stage:string}>(sql`SELECT run_id,stage FROM practice_material_stages WHERE material_id=${attempt.materialId} AND status='completed' ORDER BY stage`);
    expect(checkpoints.map(stage=>stage.stage)).toEqual(['diagnosis','selection']);
    expect(await db.all(sql`SELECT * FROM practice_material_stages WHERE material_id=${attempt.materialId} AND stage IN ('material','review')`)).toHaveLength(0);
    spy.mockRestore();
    const retry=vi.spyOn(MockAiProvider.prototype,'generate');
    const recovered=await service.processSpeakingAttempt(attempt.id,{retry:true});
    expect(recovered?.status).toBe("completed");expect(recovered?.materialId).toBe(attempt.materialId);
    expect(retry.mock.calls.map(([request])=>request.schemaName)).toEqual(['four_step_material_v5','four_step_review_v5']);
    expect(await db.all(sql`SELECT run_id,stage FROM practice_material_stages WHERE material_id=${attempt.materialId} AND stage IN ('diagnosis','selection') ORDER BY stage`)).toEqual(checkpoints);
  });
  it("四个独立输入和运行，仅最后审核通过后发布；重复处理不再调用",async()=>{
    const spy=vi.spyOn(MockAiProvider.prototype,"generate");
    const attempt=await service.createSpeakingAttempt(answer);
    expect(attempt.status).toBe("completed");
    expect(spy.mock.calls.map(([r])=>r.schemaName)).toEqual(["four_step_diagnosis_v5","four_step_selection_v5","four_step_material_v5","four_step_review_v5"]);
    expect(new Set(spy.mock.calls.map(([r])=>r.instructions)).size).toBe(4);
    expect(attempt.analysis.learningMaterials[0].originalEnglish).toBe(answer.answerText);
    expect(attempt.analysis.learningMaterials[0].yourChineseSentence).toBe(answer.intendedMeaningZh);
    expect(attempt.analysis.learningMaterials.map((r)=>r.englishChunk)).toEqual(["be used to doing"]);
    await service.processSpeakingAttempt(attempt.id);
    expect(spy).toHaveBeenCalledTimes(4);
    const stages=await db.all<{run_id:string;stage:string;input_json:string}>(sql`SELECT * FROM practice_material_stages WHERE material_id=${attempt.materialId}`);
    expect(new Set(stages.map((s)=>s.run_id)).size).toBe(4);
    const client=createClient({url:temporary.url});
    try {
      const audit=await import("@/lib/four-step/audit");
      expect(await audit.auditPracticeMaterials(client,true,[attempt.materialId!])).toMatchObject({ok:true,checked:1});
      expect((await audit.auditPracticeMaterials(client,false,[attempt.materialId!])).issues.some((i)=>i.code.includes("mock"))).toBe(true);
      const selection=stages.find((s)=>s.stage==="selection")!;
      await db.run(sql`UPDATE practice_material_stages SET input_json='{}' WHERE run_id=${selection.run_id}`);
      expect((await audit.auditPracticeMaterials(client,true,[attempt.materialId!])).ok).toBe(false);
      await db.run(sql`UPDATE practice_material_stages SET input_json=${selection.input_json} WHERE run_id=${selection.run_id}`);
    } finally {client.close();}
  });
  it("最后审核网络失败先确认未知结果，授权重试仅运行该阶段且保留三个检查点",async()=>{
    const original=MockAiProvider.prototype.generate;
    const spy=vi.spyOn(MockAiProvider.prototype,"generate").mockImplementation(async function(this:MockAiProvider,request){
      if(request.schemaName==="four_step_review_v5") throw new Error("synthetic network failure");
      return original.call(this,request);
    });
    const attempt=await service.createSpeakingAttempt(answer);
    expect(attempt.status).toBe("failed");
    expect(attempt.answerText).toBe(answer.answerText);
    expect(await db.all(sql`SELECT * FROM practice_material_items WHERE material_id=${attempt.materialId}`)).toHaveLength(0);
    expect(await db.all(sql`SELECT * FROM practice_material_stages WHERE material_id=${attempt.materialId}`)).toHaveLength(3);
    expect((await materials.getMaterial(attempt.materialId!)).error_code).toBe('result_unknown');
    spy.mockRestore();
    const retry=vi.spyOn(MockAiProvider.prototype,"generate");
    expect((await service.processSpeakingAttempt(attempt.id,{retry:true}))?.status).toBe('failed');
    expect(retry).not.toHaveBeenCalled();
    expect((await service.processSpeakingAttempt(attempt.id,{retry:true,retryUnknown:true}))?.status).toBe("completed");
    expect(retry).toHaveBeenCalledTimes(1);
    expect(retry.mock.calls[0][0].schemaName).toBe("four_step_review_v5");
  });
  it("诊断审核拒绝时根本不运行材料生成，拒绝证据不被覆盖",async()=>{
    const original=MockAiProvider.prototype.generate;
    const spy=vi.spyOn(MockAiProvider.prototype,"generate").mockImplementation(async function(this:MockAiProvider,request){
      const result=await original.call(this,request);
      if(request.schemaName==="four_step_selection_v5") (result.data as {approved:boolean}).approved=false;
      return result;
    });
    const attempt=await service.createSpeakingAttempt(answer);
    expect(attempt.status).toBe("failed");
    expect(spy).toHaveBeenCalledTimes(2);
    expect(await db.all(sql`SELECT * FROM practice_material_stages WHERE material_id=${attempt.materialId} AND status='rejected'`)).toHaveLength(2);
    expect(await db.all(sql`SELECT * FROM practice_material_items WHERE material_id=${attempt.materialId}`)).toHaveLength(0);
  });
  it("旧回答只在明确操作时生成新版快照；重复点击幂等，原分析不丢失",async()=>{
    const schema=await import("@db/schema");
    await db.insert(schema.speakingQuestionAttempts).values({id:"legacy_evidence",mode:"practice",questionId:answer.questionId,answerText:answer.answerText,intendedMeaningZh:answer.intendedMeaningZh,status:"completed",analysisJson:'{"legacy":"original"}',naturalVersion:"Old reference."});
    const spy=vi.spyOn(MockAiProvider.prototype,"generate");
    expect((await service.getSpeakingAttempt("legacy_evidence"))?.materialId).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
    const a=await service.prepareAttemptReanalysis("legacy_evidence");
    const b=await service.prepareAttemptReanalysis("legacy_evidence");
    expect(a.materialId).toBe(b.materialId);
    expect(a.status).toBe("processing");
    expect(spy).not.toHaveBeenCalled();
    await service.processSpeakingAttempt(a.id);
    expect((await service.getSpeakingAttempt(a.id))?.analysis.contractVersion).toBe("evidence_v2");
    const [archive]=await db.all<{analysis_json:string}>(sql`SELECT analysis_json FROM practice_legacy_analyses WHERE attempt_id=${a.id}`);
    expect(JSON.parse(archive.analysis_json)).toEqual({legacy:"original"});
    expect((await service.getSpeakingAttempt(a.id))?.answerText).toBe(answer.answerText);
  });
  it("并发处理只认领一份材料，审核不重复写入",async()=>{
    const saved=await service.prepareSpeakingAttempt(answer);
    const spy=vi.spyOn(MockAiProvider.prototype,"generate");
    await Promise.all([materials.processMaterial(saved.materialId!),materials.processMaterial(saved.materialId!)]);
    expect((await materials.getMaterial(saved.materialId!)).status).toBe("ready");
    expect(spy).toHaveBeenCalledTimes(4);
    expect(await db.all(sql`SELECT * FROM practice_material_items WHERE material_id=${saved.materialId}`)).toHaveLength(1);
  });
  it("原文引用不合法时带校验原因修复一次，保留被拒记录再独立审核",async()=>{
    const original=MockAiProvider.prototype.generate;
    let corrupted=false;
    const spy=vi.spyOn(MockAiProvider.prototype,"generate").mockImplementation(async function(this:MockAiProvider,request){
      const result=await original.call(this,request);
      if(request.schemaName==="four_step_diagnosis_v5"&&!corrupted){
        corrupted=true;
        (result.data as {units:Array<{english:Array<{text:string}>}>}).units[0].english[0].text="A fabricated quote.";
      }
      return result;
    });
    const result=await service.createSpeakingAttempt(answer);
    expect(result.status).toBe("completed");
    expect(spy).toHaveBeenCalledTimes(5);
    const repair=spy.mock.calls[1][0];
    expect(repair.promptVersion).toBe("sentence_intention.repair.v1.md");
    expect(JSON.parse(repair.input).correction.validationIssue).toContain("引用");
    expect(await db.all(sql`SELECT * FROM practice_material_stages WHERE material_id=${result.materialId} AND status='rejected'`)).toHaveLength(1);
    const client=createClient({url:temporary.url});
    try{expect((await(await import("@/lib/four-step/audit")).auditPracticeMaterials(client,true)).ok).toBe(true);}finally{client.close();}
    await service.processSpeakingAttempt(result.id);
    expect(spy).toHaveBeenCalledTimes(5);
  });
});
