import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { desc, eq, sql } from "drizzle-orm";
import { getDbReady, withDbTransaction } from "@db/client";
import {
  questions,
  speakingQuestionAttempts,
} from "@db/schema";
import { createAiProvider } from "@/lib/ai/provider-factory";
import { runtimeAnswerMockResolver } from "@/lib/answers/runtime-mock";
import { prepareMaterial, processMaterial } from "@/lib/four-step/materials";
import { hash } from "@/lib/four-step/shared";
import {SPOKEN_STYLE_VERSION} from '@/lib/four-step/stage-contracts';
import { materialFailureMessage } from "@/lib/four-step/material-status";
import { executeAuditedAiCall } from "@/lib/ai/job-service";
import {
  speakingAttemptAnalysisSchema,
  translationEvaluationSchema,
  type CreateAttemptInput,
  type SpeakingAttemptAnalysis,
  type TranslationEvaluation,
} from "./schemas";

function stableId(prefix: string, ...parts: string[]) {
  return `${prefix}_${createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 24)}`;
}

export function normalizeKey(text: string): string {
  return text
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[.,/#!$%^&*;:{}=\-_`~()?'"]/g, "")
    .replace(/\s+/g, " ");
}

function readPrompt(filename: string): string {
  return fs.readFileSync(path.join(process.cwd(), "pipeline", "prompts", filename), "utf8");
}

export class SpeakingPracticeError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
  }
}

export interface AttemptView {
  id: string;
  questionId: string;
  mode: "practice" | "exam_style";
  answerText: string;
  intendedMeaningZh: string;
  naturalVersion: string;
  gapCount: number;
  status: string;
  materialId?: string;
  materialContractVersion?: string;
  materialStatus?: string;
  materialError?: string;
  processingStage?: string;
  analysis: SpeakingAttemptAnalysis;
  createdAt: string;
  updatedAt: string;
}

/** 先持久化原回答；相同请求键不重复创建 Attempt。 */
export async function prepareSpeakingAttempt(input: CreateAttemptInput): Promise<AttemptView> {
  const db = await getDbReady();
  const [question] = await db.select().from(questions).where(eq(questions.id, input.questionId)).limit(1);
  if (!question) throw new SpeakingPracticeError("题目不存在", 404, "question_not_found");
  const requestId = input.clientRequestId ?? randomUUID();
  const inputHash = hash(input.questionId, input.mode, input.answerText, input.intendedMeaningZh);
  const attemptId = await withDbTransaction(async () => {
    const tx = await getDbReady();
    const [prior] = await tx.all<{ input_hash: string; attempt_id: string }>(sql`SELECT * FROM practice_submissions WHERE request_id=${requestId}`);
    if (prior) {
      if (prior.input_hash !== inputHash) throw new SpeakingPracticeError("相同请求编号包含不同回答", 409, "submission_conflict");
      return prior.attempt_id;
    }
    const id = `sqa_${randomUUID().replaceAll("-", "")}`;
    await tx.insert(speakingQuestionAttempts).values({ id, questionId: input.questionId, mode: input.mode, answerText: input.answerText, intendedMeaningZh: input.intendedMeaningZh, status: "processing" });
    await tx.run(sql`INSERT INTO practice_submissions (request_id,input_hash,attempt_id) VALUES (${requestId},${inputHash},${id})`);
    return id;
  });
  await prepareMaterial({ sourceType: "ielts_practice", sourceId: attemptId, question: { id: question.id, textEn: question.text, textZh: question.textZh, part: question.part }, mode: input.mode, actualAnswer: input.answerText, intendedMeaningZh: input.intendedMeaningZh,spokenStyleVersion:SPOKEN_STYLE_VERSION });
  return (await getSpeakingAttempt(attemptId))!;
}

/** 显式处理／重试；GET 不启动任务。 */
export async function prepareAttemptReanalysis(attemptId: string) {
  return withDbTransaction(async () => {
    const db = await getDbReady();
    const attempt = await getSpeakingAttempt(attemptId);
    if (!attempt) throw new SpeakingPracticeError("回答不存在",404,"attempt_not_found");
    const [question] = await db.select().from(questions).where(eq(questions.id,attempt.questionId)).limit(1);
    if (!question) throw new SpeakingPracticeError("原题目已移除，不能凭空生成题意",409,"question_removed");
    // 老版任务正在持有租约时不得启动会覆盖同一回答的并行新版任务。
    const [running] = await db.all(sql`SELECT id FROM practice_materials WHERE source_type='ielts_practice' AND source_id=${attemptId} AND contract_version!='evidence_v2' AND lease_until>${new Date().toISOString()}`);
    if (running) throw new SpeakingPracticeError("原分析仍在运行，请稍后再按新标准分析",409,"legacy_analysis_running");
    await db.run(sql`INSERT INTO practice_legacy_analyses(attempt_id,analysis_json,natural_version,archived_at)
      SELECT id,analysis_json,natural_version,${new Date().toISOString()} FROM speaking_question_attempts WHERE id=${attemptId} AND analysis_json!='{}' ON CONFLICT DO NOTHING`);
    const [previous]=await db.all<{input_json:string}>(sql`SELECT input_json FROM practice_materials WHERE source_type='ielts_practice' AND source_id=${attemptId} AND contract_version='evidence_v2' ORDER BY created_at DESC,id DESC LIMIT 1`);
    // Recover the exact saved version, including mixed-input and spoken-style markers.
    const material = await prepareMaterial(previous?JSON.parse(previous.input_json):{sourceType:"ielts_practice",sourceId:attemptId,question:{id:question.id,textEn:question.text,textZh:question.textZh,part:question.part},mode:attempt.mode,actualAnswer:attempt.answerText,intendedMeaningZh:attempt.intendedMeaningZh,spokenStyleVersion:SPOKEN_STYLE_VERSION});
    if (material.status!=="ready") await db.update(speakingQuestionAttempts).set({status:"processing"}).where(eq(speakingQuestionAttempts.id,attemptId));
    return (await getSpeakingAttempt(attemptId))!;
  });
}

export async function processSpeakingAttempt(attemptId: string) {
  const db = await getDbReady();
  const [material] = await db.all<{ id: string }>(sql`SELECT id FROM practice_materials WHERE source_type='ielts_practice' AND source_id=${attemptId} ORDER BY (contract_version='evidence_v2') DESC,created_at DESC,id DESC LIMIT 1`);
  if (!material) throw new SpeakingPracticeError("此历史回答的新版材料尚未编译", 409, "material_missing");
  await processMaterial(material.id);
  const {webCompanion}=await import('@/lib/app-services/web');
  await webCompanion().comparison.process(attemptId).catch(()=>undefined);
  return getSpeakingAttempt(attemptId);
}

/** 服务层同步便利入口；HTTP 使用 prepare + 后台处理。 */
export async function createSpeakingAttempt(input: CreateAttemptInput): Promise<AttemptView> {
  const saved = await prepareSpeakingAttempt(input);
  return (await processSpeakingAttempt(saved.id))!;
}

export async function getSpeakingAttempt(attemptId: string): Promise<AttemptView | null> {
  const db = await getDbReady();
  const [row] = await db
    .select()
    .from(speakingQuestionAttempts)
    .where(eq(speakingQuestionAttempts.id, attemptId))
    .limit(1);

  if (!row) return null;

  let parsedAnalysis: SpeakingAttemptAnalysis;
  try {
    parsedAnalysis = speakingAttemptAnalysisSchema.parse(JSON.parse(row.analysisJson));
  } catch {
    parsedAnalysis = {
      naturalVersion: row.naturalVersion,
      gaps: [],
      corrections: [],
      learningItems: [],
      learningMaterials: [],
      gapCount: row.gapCount,
      clozeItems: [],
      examFeedback: null,
    };
  }

  const [material] = await db.all<{ id: string; contract_version:string; status:string;error_code:string|null;job_id:string|null;lease_until:string|null;updated_at:string }>(sql`SELECT id,contract_version,status,error_code,job_id,lease_until,updated_at FROM practice_materials WHERE source_type='ielts_practice' AND source_id=${row.id} ORDER BY (contract_version='evidence_v2') DESC,created_at DESC,id DESC LIMIT 1`);
  const [run]=material?.job_id?await db.all<{error_code:string|null;role:string}>(sql`SELECT error_code,role FROM ai_runs WHERE job_id=${material.job_id} ORDER BY created_at DESC LIMIT 1`):[];
  const stageNames:Record<string,string>={gap_generator:"对照中英文原意",gap_reviewer:"核对真实表达缺口",learning_material_compiler:"编排四列材料",reviewer:"核对材料与原文"};
  const stale=row.status==="processing"&&material&&material.status!=="ready"&&(
    material.lease_until?Date.parse(material.lease_until)<Date.now():Date.now()-Date.parse(material.updated_at)>10*60_000
  );
  return {
    materialId: material?.id,
    materialContractVersion: material?.contract_version,
    materialStatus:material?.status,
    materialError:stale?"上次处理已中断，原回答已保存。可以恢复处理。":material?.status==="failed"?materialFailureMessage(material.error_code==="material_service_failed"?run?.error_code:material.error_code):undefined,
    processingStage:run?stageNames[run.role]:undefined,
    id: row.id,
    questionId: row.questionId,
    mode: row.mode as "practice" | "exam_style",
    answerText: row.answerText,
    intendedMeaningZh: row.intendedMeaningZh,
    naturalVersion: row.naturalVersion,
    gapCount: row.gapCount,
    status: stale?"failed":row.status,
    analysis: parsedAnalysis,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listQuestionAttempts(questionId: string) {
  const db = await getDbReady();
  const rows = await db
    .select({
      id: speakingQuestionAttempts.id,
      questionId: speakingQuestionAttempts.questionId,
      mode: speakingQuestionAttempts.mode,
      gapCount: speakingQuestionAttempts.gapCount,
      naturalVersion: speakingQuestionAttempts.naturalVersion,
      createdAt: speakingQuestionAttempts.createdAt,
    })
    .from(speakingQuestionAttempts)
    .where(eq(speakingQuestionAttempts.questionId, questionId))
    .orderBy(sql`julianday(${speakingQuestionAttempts.createdAt}) DESC`,sql`COALESCE((SELECT pa.source_order FROM practice_answer_sources mapped JOIN personal_answers pa ON pa.id=mapped.answer_id WHERE mapped.attempt_id=${speakingQuestionAttempts.id}),0) DESC`,desc(speakingQuestionAttempts.id));

  return rows.map((r, index) => ({
    ...r,
    attemptNumber: rows.length - index,
  }));
}

export async function evaluateTranslation(
  attemptId: string,
  userEnglish: string,
): Promise<TranslationEvaluation> {
  const attempt = await getSpeakingAttempt(attemptId);
  if (!attempt) {
    throw new SpeakingPracticeError("答题记录不存在", 404, "attempt_not_found");
  }

  const promptText = readPrompt("speaking_translation_eval.judge.v1.md");
  const aiProvider = createAiProvider({ mockResolver: runtimeAnswerMockResolver });

  const aiInput = JSON.stringify({
    intendedMeaningZh: attempt.intendedMeaningZh,
    naturalReference: attempt.naturalVersion,
    userAttemptEnglish: userEnglish,
  });

  const aiResult = await executeAuditedAiCall<TranslationEvaluation>(aiProvider, null, {
    role: "translation_evaluator",
    instructions: promptText,
    input: aiInput,
    schema: translationEvaluationSchema,
    schemaName: "speaking_translation_eval_v1",
    promptVersion: "speaking-translation-eval-v1",
    schemaVersion: "speaking-translation-eval-v1",
    idempotencyKey: stableId("eval_trans", attemptId, userEnglish),
  });

  return aiResult.data;
}
