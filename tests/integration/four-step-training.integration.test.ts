import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MockAiProvider } from "@/lib/ai/mock-provider";
import { sql } from "drizzle-orm";
import { prepareTestDatabase } from "../helpers/temp-db";
const temporary = prepareTestDatabase("four-step-training");
process.env.ROASTDUCK_DB = temporary.url;
process.env.ROASTDUCK_SKIP_DB_BACKUP = "1";
process.env.AI_PROVIDER = "mock";
let db: Awaited<ReturnType<typeof import("@db/client").getDbReady>>;
let materials: typeof import("@/lib/four-step/materials");
let training: typeof import("@/lib/four-step/training");
afterEach(() => vi.restoreAllMocks());
beforeAll(async () => {
  db = await (await import("@db/client")).getDbReady();
  materials = await import("@/lib/four-step/materials");
  training = await import("@/lib/four-step/training");
});

async function fixture(id: string) {
  await db.run(sql`INSERT INTO free_talk_conversations(id,title,mode) VALUES(${id},'合成对话','relaxed')`);
  await db.run(sql`INSERT INTO free_talk_messages(id,conversation_id,sequence_no,role,text) VALUES(${`msg_${id}`},${id},1,'user','I saw a 井盖 outside.')`);
  const material = await materials.prepareMaterial({ sourceType: "free_talk", sourceId: id, question: null, mode: "relaxed", actualAnswer: "I saw a 井盖 outside.", intendedMeaningZh: "我在外面看到一个井盖。", sourceMessages: [{ id: `msg_${id}`, role: "user", text: "I saw a 井盖 outside." }] });
  const ready = await materials.processMaterial(material.id);
  expect(ready.status, ready.error_code ?? "ready").toBe("ready");
  return ready;
}
describe("新版固定四步的材料与服务端闭环", () => {
  it("材料四阶段独立请求审核后可用，无需写回词书", async () => {
    const ready = await fixture("reviewed");
    expect(ready.generator_run_id).not.toBe(ready.reviewer_run_id);
    const runs = await db.all<{ prompt_version: string }>(sql`SELECT prompt_version FROM ai_runs WHERE job_id=${ready.job_id}`);
    expect(new Set(runs.map((r) => r.prompt_version)).size).toBe(4);
    expect(await db.all(sql`SELECT * FROM chunks`)).toHaveLength(0);
    const pending = await materials.prepareMaterial({ sourceType: "free_talk", sourceId: "pending", question: null, mode: "relaxed", actualAnswer: "原话", intendedMeaningZh: "" });
    await expect(training.createTraining(pending.id)).rejects.toMatchObject({ code: "material_not_ready" });
  });
  it("固定顺序、不可跳步，刷新恢复，重复事件不重复结算", async () => {
    const material = await fixture("four_steps");
    let view = await training.createTraining(material.id);
    expect(view.answer).toBeNull();
    expect(view.before).toBeUndefined();
    await expect(training.applyTrainingEvent(view.id, { type: "continue", stepVersion: view.stepVersion, clientEventId: "skip-forbidden" })).rejects.toMatchObject({ code: "exercise_not_passed" });
    const wrong = { type: "submit" as const, input: "the", stepVersion: view.stepVersion, clientEventId: "wrong-substring" };
    view = await training.applyTrainingEvent(view.id, wrong);
    expect(view.passed).toBe(false);
    expect(view.draft).toBe("the");
    expect((await training.applyTrainingEvent(view.id, wrong)).stepVersion).toBe(view.stepVersion);
    const steps: number[] = [];
    while (view.status === "active") {
      steps.push(view.step);
      const [row] = await db.all<{ state_json: string }>(sql`SELECT state_json FROM four_step_sessions WHERE id=${view.id}`);
      const state = JSON.parse(row.state_json);
      const answer = state.tasks[view.step - 1][view.taskIndex].answer as string;
      view = await training.applyTrainingEvent(view.id, { type: "submit", input: answer, stepVersion: view.stepVersion, clientEventId: `correct-${view.stepVersion}` });
      expect(view.passed).toBe(true);
      expect((await training.trainingView(view.id)).stepVersion).toBe(view.stepVersion);
      const next = { type: "continue" as const, stepVersion: view.stepVersion, clientEventId: `next-${view.stepVersion}` };
      view = await training.applyTrainingEvent(view.id, next);
      expect((await training.applyTrainingEvent(view.id, next)).stepVersion).toBe(view.stepVersion);
    }
    expect([...new Set(steps)]).toEqual([1,2,3,4]);
    expect(view.status).toBe("completed");
    expect(await db.all(sql`SELECT * FROM four_step_settlements WHERE session_id=${view.id}`)).toHaveLength(1);
    expect(await db.all(sql`SELECT * FROM learning_item_schedule`)).toHaveLength(1);
    expect((await training.createTraining(material.id)).id).toBe(view.id);
  });
  it("同一提交只保存一个原回答，不等待 AI，冲突不覆盖", async () => {
    const schema = await import("@db/schema");
    await db.insert(schema.questions).values({ id: "submission_q", bookId: "deleted", part: 1, text: "Do you walk?", normText: "submission_q" });
    const service = await import("@/lib/speaking-practice/service");
    const input = { questionId: "submission_q", mode: "practice" as const, answerText: "I saw a 井盖 outside.", intendedMeaningZh: "", clientRequestId: "request_once" };
    const [a, b] = await Promise.all([service.prepareSpeakingAttempt(input), service.prepareSpeakingAttempt(input)]);
    expect(a.id).toBe(b.id);
    expect(a.status).toBe("processing");
    expect(a.answerText).toBe(input.answerText);
    expect(a.materialId).toBeTruthy();
    await expect(service.prepareSpeakingAttempt({ ...input, answerText: "changed" })).rejects.toMatchObject({ code: "submission_conflict" });
  });
  it("看过完整答案后必须遮住再输入，不能用提示直接通过", async () => {
    let view = await training.createTraining((await fixture("assisted")).id);
    for (let i = 0; i < 4; i++) view = await training.applyTrainingEvent(view.id, { type: "assist", stepVersion: view.stepVersion, clientEventId: `assist-at-${i}` });
    expect(view.answer).toBe("manhole cover");
    await expect(training.applyTrainingEvent(view.id, { type: "submit", input: "manhole cover", stepVersion: view.stepVersion, clientEventId: "visible-answer" })).rejects.toMatchObject({ code: "hide_hint_first" });
    view = await training.applyTrainingEvent(view.id, { type: "recall", stepVersion: view.stepVersion, clientEventId: "hide-and-recall" });
    expect(view.answer).toBeNull();
    view = await training.applyTrainingEvent(view.id, { type: "submit", input: "manhole cover", stepVersion: view.stepVersion, clientEventId: "recall-answer" });
    expect(view.passed).toBe(true);
    const [row] = await db.all<{ state_json: string }>(sql`SELECT state_json FROM four_step_sessions WHERE id=${view.id}`);
    expect(JSON.parse(row.state_json).evidence[0].assisted).toBe(4);
  });
  it("判定网络失败保留原输入与步骤，不记录错误或完成；相同事件可以恢复", async () => {
    let view = await training.createTraining((await fixture("network_failure")).id);
    const generate = vi.spyOn(MockAiProvider.prototype, "generate").mockRejectedValueOnce(new Error("simulated outage"));
    const event = { type: "submit" as const, input: "a cover for a manhole", stepVersion: view.stepVersion, clientEventId: "network-event" };
    await expect(training.applyTrainingEvent(view.id, event)).rejects.toMatchObject({ code: "judgement_unavailable" });
    view = await training.trainingView(view.id);
    expect(view.draft).toBe(event.input);
    expect(view.passed).toBe(false);
    expect(view.stepVersion).toBe(event.stepVersion);
    const [row] = await db.all<{ state_json: string }>(sql`SELECT state_json FROM four_step_sessions WHERE id=${view.id}`);
    expect(JSON.parse(row.state_json).evidence).toEqual([]);
    generate.mockRestore();
    view = await training.applyTrainingEvent(view.id, event);
    expect(view.feedback?.verdict).toBe("incorrect");
  });
  it("自然同义表达可以通过并复用已判结果，uncertain 不等于错误或正确", async () => {
    let view = await training.createTraining((await fixture("semantic")).id);
    const generate = vi.spyOn(MockAiProvider.prototype, "generate");
    generate.mockResolvedValueOnce({ data: { verdict: "correct", meaningPreserved: true, feedbackZh: "自然同义表达" }, responseId: "semantic-fixture", latencyMs: 0, usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedTokens: 0 } });
    view = await training.applyTrainingEvent(view.id, { type: "submit", input: "a manhole lid", stepVersion: view.stepVersion, clientEventId: "semantic-once" });
    expect(view.passed).toBe(true);
    view = await training.applyTrainingEvent(view.id, { type: "submit", input: "A MANHOLE LID.", stepVersion: view.stepVersion, clientEventId: "semantic-cache" });
    expect(view.passed).toBe(true);
    expect(generate).toHaveBeenCalledTimes(1);
    generate.mockResolvedValueOnce({ data: { verdict: "uncertain", meaningPreserved: false, feedbackZh: "还需要确认意思" }, responseId: "uncertain-fixture", latencyMs: 0, usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedTokens: 0 } });
    view = await training.applyTrainingEvent(view.id, { type: "submit", input: "a thing", stepVersion: view.stepVersion, clientEventId: "uncertain-once" });
    expect(view.passed).toBe(false);
    expect(view.feedback?.verdict).toBe("uncertain");
    expect(await db.all(sql`SELECT * FROM four_step_settlements WHERE session_id=${view.id}`)).toHaveLength(0);
  });
  it("无 Gap 不编造必练项，重复复盘使用同一快照，新增消息产生新版本", async () => {
    const input = { sourceType: "free_talk" as const, sourceId: "real-conv-snapshot", question: null, mode: "relaxed", actualAnswer: "I study computer science.", intendedMeaningZh: "", sourceMessages: [{ id: "real-msg-1", role: "user", text: "I study computer science." }] };
    await db.run(sql`INSERT INTO free_talk_conversations(id,title,mode) VALUES(${input.sourceId},'合成对话','relaxed')`);
    await db.run(sql`INSERT INTO free_talk_messages(id,conversation_id,sequence_no,role,text) VALUES('real-msg-1',${input.sourceId},1,'user',${input.actualAnswer})`);
    const [one, duplicate] = await Promise.all([materials.prepareMaterial(input), materials.prepareMaterial(input)]);
    expect(one.id).toBe(duplicate.id);
    const ready = await materials.processMaterial(one.id);
    expect(ready.status).toBe("ready");
    const noTraining = await training.createTraining(ready.id);
    expect(noTraining.status).toBe("no_training_required");
    expect((await training.createTraining(ready.id)).id).toBe(noTraining.id);
    await db.run(sql`INSERT INTO free_talk_messages(id,conversation_id,sequence_no,role,text) VALUES('real-msg-2',${input.sourceId},2,'user','It is fun.')`);
    const next = await materials.prepareMaterial({ ...input, actualAnswer: input.actualAnswer + "\nIt is fun.", sourceMessages: [...input.sourceMessages, { id: "real-msg-2", role: "user", text: "It is fun." }] });
    expect(next.id).not.toBe(one.id);
    expect((await materials.getMaterial(one.id)).input_json).toBe(one.input_json);
  });
  it("审核拒绝不发布，显式重试保留被拒版本再重新生成", async () => {
    await db.run(sql`INSERT INTO free_talk_conversations(id,title,mode) VALUES('rejected','合成对话','relaxed')`);
    await db.run(sql`INSERT INTO free_talk_messages(id,conversation_id,sequence_no,role,text) VALUES('rejected-msg','rejected',1,'user','I saw a 井盖 outside.')`);
    const material = await materials.prepareMaterial({ sourceType: "free_talk", sourceId: "rejected", question: null, mode: "relaxed", actualAnswer: "I saw a 井盖 outside.", intendedMeaningZh: "",sourceMessages:[{id:'rejected-msg',role:'user',text:'I saw a 井盖 outside.'}] });
    const original = MockAiProvider.prototype.generate;
    const generate = vi.spyOn(MockAiProvider.prototype, "generate").mockImplementation(async function(this:MockAiProvider,request) {
      const result=await original.call(this,request);
      if(request.schemaName==="four_step_review_v2") (result.data as {approved:boolean}).approved=false;
      return result;
    });
    expect((await materials.processMaterial(material.id)).status).toBe("failed");
    expect(await db.all(sql`SELECT * FROM practice_material_items WHERE material_id=${material.id}`)).toHaveLength(0);
    generate.mockRestore();
    expect((await materials.processMaterial(material.id)).status).toBe("ready");
    expect(await db.all(sql`SELECT * FROM practice_material_stages WHERE material_id=${material.id} AND status='rejected'`)).toHaveLength(2);
    expect(await db.all(sql`SELECT * FROM practice_material_stages WHERE material_id=${material.id} AND status='completed'`)).toHaveLength(4);
  });
});
