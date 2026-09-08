import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDbReady } from "@db/client";
import {
  answerGaps,
  chunks,
  learningInboxItems,
  learningScenarioLines,
  learningScenarios,
  personalAnswerSentences,
  questionLearningUnits,
  textAnnotations,
} from "@db/schema";
import { AiProviderError } from "@/lib/ai/errors";
import { enqueueAiJob, runReviewedAiJob } from "@/lib/ai/job-service";
import { createAiProvider } from "@/lib/ai/provider-factory";
import { applyPersonalChunks } from "@/lib/answers/processor";
import { runtimeAnswerMockResolver } from "@/lib/answers/runtime-mock";
import { annotateRuntimeEnglish, assertRuntimeGlossaryCoverage } from "./runtime-annotations";
import {
  learningMaterialGenerationSchema,
  learningMaterialReviewSchema,
  type LearningMaterialCandidate,
  type LearningMaterialGeneration,
  type LearningMaterialReview,
  type LearningScenarioCandidate,
} from "./schemas";

function stableId(prefix: string, ...parts: string[]) {
  return `${prefix}_${createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 24)}`;
}

function canonicalize(value: string) {
  return value.normalize("NFKC").toLowerCase().replace(/[“”‘’]/g, "'").replace(/[^a-z0-9'\s-]/g, " ").replace(/\s+/g, " ").trim();
}

function readPrompt(filename: string) {
  return fs.readFileSync(path.join(process.cwd(), "pipeline", "prompts", filename), "utf8");
}

function validateScenario(material: LearningMaterialCandidate, scenario: LearningScenarioCandidate, kind: string) {
  const targets = scenario.lines.filter((line) => line.target);
  if (targets.length !== 1) throw new AiProviderError(`${kind} 必须恰好有一个目标行`, "invalid_output", false);
  if (!canonicalize(targets[0].textEn).includes(canonicalize(material.chunk.displayChunk))) {
    throw new AiProviderError(`${kind} 目标行没有包含主 Chunk`, "invalid_output", false);
  }
}

function validateReview(input: {
  eligibleGapIds: Set<string>;
  sentences: Map<number, { textEn: string }>;
  generated: LearningMaterialGeneration;
  review: LearningMaterialReview;
}) {
  const generatedIds = new Set(input.generated.materials.map((item) => item.gapId));
  const reviewedIds = new Set(input.review.items.map((item) => item.gapId));
  if (generatedIds.size !== input.generated.materials.length || reviewedIds.size !== input.review.items.length) {
    throw new AiProviderError("学习材料 gapId 必须唯一", "invalid_output", false);
  }
  if (generatedIds.size !== reviewedIds.size || [...generatedIds].some((id) => !reviewedIds.has(id))) {
    throw new AiProviderError("Scenario Reviewer 必须逐项裁决全部材料", "invalid_output", false);
  }
  for (const item of input.review.items) {
    if (item.material.gapId !== item.gapId) throw new AiProviderError("学习材料返回了不一致的 Gap", "invalid_output", false);
    if (item.verdict === "rejected") continue;
    if (!input.eligibleGapIds.has(item.gapId)) throw new AiProviderError("学习材料引用了未批准的 Gap", "invalid_output", false);
    const sentence = input.sentences.get(item.material.chunk.sentenceIndex);
    if (!sentence || canonicalize(sentence.textEn) !== canonicalize(item.material.chunk.exampleEn)) {
      throw new AiProviderError("个人 Chunk 例句必须等于已确认句子", "invalid_output", false);
    }
    if (!canonicalize(item.material.chunk.exampleEn).includes(canonicalize(item.material.chunk.displayChunk))) {
      throw new AiProviderError("主 Chunk 必须是已确认句子的连续子串", "invalid_output", false);
    }
    validateScenario(item.material, item.material.commonUsage, "common_usage");
    validateScenario(item.material, item.material.questionRepair, "question_repair");
    assertRuntimeGlossaryCoverage([
      item.material.chunk.exampleEn,
      ...item.material.commonUsage.lines.map((line) => line.textEn),
      ...item.material.questionRepair.lines.map((line) => line.textEn),
    ], item.material.glossary);
  }
}

async function findChunkId(canonicalChunk: string) {
  const db = await getDbReady();
  const [chunk] = await db.select({ id: chunks.id }).from(chunks)
    .where(sql`${chunks.canonicalChunk} = ${canonicalize(canonicalChunk)} AND ${chunks.qualityStatus} IN ('approved','edited')`)
    .orderBy(sql`CASE WHEN ${chunks.bookId} = 'book_personal_ielts_answers' THEN 1 ELSE 0 END`, chunks.id).limit(1);
  if (!chunk) throw new Error(`审核后的个人 Chunk 未写入：${canonicalChunk}`);
  return chunk.id;
}

async function applyScenario(input: {
  chunkId: string;
  questionId: string;
  gapId: string;
  kind: "common_usage" | "question_repair";
  scenario: LearningScenarioCandidate;
  glossary: LearningMaterialCandidate["glossary"];
  reviewerRunId: string;
  reviewReason: string;
}) {
  const db = await getDbReady();
  const scenarioId = stableId("learning_scenario", input.chunkId, input.questionId, input.gapId, input.kind);
  const oldLines = await db.select({ id: learningScenarioLines.id }).from(learningScenarioLines).where(eq(learningScenarioLines.scenarioId, scenarioId));
  if (oldLines.length) {
    const ids = oldLines.map((line) => line.id);
    await db.delete(textAnnotations).where(and(eq(textAnnotations.contentType, "scenario_line"), inArray(textAnnotations.contentId, ids)));
    await db.delete(learningScenarioLines).where(eq(learningScenarioLines.scenarioId, scenarioId));
  }
  const now = new Date().toISOString();
  await db.insert(learningScenarios).values({
    id: scenarioId,
    chunkId: input.chunkId,
    questionId: input.questionId,
    gapId: input.gapId,
    scenarioKind: input.kind,
    settingZh: input.scenario.settingZh,
    relationshipZh: input.scenario.relationshipZh,
    purposeZh: input.scenario.purposeZh,
    register: input.scenario.register,
    accent: "en-US",
    isGenerated: true,
    reviewDecision: "approved",
    reviewReason: input.reviewReason,
    reviewerRunId: input.reviewerRunId,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: learningScenarios.id,
    set: {
      settingZh: input.scenario.settingZh,
      relationshipZh: input.scenario.relationshipZh,
      purposeZh: input.scenario.purposeZh,
      register: input.scenario.register,
      accent: "en-US",
      reviewDecision: "approved",
      reviewReason: input.reviewReason,
      reviewerRunId: input.reviewerRunId,
      updatedAt: now,
    },
  });
  for (const [index, line] of input.scenario.lines.entries()) {
    const lineId = stableId("scenario_line", scenarioId, String(index));
    await db.insert(learningScenarioLines).values({
      id: lineId,
      scenarioId,
      lineOrder: index,
      speaker: line.speaker,
      textEn: line.textEn,
      textZh: line.textZh,
      isTarget: line.target,
      annotationStatus: "pending",
      createdAt: now,
    });
    await annotateRuntimeEnglish({ contentType: "scenario_line", contentId: lineId, text: line.textEn, glossary: input.glossary });
    await db.update(learningScenarioLines).set({ annotationStatus: "complete" }).where(eq(learningScenarioLines.id, lineId));
  }
  return scenarioId;
}

export async function runSpeakingMaterialPipeline(input: {
  answerId: string;
  answerVersionId: string;
  questionId: string;
  question: { part: number; textEn: string; textZh: string; topicZh: string; topicEn: string };
  completionEventId: string;
}) {
  const db = await getDbReady();
  const [gaps, sentences] = await Promise.all([
    db.select().from(answerGaps).where(and(
      eq(answerGaps.answerId, input.answerId),
      eq(answerGaps.learningFit, true),
      inArray(answerGaps.reviewerDecision, ["approved", "edited"]),
      eq(answerGaps.status, "open"),
    )),
    db.select().from(personalAnswerSentences).where(eq(personalAnswerSentences.answerVersionId, input.answerVersionId)).orderBy(personalAnswerSentences.sentenceIndex),
  ]);
  if (!gaps.length) return { compiled: 0, skipped: 0 };
  const job = await enqueueAiJob({
    kind: "speaking_learning_material_pipeline",
    targetType: "answer_version",
    targetId: input.answerVersionId,
    payload: { answerId: input.answerId, gapIds: gaps.map((gap) => gap.id), completionEventId: input.completionEventId },
    promptVersion: "speaking-material-compiler-v1+speaking-scenario-reviewer-v1",
    schemaVersion: "speaking-learning-material-v1",
  });
  if (job.status === "completed") {
    const [{ total }] = await db.select({ total: sql<number>`COUNT(*)` }).from(questionLearningUnits)
      .where(and(eq(questionLearningUnits.questionId, input.questionId), eq(questionLearningUnits.source, "runtime_answer_gap"), eq(questionLearningUnits.status, "active")));
    return { compiled: Number(total), skipped: 0 };
  }
  const provider = createAiProvider({ mockResolver: runtimeAnswerMockResolver });
  let compiled = 0;
  let skipped = 0;
  await runReviewedAiJob({
    jobId: job.id,
    provider,
    generatorRole: "learning_material_compiler",
    reviewerRole: "scenario_reviewer",
    generator: {
      role: "learning_material_compiler",
      instructions: readPrompt("speaking_material.compiler.v1.md"),
      input: JSON.stringify({
        question: input.question,
        approvedGaps: gaps,
        confirmedSentences: sentences.map((sentence) => ({ index: sentence.sentenceIndex, textEn: sentence.textEn, textZh: sentence.textZh })),
      }),
      schema: learningMaterialGenerationSchema,
      schemaName: "speaking_learning_material_generator_v1",
      promptVersion: "speaking-material-compiler-v1",
      schemaVersion: "speaking-learning-material-v1",
      idempotencyKey: job.idempotencyKey,
    },
    reviewer: (generated) => ({
      role: "scenario_reviewer",
      instructions: readPrompt("speaking_scenario.reviewer.v1.md"),
      input: JSON.stringify({
        question: input.question,
        approvedGaps: gaps,
        confirmedSentences: sentences.map((sentence) => ({ index: sentence.sentenceIndex, textEn: sentence.textEn, textZh: sentence.textZh })),
        materials: generated.materials,
      }),
      schema: learningMaterialReviewSchema,
      schemaName: "speaking_learning_material_reviewer_v1",
      promptVersion: "speaking-scenario-reviewer-v1",
      schemaVersion: "speaking-learning-material-review-v1",
      idempotencyKey: `${job.idempotencyKey}_review`,
    }),
    isRejected: () => false,
    apply: async (generated, review, audit) => {
      const sentenceMap = new Map(sentences.map((sentence) => [sentence.sentenceIndex, { textEn: sentence.textEn }]));
      validateReview({ eligibleGapIds: new Set(gaps.map((gap) => gap.id)), sentences: sentenceMap, generated, review });
      const accepted = review.items.filter((item) => item.verdict !== "rejected");
      skipped = review.items.length - accepted.length + (gaps.length - generated.materials.length);
      if (!accepted.length) return;
      await applyPersonalChunks(
        input.answerId,
        input.answerVersionId,
        { candidates: accepted.map((item) => item.material.chunk) },
        { items: accepted.map((item) => ({
          sentenceIndex: item.material.chunk.sentenceIndex,
          canonicalChunk: item.material.chunk.canonicalChunk,
          verdict: item.verdict,
          reason: item.reason,
          candidate: item.material.chunk,
        })) },
        { generatorRunId: audit.generatorRunId, reviewerRunId: audit.reviewerRunId },
      );
      for (const item of accepted) {
        const chunkId = await findChunkId(item.material.chunk.canonicalChunk);
        await applyScenario({
          chunkId,
          questionId: input.questionId,
          gapId: item.gapId,
          kind: "common_usage",
          scenario: item.material.commonUsage,
          glossary: item.material.glossary,
          reviewerRunId: audit.reviewerRunId,
          reviewReason: item.reason,
        });
        await applyScenario({
          chunkId,
          questionId: input.questionId,
          gapId: item.gapId,
          kind: "question_repair",
          scenario: item.material.questionRepair,
          glossary: item.material.glossary,
          reviewerRunId: audit.reviewerRunId,
          reviewReason: item.reason,
        });
        const gap = gaps.find((candidate) => candidate.id === item.gapId)!;
        const now = new Date().toISOString();
        await db.transaction(async (tx) => {
          await tx.insert(questionLearningUnits).values({
            id: stableId("question_learning_unit", input.questionId, chunkId, "runtime_answer_gap"),
            questionId: input.questionId,
            gapId: item.gapId,
            chunkId,
            requirement: "required",
            priority: gap.impactLevel === "high" ? 90 : gap.impactLevel === "medium" ? 70 : 50,
            source: "runtime_answer_gap",
            status: "active",
            createdAt: now,
            updatedAt: now,
          }).onConflictDoNothing();
          await tx.insert(learningInboxItems).values({
            id: stableId("learning_inbox", item.gapId),
            sourceType: "answer_gap",
            sourceId: item.gapId,
            chunkId,
            surface: item.material.chunk.displayChunk,
            meaningZh: item.material.chunk.meaningZh,
            reason: item.reason,
            status: "open",
            createdAt: now,
            updatedAt: now,
          }).onConflictDoNothing();
        });
        compiled += 1;
      }
    },
  });
  return { compiled, skipped };
}
