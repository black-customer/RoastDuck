import { sql } from "drizzle-orm";
import { getDbReady } from "@db/client";
import {currentReadyMaterialPredicate} from '@/lib/light-study/current-material';

export type QuestionState =
  | "unanswered"
  | "learning_incomplete"
  | "learning_completed"
  | "self_assessed"
  | "learning_paused"
  | "mastered"
  | "analysis_pending"
  | "analysis_failed"
  | "materials_pending"
  | "ready_to_learn"
  | "learning"
  | "ready_to_reattempt"
  | "reattempted";

export const QUESTION_STATE_LABELS: Record<QuestionState, string> = {
  unanswered: "未作答",
  learning_incomplete: "有新表达待学",
  learning_completed: "已过首轮（非掌握）",
  self_assessed: "已处理（含自评已掌握）",
  learning_paused: "已暂不学",
  mastered: "自评已掌握",
  analysis_pending: "分析中",
  analysis_failed: "分析失败",
  materials_pending: "材料待处理",
  ready_to_learn: "待学",
  learning: "学习中",
  ready_to_reattempt: "待重答",
  reattempted: "已重答",
};

export function questionPrimaryAction(id: string, state: QuestionState, latestAnswerId?: string | null, sourceType?: string | null) {
  const question = encodeURIComponent(id);
  const answer = latestAnswerId ? encodeURIComponent(latestAnswerId) : null;
  if (answer && sourceType === "ielts_practice") {
    const attemptHref = `/questions/${question}/attempts/${answer}`;
    if (state === "analysis_pending") return { label: "查看处理进度", href: attemptHref };
    if (state === "analysis_failed") return { label: "查看原因并重试", href: attemptHref };
    if (state === "materials_pending") return { label: "查看已保存回答", href: attemptHref };
    if (["learning_incomplete", "ready_to_learn", "learning"].includes(state)) return { label: state === "learning" ? "继续轻松学" : "轻松学本题", href: `/light-study?scope=question&id=${question}` };
    if (["learning_completed", "ready_to_reattempt"].includes(state)) return { label: "不看提示，重新回答", href: `/questions/${question}/practice?kind=independent&source=${answer}` };
  }
  switch (state) {
    case "unanswered": return { label: "开始回答", href: `/questions/${question}/practice` };
    case "mastered": return { label: "自评已掌握 · 查看", href: `/questions/${question}` };
    case "self_assessed": return { label: "查看表达与自评", href: `/questions/${question}` };
    case "learning_paused": return { label: "查看与恢复表达", href: `/questions/${question}` };
    case "learning_completed": return { label: "定期复习", href: `/questions/${question}/practice` };
    case "learning_incomplete": return { label: "查看本题材料", href: `/questions/${question}` };
    case "analysis_pending": return { label: "查看分析", href: answer ? `/answer-studio/${answer}` : `/questions/${question}` };
    case "analysis_failed": return { label: "查看原因", href: answer ? `/answer-studio/${answer}` : `/questions/${question}` };
    case "materials_pending": return { label: "材料待处理", href: `/questions/${question}#learning-units` };
    case "ready_to_learn": return { label: "轻松学本题", href: `/light-study?scope=question&id=${question}` };
    case "learning": return { label: "继续轻松学", href: `/light-study?scope=question&id=${question}` };
    case "ready_to_reattempt": return { label: "开始重答", href: `/questions/${question}/practice` };
    case "reattempted": return { label: "查看重答对比", href: `/questions/${question}#reattempt-history` };
  }
}

export const questionActivityCte = sql`
  WITH published_question_units AS (
    SELECT u.question_id, u.chunk_id, CASE WHEN SUM(CASE WHEN u.requirement='required' THEN 1 ELSE 0 END)>0 THEN 'required' ELSE 'optional' END AS requirement,
      MIN(u.priority) AS priority,
      MIN(u.id) AS id,
      MIN(u.gap_id) AS gap_id,
      (SELECT MIN(shared.first_round_completed_at) FROM question_learning_units shared
        WHERE shared.chunk_id = u.chunk_id AND shared.first_round_completed_at IS NOT NULL) AS first_round_completed_at
    FROM question_learning_units u JOIN chunks c ON c.id = u.chunk_id
    WHERE u.status = 'active' AND c.quality_status IN ('approved','edited')
      AND c.review_provenance = 'independent_reviewer'
      AND EXISTS (SELECT 1 FROM learning_scenarios s WHERE s.chunk_id = u.chunk_id
        AND s.scenario_kind = 'common_usage' AND s.review_decision IN ('approved','edited') AND s.reviewer_run_id IS NOT NULL)
      AND EXISTS (SELECT 1 FROM learning_scenarios s WHERE s.chunk_id = u.chunk_id AND s.question_id = u.question_id
        AND s.scenario_kind = 'question_repair' AND s.review_decision IN ('approved','edited') AND s.reviewer_run_id IS NOT NULL)
    GROUP BY u.question_id, u.chunk_id
  ), completed_question_reattempts AS (
    SELECT ss.id, ss.question_id, ss.answer_id, ss.updated_at AS completed_at
    FROM speaking_sessions ss
    JOIN personal_answers pa ON pa.id = ss.answer_id AND pa.question_id = ss.question_id
    JOIN answer_versions av ON av.id = pa.current_version_id AND av.answer_id = pa.id
    WHERE ss.experience_version IN ('teacher_chat_v1','teacher_chat_v2') AND ss.status = 'completed'
      AND pa.superseded_by_revision_id IS NULL AND pa.status = 'ready' AND trim(pa.raw_text) != ''
      AND pa.created_at >= ss.created_at
      AND EXISTS (SELECT 1 FROM personal_answers previous WHERE previous.question_id = ss.question_id
        AND previous.superseded_by_revision_id IS NULL AND previous.id != pa.id AND previous.created_at <= ss.created_at)
  ), latest_question_answers AS (
    SELECT pa.*, ROW_NUMBER() OVER (PARTITION BY pa.question_id ORDER BY pa.created_at DESC, pa.attempt_order DESC, pa.id DESC) AS recency
    FROM personal_answers pa WHERE pa.superseded_by_revision_id IS NULL
  ), current_question_jobs AS (
    SELECT pa.question_id, j.*,
      ROW_NUMBER() OVER (PARTITION BY pa.question_id, j.kind ORDER BY j.created_at DESC, j.updated_at DESC, j.id DESC) AS recency
    FROM latest_question_answers pa JOIN ai_jobs j ON
      (j.target_type = 'personal_answer' AND j.target_id = pa.id)
      OR (j.target_type = 'answer_version' AND j.target_id = pa.current_version_id)
      OR (j.target_type = 'speaking_session' AND EXISTS (
        SELECT 1 FROM speaking_sessions ss WHERE ss.id = j.target_id AND ss.answer_id = pa.id
          AND ss.status IN ('evaluating','completed','ai_failed') AND j.kind = 'speaking_reattempt_comparator'))
    WHERE pa.recency = 1
  ), latest_all_answers AS (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY question_id ORDER BY julianday(created_at) DESC, answer_order DESC, source_type DESC, id DESC) AS latest_rank FROM (
      SELECT id,question_id,created_at,status,'personal_answer' AS source_type,source_order AS answer_order FROM personal_answers WHERE superseded_by_revision_id IS NULL
        AND NOT EXISTS(SELECT 1 FROM practice_answer_sources mapped WHERE mapped.answer_id=personal_answers.id)
      UNION ALL SELECT id,question_id,created_at,status,'ielts_practice' AS source_type,
        COALESCE((SELECT pa.source_order FROM practice_answer_sources map JOIN personal_answers pa ON pa.id=map.answer_id WHERE map.attempt_id=speaking_question_attempts.id),0) AS answer_order FROM speaking_question_attempts
    )
  ), question_metrics AS (
    SELECT q.id,
      (
        (SELECT COUNT(*) FROM personal_answers pa WHERE pa.question_id = q.id AND pa.superseded_by_revision_id IS NULL AND NOT EXISTS(SELECT 1 FROM practice_answer_sources mapped WHERE mapped.answer_id=pa.id))
        +
        (SELECT COUNT(*) FROM speaking_question_attempts sqa WHERE sqa.question_id = q.id)
      ) AS totalAnswerCount,
      (SELECT COUNT(*) FROM personal_answers pa WHERE pa.question_id = q.id AND pa.superseded_by_revision_id IS NULL) AS answerCount,
      (SELECT id FROM latest_all_answers la WHERE la.question_id=q.id AND la.latest_rank=1) AS latestAnswerId,
      (SELECT source_type FROM latest_all_answers la WHERE la.question_id=q.id AND la.latest_rank=1) AS latestAnswerType,
      (SELECT COUNT(*) FROM published_question_units u WHERE u.question_id = q.id) AS learningUnitCount,
      (SELECT COUNT(*) FROM published_question_units u WHERE u.question_id = q.id AND u.requirement = 'required') AS requiredTotal,
      (SELECT COUNT(*) FROM published_question_units u WHERE u.question_id = q.id AND u.requirement = 'required' AND u.first_round_completed_at IS NULL) AS requiredRemaining,
      ((SELECT COUNT(DISTINCT answer_id) FROM completed_question_reattempts ss WHERE ss.question_id = q.id)+(SELECT COUNT(*) FROM answer_drafts d JOIN speaking_question_attempts s ON s.id=d.submitted_attempt_id WHERE d.question_id=q.id AND d.kind='independent' AND d.english_committed_at IS NOT NULL AND s.status='completed')) AS reattemptCount,
      EXISTS (SELECT 1 FROM current_question_jobs j WHERE j.question_id = q.id AND j.recency = 1
        AND j.status IN ('queued','generating','reviewing','applying')) AS processing,
      (EXISTS (SELECT 1 FROM current_question_jobs j WHERE j.question_id = q.id AND j.recency = 1
        AND j.status IN ('needs_attention','retryable_failure','terminal_failure'))
        OR EXISTS (SELECT 1 FROM latest_question_answers pa WHERE pa.question_id = q.id AND pa.recency = 1 AND pa.status = 'failed')) AS failed,
      EXISTS (SELECT 1 FROM latest_question_answers pa JOIN ai_jobs j ON j.target_id = pa.id AND j.target_type = 'personal_answer'
        JOIN answer_versions av ON av.id = pa.current_version_id AND av.answer_id = pa.id
        WHERE pa.question_id = q.id AND pa.recency = 1 AND pa.status = 'ready'
          AND j.kind = 'speaking_gap_pipeline' AND j.status = 'completed' AND j.updated_at >= av.created_at
          AND EXISTS (SELECT 1 FROM ai_runs g JOIN ai_runs r ON r.job_id = g.job_id
            WHERE g.job_id = j.id AND g.role = 'gap_generator' AND r.role = 'gap_reviewer'
              AND g.status = 'completed' AND r.status = 'completed' AND g.run_id != r.run_id
              AND g.prompt_version != r.prompt_version AND g.input_hash != '' AND r.input_hash != '')
          AND NOT EXISTS (SELECT 1 FROM answer_gaps gap WHERE gap.answer_id = pa.id AND
            (gap.learning_fit = 1 OR gap.status IN ('needs_attention','pending_review')))) AS noLearningRequired,
      COALESCE((SELECT qm.mastered FROM question_mastery qm WHERE qm.question_id = q.id), 0) AS isMastered,
      (SELECT qm.four_step_completed_at FROM question_mastery qm WHERE qm.question_id = q.id) AS legacyFourStepCompletedAt,
      (SELECT MAX(active_at) FROM (
        SELECT qm.last_learned_at AS active_at FROM question_mastery qm WHERE qm.question_id=q.id
        UNION ALL SELECT sqa.created_at FROM speaking_question_attempts sqa WHERE sqa.question_id=q.id
        UNION ALL SELECT pa.created_at FROM personal_answers pa WHERE pa.question_id=q.id
      )) AS lastActiveAt

    FROM questions q
  ), resolved_question_metrics AS (
    SELECT m.*,
      (SELECT pm.id FROM practice_materials pm WHERE pm.source_type='ielts_practice' AND pm.source_id=m.latestAnswerId ORDER BY (pm.contract_version='evidence_v2') DESC,(pm.status='ready') DESC,julianday(pm.created_at) DESC,pm.id DESC LIMIT 1) AS currentMaterialId,
      (SELECT status FROM speaking_question_attempts sqa WHERE sqa.id=m.latestAnswerId) AS attemptStatus
    FROM question_metrics m
  ), light_question_metrics AS (
    SELECT m.*,
      (SELECT COUNT(DISTINCT mi.learning_item_id) FROM practice_material_items mi JOIN learning_items i ON i.id=mi.learning_item_id WHERE mi.material_id=m.currentMaterialId AND i.status='active' AND NOT EXISTS(SELECT 1 FROM expression_preferences p WHERE p.learning_item_id=i.id AND p.hidden=1)) AS lightTotal,
      (SELECT COUNT(DISTINCT mi.learning_item_id) FROM practice_material_items mi JOIN learning_items i ON i.id=mi.learning_item_id JOIN light_study_progress p ON p.learning_item_id=i.id WHERE mi.material_id=m.currentMaterialId AND i.status='active' AND NOT EXISTS(SELECT 1 FROM expression_preferences ep WHERE ep.learning_item_id=i.id AND ep.hidden=1)) AS lightSeen,
      (SELECT COUNT(DISTINCT mi.learning_item_id) FROM practice_material_items mi JOIN learning_items i ON i.id=mi.learning_item_id JOIN expression_preferences ep ON ep.learning_item_id=i.id WHERE mi.material_id=m.currentMaterialId AND i.status='active' AND ep.hidden=0 AND ep.self_known=1 AND NOT EXISTS(SELECT 1 FROM light_study_progress p WHERE p.learning_item_id=i.id)) AS lightSelfKnownUnstudied,
      (SELECT COUNT(DISTINCT mi.learning_item_id) FROM practice_material_items mi JOIN learning_items i ON i.id=mi.learning_item_id JOIN expression_preferences ep ON ep.learning_item_id=i.id WHERE mi.material_id=m.currentMaterialId AND i.status='active' AND ep.hidden=1) AS lightHidden,
      (SELECT COUNT(DISTINCT mi.learning_item_id) FROM practice_material_items mi JOIN practice_materials pm ON pm.id=mi.material_id JOIN light_study_progress p ON p.learning_item_id=mi.learning_item_id JOIN learning_items i ON i.id=mi.learning_item_id WHERE pm.question_id=m.id AND pm.status='ready' AND ${sql.raw(currentReadyMaterialPredicate)} AND i.status='active' AND julianday(p.due_at)<=julianday('now') AND NOT EXISTS(SELECT 1 FROM expression_preferences ep WHERE ep.learning_item_id=i.id AND (ep.hidden=1 OR ep.self_known=1))) AS lightDueCount
    FROM resolved_question_metrics m
  ), question_activity AS (
    SELECT *,
      CASE WHEN latestAnswerType='ielts_practice' THEN (SELECT COUNT(*) FROM practice_material_items mi WHERE mi.material_id=currentMaterialId) ELSE learningUnitCount END AS currentUnitCount,
      CASE WHEN latestAnswerType='ielts_practice' THEN (SELECT MAX(fs.completed_at) FROM four_step_sessions fs WHERE fs.material_id=currentMaterialId AND fs.status='completed') ELSE legacyFourStepCompletedAt END AS fourStepCompletedAt,
      CASE 
        WHEN lastActiveAt IS NOT NULL THEN CAST(MAX(0, julianday(date('now','+8 hours')) - julianday(date(lastActiveAt,'+8 hours'))) AS INTEGER)
        ELSE NULL 
      END AS daysSinceReview,
      CASE
        WHEN totalAnswerCount = 0 THEN 'unanswered'
        WHEN latestAnswerType='ielts_practice' THEN CASE
          WHEN attemptStatus='processing' AND NOT EXISTS(SELECT 1 FROM practice_materials pm WHERE pm.id=currentMaterialId AND pm.status='ready') THEN 'analysis_pending'
          WHEN attemptStatus='failed' AND NOT EXISTS(SELECT 1 FROM practice_materials pm WHERE pm.id=currentMaterialId AND pm.status='ready') THEN 'analysis_failed'
          WHEN currentMaterialId IS NULL OR NOT EXISTS (SELECT 1 FROM practice_materials pm WHERE pm.id=currentMaterialId AND pm.status='ready') THEN 'materials_pending'
          WHEN lightTotal>0 AND lightSelfKnownUnstudied>0 AND lightSeen+lightSelfKnownUnstudied=lightTotal THEN 'self_assessed'
          WHEN lightTotal=0 AND lightHidden>0 THEN 'learning_paused'
          WHEN EXISTS (SELECT 1 FROM light_study_sessions ls WHERE ls.status IN ('active','paused') AND NOT EXISTS(SELECT 1 FROM light_study_successions s WHERE s.legacy_session_id=ls.id)
            AND EXISTS(SELECT 1 FROM json_each(ls.queue_json) queued JOIN learning_items qi ON qi.id=json_extract(queued.value,'$.itemId') JOIN practice_materials pm ON pm.id=json_extract(queued.value,'$.materialId') WHERE qi.status='active' AND pm.status='ready' AND ${sql.raw(currentReadyMaterialPredicate)} AND NOT EXISTS(SELECT 1 FROM expression_preferences ep WHERE ep.learning_item_id=qi.id AND (ep.hidden=1 OR ep.self_known=1)))
            AND (json_extract(ls.scope_json,'$.type')='question' AND json_extract(ls.scope_json,'$.id')=resolved_question_metrics.id OR json_extract(ls.scope_json,'$.type')='material' AND json_extract(ls.scope_json,'$.id')=currentMaterialId)) THEN 'learning'
          WHEN lightTotal>0 AND lightSeen=lightTotal OR (SELECT json_array_length(pm.analysis_json,'$.learningMaterials') FROM practice_materials pm WHERE pm.id=currentMaterialId)=0 THEN 'learning_completed'
          ELSE 'learning_incomplete' END
        WHEN isMastered = 1 THEN 'mastered'
        WHEN legacyFourStepCompletedAt IS NOT NULL THEN 'learning_completed'
        WHEN processing THEN 'analysis_pending'
        WHEN failed THEN 'analysis_failed'
        WHEN requiredRemaining > 0 AND requiredRemaining < requiredTotal THEN 'learning'
        WHEN requiredRemaining > 0 THEN 'ready_to_learn'
        WHEN learningUnitCount = 0 AND NOT noLearningRequired AND answerCount > 0 THEN 'materials_pending'
        WHEN reattemptCount > 0 THEN 'reattempted'
        WHEN (SELECT COUNT(*) FROM speaking_question_attempts sqa WHERE sqa.question_id = resolved_question_metrics.id AND sqa.status = 'completed') > 0 THEN 'learning_incomplete'
        ELSE 'ready_to_reattempt'
      END AS state
    FROM light_question_metrics AS resolved_question_metrics
  )`;

export interface QuestionActivity {
  id: string;
  totalAnswerCount: number;
  answerCount: number;
  learningUnitCount: number;
  requiredTotal: number;
  requiredRemaining: number;
  reattemptCount: number;
  latestAnswerId: string | null;
  latestAnswerType: string | null;
  currentMaterialId: string | null;
  currentUnitCount: number;
  isMastered: number;
  fourStepCompletedAt: string | null;
  lastActiveAt: string | null;
  daysSinceReview: number | null;
  state: QuestionState;
  lightTotal:number;
  lightSeen:number;
  lightSelfKnownUnstudied:number;
  lightHidden:number;
  lightDueCount:number;
}

export async function getQuestionActivity(id: string): Promise<QuestionActivity | null> {
  const db = await getDbReady();
  const rows = await db.all<QuestionActivity>(sql`${questionActivityCte} SELECT * FROM question_activity WHERE id = ${id}`);
  return rows[0] ?? null;
}
