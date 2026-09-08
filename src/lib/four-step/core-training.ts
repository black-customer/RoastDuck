import {query as sql} from "@/lib/platform/sql";
import type {DatabasePort,SqlReader,SqlWriter} from "@/lib/platform/database";
import {RuntimeRequestError,type RuntimeCalls} from "@/lib/ai/runtime-ledger";
import {auditPracticeMaterials} from "./audit";
import { grade, newCard, type Card } from "@/lib/learning/fsrs";
import { speakingAttemptAnalysisSchema } from "@/lib/speaking-practice/schemas";
import { buildTasks, judgeSchema, normalizeExpression,trainingEventSchema, type JudgeResult, type TrainingEvent, type TrainingState, type TrainingTask, type TrainingView } from "./contracts";
import type {MaterialInput,MaterialRow} from "./material-types";
import { hash, TrainingError } from "./shared";
import {assertLocalOwnership,localOwnerFilter} from '@/lib/device-sync/ownership';

interface SessionRow {
  id: string; material_id: string; mode: string; status: string; step_no: number; step_version: number;
  state_json: string; lease_until: string | null; lease_token: string | null; completed_at: string | null;
}
async function session(db:SqlReader,id: string) {
  const [row] = await db.all<SessionRow>(sql`SELECT * FROM four_step_sessions WHERE id=${id}`);
  if (!row) throw new TrainingError("训练会话不存在", 404, "training_not_found");
  return row;
}
export interface TrainingPlatform {database:DatabasePort;runtime:RuntimeCalls;now:()=>Date;newId:()=>string;loadPrompt:(name:string)=>string|Promise<string>;allowMock?:boolean;bootId?:string}
export function createTrainingService(platform:TrainingPlatform){
const {database}=platform;
async function materialFrom(tx:SqlReader,id:string){const [row]=await tx.all<MaterialRow>(sql`SELECT * FROM practice_materials WHERE id=${id}`);if(!row)throw new TrainingError("学习材料不存在",404,"material_not_found");return row;}
async function trainingView(id: string): Promise<TrainingView> {
  return database.read(async db=>{
  const row = await session(db,id);
  const material = await materialFrom(db,row.material_id);
  if (material.status !== "ready") throw new TrainingError("材料尚未审核通过", 409, "material_not_ready");
  const state = JSON.parse(row.state_json) as TrainingState;
  const tasks = state.tasks[row.step_no - 1] ?? [];
  const task = tasks[state.cursor];
  const [pending]=await db.all<{request_json:string}>(sql`SELECT request_json FROM four_step_events WHERE session_id=${id} AND status IN('processing','failed') ORDER BY created_at DESC LIMIT 1`);
  let pendingEvent:TrainingEvent|null=null;
  if(pending)try{const event=trainingEventSchema.parse(JSON.parse(pending.request_json));if(event.stepVersion===row.step_version)pendingEvent=event;}catch{/* Preserve incompatible historical events without applying them. */}
  const interrupted=!!platform.bootId&&!!row.lease_token?.startsWith("train.")&&!row.lease_token.startsWith(`train.${platform.bootId}.`);
  let hint: string | null = null;
  if (task && state.hintVisible && state.assistance === 1) hint = `先想想这次要表达的意思：${task.promptZh}`;
  if (task && state.hintVisible && state.assistance === 2) hint = `表达结构：${task.answer.split(/\s+/).map((word, i) => i === 0 ? word : "____").join(" ")}`;
  if (task && state.hintVisible && state.assistance === 3) hint = `部分表达：${task.answer.split(/\s+/).map((word, i) => i % 2 === 0 ? word : "____").join(" ")}`;
  return { id, materialId: material.id, sourceType: material.source_type, sourceId: material.source_id, questionId: material.question_id,
    mode: row.mode, status: row.status, step: row.step_no, stepVersion: row.step_version, taskIndex: state.cursor, taskCount: tasks.length,
    promptZh: task?.promptZh ?? "本次没有需要强化的表达", before: task?.before, after: task?.after,
    draft: state.input,draftVersion:state.draftVersion??0, passed: state.passed, feedback: state.feedback, hint,
    answer: task && (state.passed || (state.hintVisible && state.assistance >= 4)) ? task.answer : null,
    busy: !interrupted&&Boolean(row.lease_until && row.lease_until > platform.now().toISOString()),pendingEvent, completedAt: row.completed_at };
  });
}

async function createTraining(materialId: string, mode: "learn" | "review" = "learn") {
  const result=await database.write(async db=>{
    const material = await materialFrom(db,materialId);
    if (material.status !== "ready" || !material.generator_run_id || !material.reviewer_run_id) throw new TrainingError("这份材料尚未完成独立审核", 409, "material_not_ready");
    const audit=await auditPracticeMaterials({execute:async statement=>({rows:await db.all<Record<string,unknown>>(typeof statement==="string"?{sql:statement}:statement)})},platform.allowMock,[material.id]);
    if(!audit.ok)throw new TrainingError("材料证据不完整，暂不能训练",409,"material_not_ready");
    const [active] = await db.all<{ id: string;status:string }>(sql`SELECT id,status FROM four_step_sessions WHERE material_id=${materialId} AND mode=${mode} AND status IN('active','paused') AND ${localOwnerFilter('four_step_sessions','four_step_sessions.id')} ORDER BY (status='active') DESC,updated_at DESC LIMIT 1`);
    if (active){if(active.status==="paused")await db.run(sql`UPDATE four_step_sessions SET status='active',step_version=step_version+1,updated_at=${platform.now().toISOString()} WHERE id=${active.id}`);return active.id;}
    if (mode === "learn") {
      const [done] = await db.all<{ id: string }>(sql`SELECT id FROM four_step_sessions WHERE material_id=${materialId} AND mode='learn' AND status IN ('completed','no_training_required') ORDER BY created_at DESC LIMIT 1`);
      if (done) return done.id;
    }
    const analysis = speakingAttemptAnalysisSchema.parse(JSON.parse(material.analysis_json));
    const input = JSON.parse(material.input_json) as MaterialInput;
    const allTasks = buildTasks(analysis.learningMaterials, analysis.naturalVersion, analysis.answerIntentZh ?? input.intendedMeaningZh);
    let selectedRows = analysis.learningMaterials.map((_, i) => i);
    if (mode === "review") {
      const due = await db.all<{ row_index: number }>(sql`SELECT mi.row_index FROM practice_material_items mi JOIN learning_item_schedule p ON p.learning_item_id=mi.learning_item_id WHERE mi.material_id=${materialId} AND p.due_at<=${platform.now().toISOString()}`);
      selectedRows = due.map((r) => r.row_index);
      if (!selectedRows.length) throw new TrainingError("本次回答暂时没有到期表达", 409, "nothing_due");
    }
    const tasks = allTasks.map((step, i) => i === 3 ? step : step.filter((t) => t.rowIndices.some((index) => selectedRows.includes(index))));
    const noItems = !analysis.learningMaterials.length;
    if (!noItems && tasks.some((step) => !step.length)) throw new TrainingError("四步材料不完整，不能开始训练", 422, "incomplete_training");
    const state: TrainingState = { cursor: 0, passed: false, input: "", assistance: 0, feedback: null, tasks, evidence: [] };
    const id = `train_${platform.newId()}`;
    const now = platform.now().toISOString();
    await db.run(sql`INSERT INTO four_step_sessions (id,material_id,mode,status,state_json,created_at,updated_at)
      VALUES (${id},${materialId},${mode},${noItems ? "no_training_required" : "active"},${JSON.stringify(state)},${now},${now})`);
    return id;
  });
  return trainingView(result);
}

async function judge(materialId: string, step: number, task: TrainingTask, input: string,retryUnknown=false): Promise<JudgeResult> {
  const normalized = normalizeExpression(input);
  if (normalized && [task.answer, ...task.variants].some((answer) => normalizeExpression(answer) === normalized)) return { verdict: "correct", meaningPreserved: true, feedbackZh: "这次表达正确，意思一致。" };
  const id = hash("four-step-judge-v1", materialId, String(step), task.id, normalized);
  const now = platform.now().toISOString();
  const token = `judge.${platform.bootId??"local"}.${platform.newId()}`;
  const existing = await database.read(db=>db.all<{ status: string; result_json: string | null;run_id:string|null }>(sql`SELECT * FROM four_step_judgements WHERE id=${id}`));
  if (existing[0]?.status === "completed" && existing[0].result_json) return judgeSchema.parse(JSON.parse(existing[0].result_json));
  const lease = new Date(platform.now().getTime() + 5 * 60_000).toISOString();
  const claimed = await database.write(db=>db.run(sql`INSERT INTO four_step_judgements (id,status,lease_until,lease_token,updated_at) VALUES (${id},'processing',${lease},${token},${now})
    ON CONFLICT(id) DO UPDATE SET status='processing',lease_until=${lease},lease_token=${token},updated_at=${now}
    WHERE four_step_judgements.status!='completed' AND (four_step_judgements.lease_until IS NULL OR four_step_judgements.lease_until<${now} OR (${Number(!!platform.bootId)}=1 AND four_step_judgements.lease_token LIKE 'judge.%' AND four_step_judgements.lease_token NOT LIKE ${`judge.${platform.bootId}.%`}))`));
  if (!claimed.changes) throw new TrainingError("同一表达正在判定，请稍后重试", 409, "judgement_busy");
  try {
    const result = await platform.runtime.call({
      role: "retrieval_judge", instructions: await platform.loadPrompt("four_step_retrieval.judge.v1.md"), input: JSON.stringify({ task: step, promptZh: task.promptZh, answer: task.answer, variants: task.variants, before: task.before, after: task.after, input }),
      schema: judgeSchema, schemaName: "four_step_judge_v1", schemaVersion: "four-step-judge-v1", promptVersion: "four-step-judge-v1", idempotencyKey:existing[0]?.status==="retryable"?`${id}:${existing[0].run_id}`:id,
    }, {retryFailed:true,retryUnknown});
    const data = result.data.verdict === "correct" && !result.data.meaningPreserved ? { ...result.data, verdict: "uncertain" as const } : result.data;
    await database.write(db=>db.run(sql`UPDATE four_step_judgements SET status=${data.verdict === "uncertain" ? "retryable" : "completed"},result_json=${JSON.stringify(data)},run_id=${result.runId},lease_until=NULL,lease_token=NULL WHERE id=${id} AND lease_token=${token}`));
    return data;
  } catch (error) {
    await database.write(db=>db.run(sql`UPDATE four_step_judgements SET status='failed',lease_until=NULL,lease_token=NULL WHERE id=${id} AND lease_token=${token}`));
    throw error;
  }
}

async function settle(db:SqlWriter,row: SessionRow, state: TrainingState) {
  const now = platform.now().toISOString();
  const items = await db.all<{ learning_item_id: string; row_index: number; fsrs_json: string | null; due_at: string | null }>(sql`SELECT mi.*, p.fsrs_json,p.due_at FROM practice_material_items mi LEFT JOIN learning_item_schedule p ON p.learning_item_id=mi.learning_item_id WHERE mi.material_id=${row.material_id}`);
  const settled = new Set<string>();
  for (const item of items) {
    if (settled.has(item.learning_item_id)) continue;
    const indices = items.filter((i) => i.learning_item_id === item.learning_item_id).map((i) => i.row_index);
    const evidence = state.evidence.filter((e) => e.rows.some((i) => indices.includes(i)));
    if (!evidence.some((e) => e.step === 1)) continue;
    settled.add(item.learning_item_id);
    const rating = evidence.some((e) => e.verdict === "incorrect") ? "again" : evidence.some((e) => e.assisted > 0) ? "hard" : "good";
    const claimed = await db.run(sql`INSERT INTO four_step_settlements (session_id,learning_item_id,rating,evidence_json,completed_at)
      VALUES (${row.id},${item.learning_item_id},${rating},${JSON.stringify(evidence)},${now}) ON CONFLICT DO NOTHING`);
    if (!claimed.changes) continue;
    const prior = item.fsrs_json ? JSON.parse(item.fsrs_json) as Card : newCard(platform.now());
    prior.due = new Date(prior.due);
    if (prior.last_review) prior.last_review = new Date(prior.last_review);
    const { card } = grade(prior, rating,platform.now());
    const reviewed = row.mode === "review" && item.due_at !== null && item.due_at <= now ? 1 : 0;
    await db.run(sql`INSERT INTO learning_item_schedule (learning_item_id,fsrs_json,due_at,last_completed_at,review_count)
      VALUES (${item.learning_item_id},${JSON.stringify(card)},${card.due.toISOString()},${now},${reviewed})
      ON CONFLICT(learning_item_id) DO UPDATE SET fsrs_json=excluded.fsrs_json,due_at=excluded.due_at,last_completed_at=excluded.last_completed_at,review_count=learning_item_schedule.review_count+${reviewed}`);
  }
  const material = await materialFrom(db,row.material_id);
  if (material.question_id) {
    await db.run(sql`INSERT INTO question_mastery(question_id,four_step_completed_at,last_learned_at,mastery_source,updated_at) VALUES(${material.question_id},${now},${now},'training_only',${now}) ON CONFLICT(question_id) DO UPDATE SET four_step_completed_at=excluded.four_step_completed_at,last_learned_at=excluded.last_learned_at,updated_at=excluded.updated_at`);
  }
}

async function applyTrainingEvent(id: string, event: TrainingEvent) {
  const inputHash = hash(JSON.stringify(event));
  const token = `train.${platform.bootId??"local"}.${platform.newId()}`;
  const claimed = await database.write(async db=>{
    await assertLocalOwnership(db,'four_step_sessions',id);
    const row = await session(db,id);
    const [prior] = await db.all<{ input_hash: string; status: string }>(sql`SELECT * FROM four_step_events WHERE session_id=${id} AND client_event_id=${event.clientEventId}`);
    if (prior?.input_hash !== undefined && prior.input_hash !== inputHash) throw new TrainingError("事件编号已用于不同内容");
    if (prior?.status === "completed") return null;
    if (row.status !== "active" || row.step_version !== event.stepVersion) throw new TrainingError("训练已变化，请刷新恢复", 409, "step_version_conflict");
    const now = platform.now().toISOString();
    const interrupted=!!platform.bootId&&!!row.lease_token?.startsWith("train.")&&!row.lease_token.startsWith(`train.${platform.bootId}.`);
    if (row.lease_until && row.lease_until > now&&!interrupted) throw new TrainingError("正在处理上一次输入，请稍候", 409, "training_busy");
    const state = JSON.parse(row.state_json) as TrainingState;
    if (event.type === "continue" && !state.passed) throw new TrainingError("请先通过当前练习", 409, "exercise_not_passed");
    if (event.type === "submit" && state.hintVisible) throw new TrainingError("请先遮住提示，再进行提取", 409, "hide_hint_first");
    if (event.type === "submit") { state.input = event.input; state.passed = false; }
    await db.run(sql`INSERT INTO four_step_events (session_id,client_event_id,input_hash,request_json,status,created_at) VALUES (${id},${event.clientEventId},${inputHash},${JSON.stringify(event)},'processing',${now})
      ON CONFLICT(session_id,client_event_id) DO UPDATE SET status='processing'`);
    await db.run(sql`UPDATE four_step_sessions SET state_json=${JSON.stringify(state)},lease_token=${token},lease_until=${new Date(platform.now().getTime() + 5 * 60_000).toISOString()},updated_at=${now} WHERE id=${id}`);
    return { row, state };
  });
  if (!claimed) return trainingView(id);
  const { row, state } = claimed;
  try {
    if (event.type === "submit") {
      const task = state.tasks[row.step_no - 1][state.cursor];
      const result = await judge(row.material_id, row.step_no, task, event.input,event.retryUnknown);
      state.feedback = result;
      state.passed = result.verdict === "correct" && result.meaningPreserved;
      if (result.verdict !== "uncertain") state.evidence.push({ taskId: task.id, rows: task.rowIndices, step: row.step_no, verdict: result.verdict, assisted: state.assistance });
    } else if (event.type === "assist") {
      state.assistance = Math.min(4, state.assistance + 1); state.passed = false; state.feedback = null; state.hintVisible = true;
    } else if (event.type === "recall") {
      state.hintVisible = false; state.input = ""; state.passed = false; state.feedback = null;
    } else if(event.type==="pause"){
      row.status="paused";
    } else {
      state.cursor += 1;
      if (state.cursor >= state.tasks[row.step_no - 1].length) {
        row.step_no += 1; state.cursor = 0;
        if (row.step_no === 3) {
          const weak = new Set(state.evidence.filter((e) => e.verdict === "incorrect" || e.assisted > 0).flatMap((e) => e.rows));
          state.tasks[2] = weak.size ? state.tasks[2].filter((t) => t.rowIndices.some((i) => weak.has(i))) : state.tasks[2].slice(0, 1);
        }
      }
      state.input = ""; state.passed = false; state.assistance = 0; state.feedback = null;
    }
    await database.write(async db=>{
      if ((await session(db,id)).lease_token !== token) throw new TrainingError("本次处理已过期，请恢复会话");
      const now = platform.now().toISOString();
      if (row.step_no > 4) { await settle(db,row, state); row.status = "completed"; row.completed_at = now; row.step_no = 4; }
      await db.run(sql`UPDATE four_step_sessions SET step_no=${row.step_no},step_version=step_version+1,state_json=${JSON.stringify(state)},status=${row.status},completed_at=${row.completed_at},lease_until=NULL,lease_token=NULL,updated_at=${now} WHERE id=${id}`);
      await db.run(sql`UPDATE four_step_events SET status='completed',result_json=${JSON.stringify(state.feedback)} WHERE session_id=${id} AND client_event_id=${event.clientEventId}`);
    });
  } catch (error) {
    await database.write(async db=>{
      if ((await session(db,id)).lease_token !== token) return;
      // 原输入已在 claim 时保存；失败不改变步骤，也不记一次错误。
      await db.run(sql`UPDATE four_step_sessions SET lease_until=NULL,lease_token=NULL WHERE id=${id}`);
      await db.run(sql`UPDATE four_step_events SET status='failed' WHERE session_id=${id} AND client_event_id=${event.clientEventId}`);
    });
    if (error instanceof TrainingError) throw error;
    if(error instanceof RuntimeRequestError)throw new TrainingError(error.message,503,error.code);
    throw new TrainingError("判定服务暂不可用，输入已保存，请重试", 503, "judgement_unavailable");
  }
  return trainingView(id);
}

async function saveDraft(id:string,input:{stepVersion:number;draftVersion:number;text:string}){
  if(input.text.length>8000)throw new TrainingError("输入过长");
  await database.write(async db=>{
    await assertLocalOwnership(db,'four_step_sessions',id);
    const row=await session(db,id),state=JSON.parse(row.state_json) as TrainingState;
    if(row.step_version!==input.stepVersion||row.status!=="active"||row.lease_until&&row.lease_until>platform.now().toISOString())throw new TrainingError("步骤已更新或正在判定，请先恢复",409,"step_version_conflict");
    if(state.input===input.text)return;
    if((state.draftVersion??0)!==input.draftVersion)throw new TrainingError("草稿已更新，请恢复最新输入",409,"draft_version_conflict");
    state.input=input.text;state.draftVersion=(state.draftVersion??0)+1;state.passed=false;state.feedback=null;
    await db.run(sql`UPDATE four_step_sessions SET state_json=${JSON.stringify(state)},updated_at=${platform.now().toISOString()} WHERE id=${id}`);
  });return trainingView(id);
}
return {trainingView,createTraining,applyTrainingEvent,saveDraft};
}
