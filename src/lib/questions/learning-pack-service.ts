import { sql } from "drizzle-orm";
import { getDbReady } from "@db/client";
import { questionActivityCte, getQuestionActivity, questionPrimaryAction, type QuestionState } from "./activity";
import { speakingAttemptAnalysisSchema, type LearningMaterialRow } from "@/lib/speaking-practice/schemas";

export interface LearningPackAnswer {
  id: string;
  attemptOrder: number;
  sourceKind: string;
  inputLanguage: string;
  status: string;
  createdAt: string;
  rawText: string;
  currentTextEn: string;
  currentTextZh: string;
  gapCount: number;
}

export interface LearningPackGap {
  id: string;
  answerId: string;
  type: string;
  evidenceText: string;
  intentZh: string;
  recommendedExpression: string;
  explanationZh: string;
  impactLevel: string;
  confidence: number;
  status: string;
  clusterId: string | null;
  occurrenceCount: number;
  learningFit: boolean;
}

export interface LearningPackUnit {
  id: string;
  gapId: string | null;
  chunkId: string;
  display: string;
  meaningZh: string;
  ipa: string;
  requirement: "required" | "optional";
  priority: number;
  firstRoundCompletedAt: string | null;
  mastery: string;
  due: boolean;
  scenarioKinds: string[];
}

export interface QuestionLearningPack {
  currentPractice?: {
    attemptId:string; materialId:string|null; status:string; completed:boolean;
    href:string; rows:LearningMaterialRow[];
    ledger:Array<{id:string;intentZh:string;status:string;reasonZh:string;evidence:string}>;
  }|null;
  questionId: string;
  answers: LearningPackAnswer[];
  gaps: LearningPackGap[];
  units: LearningPackUnit[];
  summary: {
    answerCount: number;
    gapCount: number;
    openGapCount: number;
    repeatedGapCount: number;
    requiredTotal: number;
    requiredCompleted: number;
    optionalTotal: number;
    dueCount: number;
  };
  state: QuestionState;
  reattemptCount: number;
  latestAnswerId: string | null;
  processing: { errorCode: string | null; retryHref: string | null };
  reattempts: Array<{ id: string; answerId: string; completedAt: string; rawText: string; comparisons: Array<{ comparison: string; reason: string; evidence: string; previousEvidence: string | null; expression: string }> }>;
  primaryAction: {
    label: string;
    href: string | null;
  };
}

function parseStringArray(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export async function getQuestionLearningPack(questionId: string): Promise<QuestionLearningPack | null> {
  const db = await getDbReady();
  const questionRows = await db.all<{ id: string }>(sql`SELECT id FROM questions WHERE id = ${questionId} LIMIT 1`);
  if (!questionRows[0]) return null;

  const [answerRows, gapRows, unitRows, activity, jobRows, reattemptRows, comparisonRows] = await Promise.all([
    db.all<Record<string, unknown>>(sql`
      SELECT pa.id, pa.attempt_order AS attemptOrder, pa.source_kind AS sourceKind,
        pa.input_language AS inputLanguage, pa.status, pa.created_at AS createdAt,
        pa.raw_text AS rawText,
        COALESCE(av.text_en, '') AS currentTextEn,
        COALESCE(av.text_zh, '') AS currentTextZh,
        (SELECT COUNT(*) FROM answer_gaps g WHERE g.answer_id = pa.id AND g.reviewer_decision IN ('approved','edited')) AS gapCount
      FROM personal_answers pa
      LEFT JOIN answer_versions av ON av.id = pa.current_version_id
      WHERE pa.question_id = ${questionId} AND pa.superseded_by_revision_id IS NULL
      ORDER BY COALESCE(pa.source_order, 2147483647), pa.attempt_order, pa.created_at`),
    db.all<Record<string, unknown>>(sql`
      SELECT g.id, g.answer_id AS answerId, g.gap_type AS type,
        g.evidence_text AS evidenceText, g.intent_zh AS intentZh,
        g.recommended_expression AS recommendedExpression,
        g.explanation_zh AS explanationZh, g.impact_level AS impactLevel,
        g.confidence, g.status, g.cluster_id AS clusterId,
        COALESCE(gc.occurrence_count, 1) AS occurrenceCount,
        g.learning_fit AS learningFit
      FROM answer_gaps g
      JOIN personal_answers pa ON pa.id = g.answer_id
      LEFT JOIN gap_clusters gc ON gc.id = g.cluster_id
      WHERE pa.question_id = ${questionId} AND pa.superseded_by_revision_id IS NULL
        AND g.reviewer_decision IN ('approved','edited')
      ORDER BY CASE g.impact_level WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
        g.created_at, g.id`),
    db.all<Record<string, unknown>>(sql`
      ${questionActivityCte}
      SELECT u.id, u.gap_id AS gapId, u.chunk_id AS chunkId,
        c.display_chunk AS display, c.meaning_zh AS meaningZh,
        COALESCE((SELECT p.ipa FROM chunk_pronunciations p WHERE p.chunk_id = c.id ORDER BY p.is_primary DESC, p.id LIMIT 1), '') AS ipa,
        u.requirement, u.priority, u.first_round_completed_at AS firstRoundCompletedAt,
        COALESCE(lp.mastery, 'new') AS mastery,
        CASE WHEN lp.fsrs_json IS NOT NULL
          AND datetime(COALESCE(json_extract(lp.fsrs_json, '$.due'), '9999-12-31')) <= datetime('now')
          THEN 1 ELSE 0 END AS due,
        COALESCE((SELECT json_group_array(kind) FROM (
          SELECT DISTINCT s.scenario_kind AS kind FROM learning_scenarios s
          WHERE s.chunk_id = u.chunk_id AND (s.question_id = u.question_id OR s.scenario_kind = 'common_usage')
            AND s.review_decision IN ('approved','edited')
          ORDER BY kind
        )), '[]') AS scenarioKindsJson
      FROM published_question_units u
      JOIN chunks c ON c.id = u.chunk_id
      LEFT JOIN learning_progress lp ON lp.chunk_id = u.chunk_id
      WHERE u.question_id = ${questionId}
      ORDER BY CASE u.requirement WHEN 'required' THEN 0 ELSE 1 END, u.priority DESC, c.display_chunk`),
    getQuestionActivity(questionId),
    db.all<{ errorCode: string | null; kind: string; sessionId: string | null }>(sql`
      ${questionActivityCte}
      SELECT j.last_error_code AS errorCode, j.kind,
        CASE WHEN j.target_type = 'speaking_session' THEN j.target_id
          ELSE json_extract(j.payload_json, '$.sessionId') END AS sessionId
      FROM current_question_jobs j WHERE j.question_id = ${questionId} AND j.recency = 1
        AND j.status IN ('needs_attention','retryable_failure','terminal_failure')
      ORDER BY j.updated_at DESC LIMIT 1`),
    db.all<{ id: string; answerId: string; completedAt: string; rawText: string }>(sql`
      ${questionActivityCte}
      SELECT r.id, r.answer_id AS answerId, r.completed_at AS completedAt, pa.raw_text AS rawText
      FROM completed_question_reattempts r JOIN personal_answers pa ON pa.id = r.answer_id
      WHERE r.question_id = ${questionId} GROUP BY r.answer_id ORDER BY r.completed_at DESC, r.id`),
    db.all<{ sessionId: string; comparison: string; reason: string; evidence: string; previousEvidence: string | null; expression: string }>(sql`
      SELECT m.session_id AS sessionId, l.comparison, l.reason,
        g.evidence_text AS evidence, previous.evidence_text AS previousEvidence, g.recommended_expression AS expression
      FROM speaking_gap_links l JOIN speaking_messages m ON m.id = l.message_id
      JOIN speaking_sessions ss ON ss.id = m.session_id
      JOIN answer_gaps g ON g.id = l.gap_id LEFT JOIN answer_gaps previous ON previous.id = l.related_gap_id
      WHERE ss.question_id = ${questionId} AND ss.status = 'completed'
        AND g.reviewer_decision IN ('approved','edited')
      ORDER BY m.sequence_no, l.gap_id`),
  ]);

  const answers: LearningPackAnswer[] = answerRows.map((row) => ({
    id: String(row.id),
    attemptOrder: Number(row.attemptOrder ?? 1),
    sourceKind: String(row.sourceKind ?? "runtime"),
    inputLanguage: String(row.inputLanguage),
    status: String(row.status),
    createdAt: String(row.createdAt),
    rawText: String(row.rawText),
    currentTextEn: String(row.currentTextEn),
    currentTextZh: String(row.currentTextZh),
    gapCount: Number(row.gapCount),
  }));
  const gaps: LearningPackGap[] = gapRows.map((row) => ({
    id: String(row.id),
    answerId: String(row.answerId),
    type: String(row.type),
    evidenceText: String(row.evidenceText),
    intentZh: String(row.intentZh),
    recommendedExpression: String(row.recommendedExpression),
    explanationZh: String(row.explanationZh),
    impactLevel: String(row.impactLevel),
    confidence: Number(row.confidence),
    status: String(row.status),
    clusterId: row.clusterId == null ? null : String(row.clusterId),
    occurrenceCount: Number(row.occurrenceCount),
    learningFit: Boolean(row.learningFit),
  }));
  const units: LearningPackUnit[] = unitRows.map((row) => ({
    id: String(row.id),
    gapId: row.gapId == null ? null : String(row.gapId),
    chunkId: String(row.chunkId),
    display: String(row.display),
    meaningZh: String(row.meaningZh),
    ipa: String(row.ipa),
    requirement: String(row.requirement) === "optional" ? "optional" : "required",
    priority: Number(row.priority),
    firstRoundCompletedAt: row.firstRoundCompletedAt == null ? null : String(row.firstRoundCompletedAt),
    mastery: String(row.mastery),
    due: Boolean(row.due),
    scenarioKinds: parseStringArray(row.scenarioKindsJson),
  }));

  const required = units.filter((unit) => unit.requirement === "required");
  const requiredCompleted = required.filter((unit) => unit.firstRoundCompletedAt).length;
  if (!activity) return null;
  const state = activity.state;
  const primaryAction = questionPrimaryAction(questionId, state, activity.latestAnswerId, activity.latestAnswerType);
  let currentPractice:QuestionLearningPack["currentPractice"]=null;
  if(activity.latestAnswerType==="ielts_practice"&&activity.latestAnswerId){
    const [material]=activity.currentMaterialId?await db.all<{status:string;analysis_json:string}>(sql`SELECT status,analysis_json FROM practice_materials WHERE id=${activity.currentMaterialId}`):[];
    let parsed:ReturnType<typeof speakingAttemptAnalysisSchema.safeParse>|null=null;
    try{if(material?.status==="ready")parsed=speakingAttemptAnalysisSchema.safeParse(JSON.parse(material.analysis_json));}catch{/* 坏材料不可误报可学。 */}
    const analysis=parsed?.success?parsed.data:null;
    currentPractice={attemptId:activity.latestAnswerId,materialId:activity.currentMaterialId??null,
      status:material?.status==="ready"&&!analysis?"failed":material?.status??"pending",
      completed:activity.lightTotal>0&&activity.lightSeen===activity.lightTotal,
      href:`/questions/${encodeURIComponent(questionId)}/attempts/${encodeURIComponent(activity.latestAnswerId)}`,
      rows:analysis?.learningMaterials??[],
      ledger:analysis?.evidence?.diagnosis.units.flatMap(u=>{
        const selection=analysis.evidence!.selection.units.find(s=>s.unitId===u.id)!;
        return selection.status==="natural"||selection.status==="non_answer"?[]:[{id:u.id,intentZh:u.intentZh,status:selection.status,reasonZh:selection.reasonZh,evidence:u.english.map(r=>r.text).join(" ")}];
      })??[],
    };
  }

  return {
    questionId,
    currentPractice,
    answers,
    gaps,
    units,
    summary: {
      answerCount: activity.totalAnswerCount,
      gapCount: currentPractice?.ledger.length??gaps.length,
      openGapCount: currentPractice?.ledger.length??gaps.filter((gap) => gap.status === "open").length,
      repeatedGapCount: gaps.filter((gap) => gap.occurrenceCount > 1).length,
      requiredTotal: currentPractice?activity.lightTotal:required.length,
      requiredCompleted: currentPractice?activity.lightSeen:requiredCompleted,
      optionalTotal: units.filter((unit) => unit.requirement === "optional").length,
      dueCount: activity.lightDueCount,
    },
    state,
    reattemptCount: activity.reattemptCount,
    latestAnswerId: activity.latestAnswerId,
    processing: {
      errorCode: jobRows[0]?.errorCode ?? null,
      retryHref: jobRows[0]?.sessionId
        ? `/speaking-arena?question=${encodeURIComponent(questionId)}&session=${encodeURIComponent(jobRows[0].sessionId)}`
        : activity.latestAnswerId ? primaryAction.href : null,
    },
    reattempts: reattemptRows.map((row) => ({ ...row, comparisons: comparisonRows.filter((item) => item.sessionId === row.id) })),
    primaryAction,
  };
}
