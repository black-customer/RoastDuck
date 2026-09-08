import type { Client, InValue } from "@libsql/client";
import { gapHash, gapId, type GapBatchInput, type ValidatedGapBatch } from "./personal-gap-batch";

type Query = (sql: string, args?: InValue[]) => ReturnType<Client["execute"]>;

/** 以当前有效回答/版本/题目和 v12 源快照复核，不信任外部 JSON 声称的身份。 */
export async function verifyGapAnswerSnapshot(query: Query, answer: GapBatchInput["answers"][number]) {
  const { rows } = await query(`SELECT a.*,v.text_en,v.text_zh,q.text AS question_en,q.text_zh AS question_zh,q.part
    FROM personal_answers a JOIN answer_versions v ON v.id=a.current_version_id AND v.answer_id=a.id
    JOIN questions q ON q.id=a.question_id WHERE a.id=?`, [answer.answerId]);
  const row = rows[0];
  if (!row || row.superseded_by_revision_id || row.source_kind !== "historical_import") throw new Error("回答不存在、已归档或不属于历史材料");
  const versionHash = gapHash(JSON.stringify([String(row.text_en), String(row.text_zh)]));
  if (String(row.raw_text) !== answer.rawText || gapHash(String(row.raw_text)) !== answer.rawSha256 || versionHash !== answer.versionSha256
    || row.current_version_id !== answer.answerVersionId || row.question_id !== answer.questionId
    || row.question_en !== answer.question.textEn || row.question_zh !== answer.question.textZh || Number(row.part) !== answer.question.part
    || row.import_id !== answer.source.importId || row.source_revision_id !== answer.source.revisionId || row.source_segment_id !== answer.source.segmentId
    || [String(row.text_en), String(row.text_zh)].filter(Boolean).join("\n") !== answer.normalizedText) throw new Error("回答、版本、题目或来源已漂移；请重新准备");
  const source = answer.source;
  if (source.revisionId) {
    const result = await query("SELECT snapshot_json,source_sha256 FROM answer_import_revisions WHERE id=? AND import_id=?", [source.revisionId, source.importId]);
    if (!result.rows[0]) throw new Error("切分修订已丢失");
    const snapshot = JSON.parse(String(result.rows[0].snapshot_json)) as { segments: Array<{ rawText: string }>; attempts: Array<{ id: string; startOffset: number; endOffset: number; rawText: string; questionId: string }> };
    const original = snapshot.segments.map((s) => s.rawText).join("");
    const attempt = snapshot.attempts.find((a) => a.id === answer.answerId);
    if (!attempt || attempt.startOffset !== source.startOffset || attempt.endOffset !== source.endOffset || attempt.questionId !== answer.questionId
      || attempt.rawText !== answer.rawText || original.slice(source.startOffset, source.endOffset) !== answer.rawText
      || result.rows[0].source_sha256 !== source.textSha256 || gapHash(original) !== source.textSha256) throw new Error("源修订或精确偏移不匹配");
  } else {
    const result = await query("SELECT raw_text,start_offset,end_offset FROM answer_import_segments WHERE id=? AND import_id=?", [source.segmentId, source.importId]);
    const segment = result.rows[0];
    if (!segment || source.startOffset < Number(segment.start_offset) || source.endOffset > Number(segment.end_offset)
      || gapHash(String(segment.raw_text)) !== source.textSha256 || String(segment.raw_text).slice(source.startOffset - Number(segment.start_offset), source.endOffset - Number(segment.start_offset)) !== answer.rawText) throw new Error("原始片段或偏移不匹配");
  }
}

/** 只写诊断账本；不创建 Chunk / 学习进度 / Runtime 记录。调用方先校验真实文件并备份。 */
export async function applyPersonalGapBatch(client: Client, batch: ValidatedGapBatch) {
  const tx = await client.transaction("write");
  const query: Query = (sql, args = []) => tx.execute({ sql, args });
  try {
    for (const answer of batch.input.answers) await verifyGapAnswerSnapshot(query, answer);
    const serialized = JSON.stringify(batch);
    const existing = await query("SELECT snapshot_json FROM personal_diagnosis_batches WHERE id=? OR input_sha256=?", [batch.input.batchId, batch.inputSha256]);
    if (existing.rows.length) {
      if (existing.rows.length !== 1 || existing.rows[0].snapshot_json !== serialized) throw new Error("批次已存在且证据不同；禁止覆盖诊断历史");
      await tx.commit();
      return { reused: true, addedGaps: 0, learningCandidates: 0, publishedChunks: 0 };
    }
    const reusedRun = await query(`SELECT id FROM personal_diagnosis_batches WHERE generator_run_id IN (?,?) OR reviewer_run_id IN (?,?)`,
      [batch.generated.runId, batch.review.runId, batch.generated.runId, batch.review.runId]);
    if (reusedRun.rows.length) throw new Error("runId 已用于其他产物或角色，禁止重复使用");
    // 首轮诊断不会静默重做已独立审核的回答，后续修订需要显式的版本归并。
    for (const answer of batch.input.answers) {
      const prior = await query(`SELECT 1 FROM personal_diagnosis_batches b, json_each(b.snapshot_json,'$.input.answers') a
        WHERE json_extract(a.value,'$.answerId')=? LIMIT 1`, [answer.answerId]);
      if (prior.rows.length) throw new Error("此回答已有离线诊断，需显式修订，不能另起批次重复入账");
    }
    await query(`INSERT INTO personal_diagnosis_batches (id,input_sha256,generation_sha256,review_sha256,generator_run_id,reviewer_run_id,schema_version,snapshot_json) VALUES (?,?,?,?,?,?,?,?)`,
      [batch.input.batchId, batch.inputSha256, batch.generationSha256, batch.reviewSha256, batch.generated.runId, batch.review.runId, batch.input.schemaVersion, serialized]);
    let addedGaps = 0;
    let learningCandidates = 0;
    for (const answer of batch.input.answers) {
      const review = batch.review.answers.find((r) => r.answerId === answer.answerId)!;
      for (const item of review.items) {
        if (item.verdict === "rejected") continue; // 拒绝理由仍在不可变批次快照中，不进入有效 Gap 账本。
        const { gap, start, end, clusterKey, clusterTitleZh } = item.candidate;
        const canonical = `${gap.gapType}:${clusterKey}`;
        const clusterId = gapId("gap_cluster", canonical);
        const id = gapId("answer_gap", batch.input.batchId, answer.answerId, item.key);
        await query("INSERT OR IGNORE INTO gap_clusters (id,canonical_key,title_zh,gap_type) VALUES (?,?,?,?)", [clusterId, canonical, clusterTitleZh, gap.gapType]);
        const cluster = (await query("SELECT id FROM gap_clusters WHERE canonical_key=?", [canonical])).rows[0];
        await query(`INSERT INTO answer_gaps (id,answer_id,answer_version_id,source_segment_id,cluster_id,gap_type,evidence_text,intent_zh,recommended_expression,explanation_zh,confidence,impact_level,reviewer_decision,reviewer_reason,reviewer_run_id,learning_fit,status)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id, answer.answerId, answer.answerVersionId, answer.source.segmentId, String(cluster.id), gap.gapType, gap.evidenceText, gap.intentZh, gap.recommendedExpression, gap.explanationZh, gap.confidence, gap.impactLevel, item.verdict, item.reason, batch.review.runId, Number(gap.learningFit), ["asr_uncertain", "pronunciation_unknown"].includes(gap.gapType) ? "needs_attention" : "open"]);
        await query(`INSERT INTO personal_gap_evidence (gap_id,batch_id,answer_id,candidate_key,start_offset,end_offset,source_start_offset,source_end_offset,source_revision_id,raw_sha256) VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [id, batch.input.batchId, answer.answerId, item.key, start, end, answer.source.startOffset + start, answer.source.startOffset + end, answer.source.revisionId, answer.rawSha256]);
        addedGaps += 1;
        learningCandidates += Number(gap.learningFit);
      }
    }
    await query(`UPDATE gap_clusters SET occurrence_count=(SELECT COUNT(*) FROM answer_gaps g JOIN personal_answers a ON a.id=g.answer_id
      WHERE g.cluster_id=gap_clusters.id AND g.reviewer_decision IN ('approved','edited') AND a.superseded_by_revision_id IS NULL)
      WHERE id IN (SELECT g.cluster_id FROM answer_gaps g JOIN personal_gap_evidence e ON e.gap_id=g.id WHERE e.batch_id=?)`, [batch.input.batchId]);
    await tx.commit();
    return { reused: false, addedGaps, learningCandidates, publishedChunks: 0 };
  } catch (error) {
    await tx.rollback();
    throw error;
  } finally { tx.close(); }
}
