import { createClient } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureSchema } from "../../db/migrate";
import { applyPersonalGapBatch } from "../../src/lib/imports/apply-personal-gap-batch";
import { personalGapFixture } from "../helpers/personal-gap-fixture";
import { prepareTestDatabase } from "../helpers/temp-db";

const database = prepareTestDatabase("personal-gap-batch.integration");
process.env.ROASTDUCK_DB = database.url;
process.env.ROASTDUCK_SKIP_DB_BACKUP = "1";
const client = createClient({ url: database.url });
const exec = (sql: string, args: Array<string | number | null> = []) => client.execute({ sql, args });
async function seed(suffix: string) {
  const f = personalGapFixture(suffix), a = f.input.answers[0];
  await exec("INSERT INTO questions (id,book_id,part,text,text_zh,norm_text) VALUES (?,'book_personal_ielts_answers',1,?,?,?)", [a.questionId, a.question.textEn, a.question.textZh, suffix]);
  await exec("INSERT INTO answer_import_segments (id,import_id,source_order,start_offset,end_offset,segment_type,raw_text) VALUES (?,?,0,0,?,'answer',?)", [a.source.segmentId, a.source.importId, a.rawText.length, a.rawText]);
  await exec("INSERT INTO personal_answers (id,question_id,input_language,raw_text,status,import_id,source_segment_id,source_kind,current_version_id) VALUES (?,?,'en',?,'ready',?,?,'historical_import',?)", [a.answerId, a.questionId, a.rawText, a.source.importId, a.source.segmentId, a.answerVersionId]);
  await exec("INSERT INTO answer_versions (id,answer_id,version_no,kind,text_en) VALUES (?,?,1,'normalized_transcript',?)", [a.answerVersionId, a.answerId, a.rawText]);
  return f;
}
beforeAll(async () => { await ensureSchema(client, database.url); });
afterAll(() => client.close());

describe("离线诊断事务与发布隔离", () => {
  it("入账不改原文/版本，不生成可学状态、学习记录或 Runtime 费用", async () => {
    const f = await seed("apply"), a = f.input.answers[0];
    const before = JSON.stringify((await exec("SELECT * FROM personal_answers WHERE id=?", [a.answerId])).rows);
    expect(await applyPersonalGapBatch(client, f.validate())).toMatchObject({ addedGaps: 2, publishedChunks: 0 });
    expect(JSON.stringify((await exec("SELECT * FROM personal_answers WHERE id=?", [a.answerId])).rows)).toBe(before);
    expect((await exec("SELECT text_en FROM answer_versions WHERE id=?", [a.answerVersionId])).rows[0].text_en).toBe(a.rawText);
    for (const table of ["ai_runs", "learning_progress", "question_learning_units", "chunks", "learning_inbox_items"]) expect((await exec(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0].n).toBe(0);
    const { getQuestionActivity } = await import("../../src/lib/questions/activity");
    expect(await getQuestionActivity(a.questionId)).toMatchObject({ state: "materials_pending", learningUnitCount: 0 });
    await exec("INSERT INTO answer_gaps (id,answer_id,gap_type,evidence_text,explanation_zh,confidence,reviewer_decision,reviewer_reason,reviewer_run_id,status) VALUES ('old-quarantined',?,'lexical_gap','obsolete','隔离材料',0.5,'pending_review','旧规则不算审核','old','pending_review')", [a.answerId]);
    const { getQuestionLearningPack } = await import("../../src/lib/questions/learning-pack-service");
    const pack = await getQuestionLearningPack(a.questionId);
    expect(pack?.gaps).toHaveLength(2);
    expect(pack?.answers[0].gapCount).toBe(2);
    expect(pack?.gaps.some((g) => g.id === "old-quarantined")).toBe(false);
  });
  it("重复运行完全幂等，不复活已解决/隐藏问题", async () => {
    const f = personalGapFixture("apply");
    await exec("UPDATE answer_gaps SET status='resolved' WHERE answer_id='answer-apply'");
    expect(await applyPersonalGapBatch(client, f.validate())).toMatchObject({ reused: true, addedGaps: 0 });
    expect((await exec("SELECT status FROM answer_gaps WHERE answer_id='answer-apply'")).rows.every((r) => r.status === "resolved")).toBe(true);
    expect((await exec("SELECT COUNT(*) AS n FROM personal_gap_evidence")).rows[0].n).toBe(2);
  });
  it("原文、版本、题目、归档和来源漂移分别阻断", async () => {
    for (const [name, statement] of [
      ["raw", "UPDATE personal_answers SET raw_text='changed' WHERE id=?"],
      ["version", "UPDATE answer_versions SET text_en='changed' WHERE answer_id=?"],
      ["archive", "UPDATE personal_answers SET superseded_by_revision_id='new' WHERE id=?"],
      ["question", "UPDATE personal_answers SET question_id='missing' WHERE id=?"],
      ["source", "UPDATE answer_import_segments SET raw_text='changed' WHERE id=(SELECT source_segment_id FROM personal_answers WHERE id=?)"],
    ]) {
      const f = await seed(name); await exec(statement, [f.input.answers[0].answerId]);
      await expect(applyPersonalGapBatch(client, f.validate())).rejects.toThrow();
      expect((await exec("SELECT id FROM personal_diagnosis_batches WHERE id=?", [f.input.batchId])).rows).toHaveLength(0);
    }
  });
  it("中途数据库失败回滚整个批次，随后可正常重试", async () => {
    const f = await seed("rollback");
    await exec("CREATE TRIGGER fail_gap_evidence BEFORE INSERT ON personal_gap_evidence BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
    await expect(applyPersonalGapBatch(client, f.validate())).rejects.toThrow();
    await exec("DROP TRIGGER fail_gap_evidence");
    expect((await exec("SELECT id FROM answer_gaps WHERE answer_id='answer-rollback'")).rows).toHaveLength(0);
    expect((await exec("SELECT id FROM personal_diagnosis_batches WHERE id='batch-rollback'")).rows).toHaveLength(0);
    expect(await applyPersonalGapBatch(client, f.validate())).toMatchObject({ addedGaps: 2 });
  });
  it("不同答案共享问题簇，不复制同一次诊断，改变证据不能覆盖旧批次", async () => {
    expect((await exec("SELECT COUNT(*) AS n FROM gap_clusters")).rows[0].n).toBe(2);
    const f = personalGapFixture("apply"); f.review.answers[0].items[0].candidate.gap.confidence = 0.96;
    await expect(applyPersonalGapBatch(client, f.validate())).rejects.toThrow(/禁止覆盖/);
    const again = personalGapFixture("apply"); again.input.batchId = "different-batch";
    again.generated.runId = "new-generator"; again.review.runId = "new-reviewer";
    await expect(applyPersonalGapBatch(client, again.validate())).rejects.toThrow(/已有离线诊断/);
  });
  it("跨批次交换 Generator / Reviewer runId 也必须拒绝", async () => {
    const f = await seed("cross-role"); f.generated.runId = "reviewer-apply";
    await expect(applyPersonalGapBatch(client, f.validate())).rejects.toThrow(/runId 已用于/);
    expect((await exec("SELECT id FROM personal_diagnosis_batches WHERE id=?", [f.input.batchId])).rows).toHaveLength(0);
  });
  it("零 Gap 的已审回答也不能用新批次重复记录", async () => {
    const f = await seed("zero");
    f.generated.answers[0].candidates = []; f.review.answers[0].items = [];
    for (const coverage of [f.generated.answers[0].coverage, f.review.answers[0].coverage]) {
      for (const span of coverage) { span.gapKeys = []; span.status = "no_gap"; span.reason = "虚构零候选批次，仅验证幂等记录。"; }
    }
    expect(await applyPersonalGapBatch(client, f.validate())).toMatchObject({ addedGaps: 0 });
    f.input.batchId = "zero-new-batch"; f.generated.runId = "zero-new-generator"; f.review.runId = "zero-new-reviewer";
    await expect(applyPersonalGapBatch(client, f.validate())).rejects.toThrow(/已有离线诊断/);
  });
});
