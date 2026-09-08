import type { Client, InValue } from "@libsql/client";
import { detectInputLanguage, normalizeForMatch, sha256, stableId } from "./personal-import";
import type { SegmentRecovery } from "./segment-recovery";

/** 调用方先验证快照并备份。此函数不调用 AI，只事务应用已编译修订。 */
export async function applySegmentRecovery(client: Client, recovery: SegmentRecovery) {
  const tx = await client.transaction("write");
  const query = async (sql: string, args: InValue[] = []) => (await tx.execute({ sql, args })).rows;
  try {
    const existing = await query("SELECT snapshot_json FROM answer_import_revisions WHERE id = ?", [recovery.id]);
    if (existing[0]) {
      if (String(existing[0].snapshot_json) !== JSON.stringify(recovery)) throw new Error("修订 ID 对应的快照发生漂移");
      await tx.commit();
      return { revisionId: recovery.id, reused: true, addedAnswers: 0, archivedAnswers: 0 };
    }
    const imports = await query("SELECT id FROM answer_imports WHERE id = ?", [recovery.importId]);
    if (!imports.length) throw new Error("导入记录不存在");
    const previousRevision = await query("SELECT id FROM answer_import_revisions WHERE import_id = ?", [recovery.importId]);
    if (previousRevision.length) throw new Error("已有另一切分修订；需要基于最新版本重新审核，禁止覆盖");
    // 校验数据库仍与最初片段一致，避免准备快照之后发生的修改被吞掉。
    for (const id of recovery.replacesSegmentIds) {
      const rows = await query("SELECT start_offset,end_offset,raw_text FROM answer_import_segments WHERE id = ? AND import_id = ?", [id, recovery.importId]);
      const row = rows[0];
      if (!row) throw new Error("数据库缺少被修订片段");
      const sourceText = recovery.segments.map((s) => s.rawText).join("");
      if (sha256(String(row.raw_text)) !== sha256(sourceText.slice(Number(row.start_offset), Number(row.end_offset)))) throw new Error("数据库原片段已变化");
    }
    const placeholders = recovery.replacesSegmentIds.map(() => "?").join(",");
    const oldAnswers = await query(`SELECT * FROM personal_answers WHERE import_id = ? AND source_segment_id IN (${placeholders}) AND superseded_by_revision_id IS NULL`, [recovery.importId, ...recovery.replacesSegmentIds]);
    if (!oldAnswers.length) throw new Error("修订没有找到待替代的历史回答");
    if (oldAnswers.some((a) => a.source_kind !== "historical_import" || a.source_revision_id)) throw new Error("修订不能替换 Runtime 或其他版本的回答");
    const ids = oldAnswers.map((a) => String(a.id));
    const reviewedQuestionIds = [...new Set(recovery.segments.filter((s) => s.reviewed && s.questionId).map((s) => s.questionId!))];
    const answerPlaceholders = ids.map(() => "?").join(",");
    const inAnswers = `IN (${answerPlaceholders})`;
    const beforeLinks = {
      answers: oldAnswers,
      questions: reviewedQuestionIds.length ? await query(`SELECT * FROM questions WHERE id IN (${reviewedQuestionIds.map(() => "?").join(",")})`, reviewedQuestionIds) : [],
      gaps: await query(`SELECT * FROM answer_gaps WHERE answer_id ${inAnswers}`, ids),
      units: await query(`SELECT * FROM question_learning_units WHERE gap_id IN (SELECT id FROM answer_gaps WHERE answer_id ${inAnswers})`, ids),
      links: await query(`SELECT * FROM personal_chunk_links WHERE answer_id ${inAnswers}`, ids),
      inbox: await query(`SELECT * FROM learning_inbox_items WHERE source_type = 'answer_gap' AND source_id IN (SELECT id FROM answer_gaps WHERE answer_id ${inAnswers})`, ids),
    };
    await query(`INSERT INTO answer_import_revisions (id,import_id,source_sha256,base_segments_sha256,review_sha256,input_sha256,reviewer_run_id,reviewer_session_id,prompt_version,snapshot_json,before_links_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [recovery.id, recovery.importId, recovery.sourceSha256, recovery.baseSegmentsSha256, recovery.reviewSha256, recovery.inputSha256, recovery.reviewer.runId, recovery.reviewer.sessionId, recovery.reviewer.promptVersion, JSON.stringify(recovery), JSON.stringify(beforeLinks)]);
    const now = new Date().toISOString();
    for (const segment of recovery.segments) {
      if (segment.reviewed && segment.questionId) {
        const q = await query("SELECT id FROM questions WHERE id = ?", [segment.questionId]);
        if (!q.length) {
          if (!segment.questionId.startsWith("q_personal_") || !segment.questionText || !segment.part) throw new Error("未核验的题目关联");
          const missing = segment.questionTextOrigin === "missing_question_description";
          await query(`INSERT INTO questions (id,book_id,part,text,text_zh,norm_text,status,source_refs_json) VALUES (?,'book_personal_ielts_answers',?,?,?,?,'personal',?)`,
            [segment.questionId, segment.part, missing ? "" : segment.questionText, missing ? segment.questionText : "历史回答原题（待补中文）", normalizeForMatch(segment.questionText), JSON.stringify([{ type: "personal_import", importId: recovery.importId, revisionId: recovery.id, questionTextOrigin: segment.questionTextOrigin }])]);
        } else if (segment.questionId.startsWith("q_personal_") && segment.questionTextOrigin === "missing_question_description" && segment.questionText) {
          // 修复旧 Parser 的英文占位题；旧题目元数据已保存在 before_links_json。
          await query(`UPDATE questions SET text='',text_zh=?,norm_text=?,source_refs_json=? WHERE id=? AND book_id='book_personal_ielts_answers'`,
            [segment.questionText, normalizeForMatch(segment.questionText), JSON.stringify([{ type: "personal_import", importId: recovery.importId, revisionId: recovery.id, questionTextOrigin: segment.questionTextOrigin }]), segment.questionId]);
        }
      }
      await query(`INSERT INTO answer_import_revision_segments (revision_id,segment_id,source_order,start_offset,end_offset,segment_type,raw_text,question_id,answer_group_key,original_segment_ids_json,reviewed) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [recovery.id, segment.id, segment.sourceOrder, segment.startOffset, segment.endOffset, segment.type, segment.rawText, segment.questionId, segment.answerGroupKey, JSON.stringify(segment.originalSegmentIds), Number(segment.reviewed)]);
    }
    await query(`UPDATE personal_answers SET superseded_by_revision_id = ? WHERE id ${inAnswers}`, [recovery.id, ...ids]);
    await query(`UPDATE answer_gaps SET status = 'pending_review', reviewer_decision = 'pending_review' WHERE answer_id ${inAnswers}`, ids);
    await query(`UPDATE question_learning_units SET status = 'pending_review' WHERE gap_id IN (SELECT id FROM answer_gaps WHERE answer_id ${inAnswers})`, ids);
    await query(`UPDATE personal_chunk_links SET status = 'hidden' WHERE answer_id ${inAnswers}`, ids);
    await query(`UPDATE learning_inbox_items SET status = 'hidden' WHERE source_type = 'answer_gap' AND source_id IN (SELECT id FROM answer_gaps WHERE answer_id ${inAnswers})`, ids);
    for (const attempt of recovery.attempts) {
      const original = oldAnswers.find((a) => attempt.originalSegmentIds.includes(String(a.source_segment_id)));
      if (!original) throw new Error("新回答缺少原回答血缘");
      const versionId = stableId("answer_version", attempt.id, 2);
      const language = detectInputLanguage(attempt.rawText);
      // 只继承原记录的文件时间；顺序另存，不伪造精确口述时间。
      await query(`INSERT INTO personal_answers (id,question_id,input_language,raw_text,status,current_version_id,import_id,source_segment_id,source_order,attempt_order,source_kind,source_revision_id,created_at,updated_at) VALUES (?,?,?,?,'ready',?,?,?,?,?,'historical_import',?,?,?)`,
        [attempt.id, attempt.questionId, language, attempt.rawText, versionId, recovery.importId, String(original.source_segment_id), attempt.startOffset, 1, recovery.id, String(original.created_at), now]);
      for (const [no, kind, text] of [[1, "raw_transcript", attempt.rawText], [2, "normalized_transcript", attempt.normalizedText]] as const) {
        const textLanguage = detectInputLanguage(text);
        await query(`INSERT INTO answer_versions (id,answer_id,version_no,kind,text_en,text_zh,change_summary_json,created_at) VALUES (?,?,?,?,?,?,?,?)`,
          [stableId("answer_version", attempt.id, no), attempt.id, no, kind, textLanguage === "zh" ? "" : text, textLanguage === "zh" ? text : "",
            JSON.stringify(no === 1 ? [] : ["独立切分复核；只整理空白和标点，不提升英语水平", ...attempt.excludedTypes.map((t) => `原文保留；规范化回答排除 ${t} 片段`)]), String(original.created_at)]);
      }
    }
    // 统一以源偏移排列该文件的有效回答；无变化的回答 ID / 原文 / 版本保持不变。
    await query(`UPDATE personal_answers SET source_order = COALESCE((SELECT start_offset FROM answer_import_segments s WHERE s.id = personal_answers.source_segment_id),source_order)
      WHERE import_id = ? AND source_revision_id IS NULL AND superseded_by_revision_id IS NULL`, [recovery.importId]);
    await query(`WITH ordered AS (SELECT id, ROW_NUMBER() OVER (PARTITION BY question_id ORDER BY source_order,id) AS n FROM personal_answers WHERE import_id = ? AND superseded_by_revision_id IS NULL)
      UPDATE personal_answers SET attempt_order = (SELECT n FROM ordered WHERE ordered.id = personal_answers.id) WHERE id IN (SELECT id FROM ordered)`, [recovery.importId]);
    await tx.commit();
    return { revisionId: recovery.id, reused: false, addedAnswers: recovery.attempts.length, archivedAnswers: oldAnswers.length };
  } catch (error) {
    await tx.rollback();
    throw error;
  } finally { tx.close(); }
}
