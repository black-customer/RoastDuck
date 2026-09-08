import { sql } from "drizzle-orm";
import { getDbReady } from "@db/client";
import { loadLearningContent, type LearningContent } from "./content";

export interface RetrievalScene {
  id: string;
  kind: "common_usage" | "question_repair";
  settingZh: string;
  relationshipZh: string;
  purposeZh: string;
  promptZh: string;
  targetTextEn: string;
  targetTextZh: string;
  lines: Array<{ id: string; speaker: string; textEn: string; textZh: string; target: boolean }>;
}

export interface RetrievalLearningContent {
  base: LearningContent;
  learningUnitId: string;
  gap: {
    id: string;
    clusterId: string | null;
    evidenceText: string;
    intentZh: string;
    recommendedExpression: string;
    explanationZh: string;
  };
  question: { id: string; textEn: string; textZh: string; part: number };
  originalScene: RetrievalScene;
  transferScene: RetrievalScene;
}

async function loadScene(options: {
  chunkId: string;
  questionId: string;
  gapId: string;
  kind: "common_usage" | "question_repair";
}): Promise<RetrievalScene | null> {
  const db = await getDbReady();
  const scenes = await db.all<{
    id: string;
    settingZh: string;
    relationshipZh: string;
    purposeZh: string;
  }>(sql`
    SELECT id, setting_zh AS settingZh, relationship_zh AS relationshipZh, purpose_zh AS purposeZh
    FROM learning_scenarios
    WHERE chunk_id=${options.chunkId} AND scenario_kind=${options.kind} AND review_decision='approved'
      AND (question_id=${options.questionId} OR question_id IS NULL)
      AND (gap_id=${options.gapId} OR gap_id IS NULL)
    ORDER BY CASE WHEN question_id=${options.questionId} THEN 0 ELSE 1 END,
      CASE WHEN gap_id=${options.gapId} THEN 0 ELSE 1 END, updated_at DESC, id
    LIMIT 1`);
  const scene = scenes[0];
  if (!scene) return null;
  const lines = await db.all<{ id: string; speaker: string; textEn: string; textZh: string; target: number; annotationStatus: string }>(sql`
    SELECT id,speaker,text_en AS textEn,text_zh AS textZh,is_target AS target,annotation_status AS annotationStatus
    FROM learning_scenario_lines WHERE scenario_id=${scene.id} ORDER BY line_order`);
  if (lines.length < 2 || lines.length > 4 || lines.some((line) => line.annotationStatus !== "complete")) return null;
  const target = lines.find((line) => line.target === 1) ?? lines.at(-1);
  if (!target?.textEn.trim() || !target.textZh.trim()) return null;
  return {
    id: scene.id,
    kind: options.kind,
    settingZh: scene.settingZh,
    relationshipZh: scene.relationshipZh,
    purposeZh: scene.purposeZh,
    promptZh: target.textZh,
    targetTextEn: target.textEn,
    targetTextZh: target.textZh,
    lines: lines.map((line) => ({ ...line, target: line.target === 1 })),
  };
}

/** 只有已发布、双语境齐全的个人学习项才能进入 V3。 */
export async function loadRetrievalLearningContent(chunkId: string, questionId: string | null): Promise<RetrievalLearningContent | null> {
  if (!questionId) return null;
  const db = await getDbReady();
  const rows = await db.all<{
    learningUnitId: string;
    gapId: string;
    clusterId: string | null;
    evidenceText: string;
    intentZh: string;
    recommendedExpression: string;
    explanationZh: string;
    questionId: string;
    questionEn: string;
    questionZh: string;
    part: number;
  }>(sql`
    SELECT u.id AS learningUnitId,g.id AS gapId,g.cluster_id AS clusterId,
      g.evidence_text AS evidenceText,g.intent_zh AS intentZh,
      g.recommended_expression AS recommendedExpression,g.explanation_zh AS explanationZh,
      q.id AS questionId,q.text AS questionEn,q.text_zh AS questionZh,q.part
    FROM question_learning_units u
    JOIN answer_gaps g ON g.id=u.gap_id
    JOIN questions q ON q.id=u.question_id
    WHERE u.chunk_id=${chunkId} AND u.question_id=${questionId} AND u.status='active'
      AND g.status IN ('open','learning','resolved') AND g.learning_fit=1
      AND g.reviewer_decision IN ('approved','edited')
    ORDER BY u.priority DESC,u.created_at,u.id LIMIT 1`);
  const item = rows[0];
  if (!item) return null;
  const [base, originalScene, transferScene] = await Promise.all([
    loadLearningContent(chunkId, questionId),
    loadScene({ chunkId, questionId, gapId: item.gapId, kind: "question_repair" }),
    loadScene({ chunkId, questionId, gapId: item.gapId, kind: "common_usage" }),
  ]);
  if (!base || !originalScene || !transferScene) return null;
  return {
    base,
    learningUnitId: item.learningUnitId,
    gap: {
      id: item.gapId,
      clusterId: item.clusterId,
      evidenceText: item.evidenceText,
      intentZh: item.intentZh || originalScene.targetTextZh,
      recommendedExpression: item.recommendedExpression || base.chunk.display,
      explanationZh: item.explanationZh,
    },
    question: { id: item.questionId, textEn: item.questionEn, textZh: item.questionZh, part: item.part },
    originalScene,
    transferScene,
  };
}
