import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { getDbReady, withDbTransaction } from "@db/client";
import { aiJobs, speakingQuestionAttempts } from "@db/schema";
import { createAiProvider } from "@/lib/ai/provider-factory";
import { enqueueAiJob, executeAuditedAiCall } from "@/lib/ai/job-service";
import { runtimeAnswerMockResolver } from "@/lib/answers/runtime-mock";
import { speakingAttemptAnalysisSchema, type SpeakingAttemptAnalysis } from "@/lib/speaking-practice/schemas";
import { materialReviewSchema, normalizeExpression } from "./contracts";
import { hash, TrainingError } from "./shared";
import { validateMaterial } from "./material-validation";
import type { MaterialInput, MaterialRow } from "./material-types";
export { validateMaterial } from "./material-validation";
export type { MaterialInput, MaterialRow } from "./material-types";
import { runDiagnosticPipeline } from "./diagnostic-pipeline";
import { selectionMockResolver } from "./selection-mock";
import { AiProviderError } from "@/lib/ai/errors";
import {nodeDatabase} from "@/lib/platform/node/database";
import {publishReviewedItems} from "./publication";
import {recordReviewedAnswerMemoriesIn} from '@/lib/coaching/learning-memory';

export const prompt = (name: string) => fs.readFileSync(path.join(process.env.ROASTDUCK_PROMPT_ROOT||path.join(process.cwd(), "pipeline/prompts"), name), "utf8");

/** Mock 只用于隔离自动化，不是 Reviewer 真实证据。 */
export const fourStepMockResolver: typeof runtimeAnswerMockResolver = (request) => {
  if (/^four_step_(diagnosis|selection|material|review)_v[2345]$/.test(request.schemaName)) return selectionMockResolver(request);
  if (request.schemaName === "four_step_material_review_v1") {
    const input = JSON.parse(request.input) as { candidate: SpeakingAttemptAnalysis };
    return { approved: true, reasonZh: "隔离测试夹具审核", rows: input.candidate.learningMaterials.map((_, index) => ({ index, approved: true, reasonZh: `测试行 ${index} 的语义对应` })) };
  }
  if (request.schemaName === "four_step_judge_v1") {
    const input = JSON.parse(request.input) as { input: string; answer: string };
    const correct = normalizeExpression(input.input) === normalizeExpression(input.answer);
    return { verdict: correct ? "correct" : "incorrect", meaningPreserved: correct, feedbackZh: correct ? "本次表达意思一致。" : "这次尚未表达目标意思，请核对后重试。" };
  }
  return runtimeAnswerMockResolver(request);
};

export async function getMaterial(id: string) {
  const db = await getDbReady();
  const [row] = await db.all<MaterialRow>(sql`SELECT * FROM practice_materials WHERE id=${id}`);
  if (!row) throw new TrainingError("学习材料不存在", 404, "material_not_found");
  return row;
}

export async function prepareMaterial(input: MaterialInput) {
  return withDbTransaction(async () => {
  const db = await getDbReady();
  const snapshot = JSON.stringify(input);
  const inputHash = hash("four-step-material-evidence-v2", snapshot);
  const id = `pm_${hash(input.sourceType, input.sourceId, inputHash).slice(0, 24)}`;
  const now = new Date().toISOString();
  await db.run(sql`INSERT INTO practice_materials (id,source_type,source_id,question_id,input_json,input_hash,created_at,updated_at,contract_version)
    VALUES (${id},${input.sourceType},${input.sourceId},${input.question?.id ?? null},${snapshot},${inputHash},${now},${now},'evidence_v2') ON CONFLICT DO NOTHING`);
  return getMaterial(id);
  });
}


/** 新材料四阶段独立请求，旧快照保留两阶段兼容；网络不持有事务。 */
export async function processMaterial(id: string) {
  let material = await getMaterial(id);
  if (material.status === "ready") return material;
  if((JSON.parse(material.input_json) as MaterialInput).offlineRevision)throw new TrainingError('离线修订只能经独立审核后的本机发布入口继续',409,'offline_revision_required');
  const token = randomUUID();
  const now = new Date().toISOString();
  const lease = new Date(Date.now() + 10 * 60_000).toISOString();
  const claimed = await withDbTransaction(async () => {
    const tx=await getDbReady();
    // 同一短事务内更新并确认租约，避免把认领与确认拆到不同连接。
    await tx.run(sql`UPDATE practice_materials SET lease_token=${token},lease_until=${lease},status='generating',updated_at=${now}
      WHERE id=${id} AND status!='ready' AND (lease_until IS NULL OR lease_until<${now})`);
    return (await getMaterial(id)).lease_token===token;
  });
  if (!claimed) return getMaterial(id);
  const input = JSON.parse(material.input_json) as MaterialInput;
  const version = material.contract_version === "evidence_v2" ? "four-step-evidence-v2" : "four-step-analysis-v1";
  const job = await withDbTransaction(() => enqueueAiJob({ kind: "four_step_material", targetType: "practice_material", targetId: id, payload: input, promptVersion: version, schemaVersion: version }));
  const owned = (work: () => Promise<unknown>) => withDbTransaction(async () => {
    if ((await getMaterial(id)).lease_token !== token) throw new TrainingError("材料任务已过期", 409, "material_lease_lost");
    return work();
  });
  try {
    await owned(async () => {
      const tx = await getDbReady();
      await tx.run(sql`UPDATE practice_materials SET job_id=${job.id} WHERE id=${id}`);
      await tx.update(aiJobs).set({ status: "generating", lastErrorCode: null }).where(eq(aiJobs.id, job.id));
      if (input.sourceType === "ielts_practice") await tx.update(speakingQuestionAttempts).set({ status: "processing" }).where(eq(speakingQuestionAttempts.id, input.sourceId));
    });
    const provider = createAiProvider({ mockResolver: fourStepMockResolver });
    let analysis: SpeakingAttemptAnalysis;
    let generatorRunId = material.generator_run_id;
    let reviewed: { runId:string; data:{approved:boolean;reasonZh:string;rows:Array<{index:number;approved:boolean;reasonZh:string}>} };
    if (material.contract_version === "evidence_v2") {
      const generated = await runDiagnosticPipeline(material,job.id,provider,owned);
      analysis = speakingAttemptAnalysisSchema.parse(generated.analysis);
      generatorRunId = generated.generatorRunId;
      reviewed = generated.reviewed;
      validateMaterial(analysis,input);
      await owned(async () => {
        const tx=await getDbReady();
        await tx.run(sql`INSERT INTO practice_material_revisions(material_id,generator_run_id,analysis_json,reviewer_run_id,review_json,created_at)
          VALUES(${id},${generatorRunId},${JSON.stringify(analysis)},${reviewed.runId},${JSON.stringify(reviewed.data)},${new Date().toISOString()}) ON CONFLICT DO NOTHING`);
        await tx.run(sql`UPDATE practice_materials SET analysis_json=${JSON.stringify(analysis)},generator_run_id=${generatorRunId},reviewer_run_id=${reviewed.runId},review_json=${JSON.stringify(reviewed.data)} WHERE id=${id}`);
      });
    } else {
    const regenerate = Boolean(material.error_code?.startsWith("material_") && material.error_code !== "material_service_failed");
    if (generatorRunId && !regenerate) analysis = speakingAttemptAnalysisSchema.parse(JSON.parse(material.analysis_json));
    else {
      const generated = await executeAuditedAiCall(provider, job.id, {
        role: "speaking_practice_analysis", instructions: prompt("four_step_analysis.generator.v1.md"), input: material.input_json,
        schema: speakingAttemptAnalysisSchema, schemaName: "speaking_attempt_analysis_v1", promptVersion: "four-step-analysis-v1", schemaVersion: "speaking-attempt-analysis-v1", idempotencyKey: `generate:${id}`,
      }, { maxAttempts: 1 });
      analysis = generated.data;
      // 没有 Gap 的资料行只是建议，不为其制造训练任务。
      if (!analysis.gaps.length && !analysis.learningItems.length) analysis = { ...analysis, learningMaterials: [], clozeItems: [] };
      generatorRunId = generated.runId;
      await owned(async () => {
        const tx = await getDbReady();
        await tx.run(sql`INSERT INTO practice_material_revisions (material_id,generator_run_id,analysis_json,created_at) VALUES (${id},${generatorRunId},${JSON.stringify(analysis)},${new Date().toISOString()})`);
        await tx.run(sql`UPDATE practice_materials SET analysis_json=${JSON.stringify(analysis)},generator_run_id=${generatorRunId},reviewer_run_id=NULL,review_json='{}',status='reviewing' WHERE id=${id}`);
      });
    }
    validateMaterial(analysis);
    await owned(async () => (await getDbReady()).update(aiJobs).set({ status: "reviewing" }).where(eq(aiJobs.id, job.id)));
    reviewed = await executeAuditedAiCall(provider, job.id, {
      role: "reviewer", instructions: prompt("four_step_material.reviewer.v1.md"), input: JSON.stringify({ source: input, candidate: analysis }),
      schema: materialReviewSchema, schemaName: "four_step_material_review_v1", promptVersion: "four-step-material-review-v1", schemaVersion: "four-step-material-review-v1", idempotencyKey: `review:${id}:${generatorRunId}`,
    }, { maxAttempts: 1 });
    const review = reviewed.data;
    await owned(async () => {
      const tx = await getDbReady();
      await tx.run(sql`UPDATE practice_materials SET review_json=${JSON.stringify(review)},reviewer_run_id=${reviewed.runId} WHERE id=${id}`);
      await tx.run(sql`UPDATE practice_material_revisions SET reviewer_run_id=${reviewed.runId},review_json=${JSON.stringify(review)} WHERE material_id=${id} AND generator_run_id=${generatorRunId}`);
    });
    if (!review.approved || review.rows.length !== analysis.learningMaterials.length || analysis.learningMaterials.some((_, i) => review.rows.filter((r) => r.index === i && r.approved).length !== 1)) {
      throw new TrainingError("材料审核未通过，请查看原因后重新处理", 422, "material_review_rejected");
    }
    }
    await withDbTransaction(async () => {
      const tx = await getDbReady();
      const current = await getMaterial(id);
      if (current.lease_token !== token) throw new TrainingError("材料处理已由其他任务接手");
      await publishMaterialItems(material, input, analysis);
      await tx.update(aiJobs).set({ status: "completed", updatedAt: new Date().toISOString() }).where(eq(aiJobs.id, job.id));
    });
  } catch (error) {
    const code = error instanceof TrainingError ? error.code : error instanceof AiProviderError ? `material_ai_${error.code}` : "material_service_failed";
    await withDbTransaction(async () => {
      const tx = await getDbReady();
      const current = await getMaterial(id);
      if (current.lease_token !== token) return;
      await tx.run(sql`UPDATE practice_materials SET status='failed',lease_token=NULL,lease_until=NULL,error_code=${code},updated_at=${new Date().toISOString()} WHERE id=${id}`);
      await tx.run(sql`UPDATE practice_material_revisions SET error_code=${code} WHERE material_id=${id} AND generator_run_id=${current.generator_run_id}`);
      await tx.update(aiJobs).set({ status: error instanceof AiProviderError&&!error.retryable?'terminal_failure':'retryable_failure', lastErrorCode: code }).where(eq(aiJobs.id, job.id));
      if (input.sourceType === "ielts_practice") await tx.update(speakingQuestionAttempts).set({ status: "failed" }).where(eq(speakingQuestionAttempts.id, input.sourceId));
    });
  }
  material = await getMaterial(id);
  return material;
}

/** 调用方必须已审核且持有短事务；离线与 Runtime 共享发布，不共享 AI 账单。 */
export async function publishMaterialItems(material:MaterialRow,input:MaterialInput,analysis:SpeakingAttemptAnalysis){
  return nodeDatabase.write(async tx=>{const now=new Date();await publishReviewedItems(tx,material,input,analysis,now);await recordReviewedAnswerMemoriesIn(tx,material.id,now,{allowMock:process.env.NODE_ENV==='test'||process.env.AI_PROVIDER==='mock'&&(process.env.ROASTDUCK_DB??'').includes('test-results')});});
}
