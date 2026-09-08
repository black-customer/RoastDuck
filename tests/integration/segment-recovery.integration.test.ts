import { createClient } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureSchema } from "../../db/migrate";
import { applySegmentRecovery } from "../../src/lib/imports/apply-segment-recovery";
import { segmentRecoveryFixture } from "../helpers/segment-recovery-fixture";
import { prepareTestDatabase } from "../helpers/temp-db";

const database = prepareTestDatabase("segment-recovery.integration");
process.env.ROASTDUCK_DB = database.url;
process.env.ROASTDUCK_SKIP_DB_BACKUP = "1";
const client = createClient({ url: database.url });
const fixture = segmentRecoveryFixture();
const exec = (sql: string, args: Array<string | number | null> = []) => client.execute({ sql, args });

async function seed(importId: string) {
  const f = segmentRecoveryFixture(importId);
  await exec(`INSERT INTO answer_imports (id,source_file_name,source_sha256,source_bytes,private_original_path,parser_version,prompt_version,schema_version,run_id,idempotency_key) VALUES (?,'fixture','hash',1,'private','v1','v1','v1','fixture',?)`, [importId, importId]);
  await exec(`INSERT INTO answer_import_segments (id,import_id,source_order,start_offset,end_offset,segment_type,raw_text,question_id) VALUES (?,?,0,0,?,'answer',?,'recovery-q')`, [f.segment.id, importId, f.text.length, f.text]);
  await exec(`INSERT INTO personal_answers (id,question_id,input_language,raw_text,status,import_id,source_segment_id,source_kind,current_version_id,created_at) VALUES (?,'recovery-q','en',?,'ready',?,?,'historical_import',?,'2026-01-01T00:00:00Z')`, [`answer-${importId}`, f.text, importId, f.segment.id, `version-${importId}`]);
  await exec(`INSERT INTO answer_versions (id,answer_id,version_no,kind,text_en) VALUES (?,?,1,'raw_transcript',?)`, [`version-${importId}`, `answer-${importId}`, f.text]);
  return f;
}

beforeAll(async () => {
  await ensureSchema(client, database.url);
  await exec("INSERT INTO questions (id,book_id,part,text,norm_text) VALUES ('recovery-q','book_personal_ielts_answers',1,'Fixture question?','fixture question')");
  await seed("fixture-import");
  await exec(`INSERT INTO chunks (id,book_id,canonical_chunk,display_chunk,unit_type,meaning_zh) VALUES ('recovery-chunk','book_personal_ielts_answers','cook','cook','lexical_chunk','烹饪')`);
  await exec("INSERT INTO learning_progress (chunk_id,intro_done,mastery) VALUES ('recovery-chunk',1,'learning')");
  await exec(`INSERT INTO answer_gaps (id,answer_id,gap_type,evidence_text,explanation_zh,confidence,reviewer_decision,reviewer_reason,reviewer_run_id) VALUES ('recovery-gap','answer-fixture-import','lexical_gap','cook','fixture',1,'approved','fixture','fixture')`);
  await exec(`INSERT INTO question_learning_units (id,question_id,chunk_id,gap_id,source) VALUES ('recovery-unit','recovery-q','recovery-chunk','recovery-gap','fixture')`);
});
afterAll(() => client.close());

describe("私人切分修订数据库应用", () => {
  it("原文和旧版本不变，新增两次回答并隔离错误关联，不删除进度", async () => {
    expect(await applySegmentRecovery(client, fixture.compile())).toMatchObject({ reused: false, addedAnswers: 2, archivedAnswers: 1 });
    expect((await exec("SELECT raw_text,superseded_by_revision_id FROM personal_answers WHERE id='answer-fixture-import'")).rows[0]).toMatchObject({ raw_text: fixture.text, superseded_by_revision_id: fixture.compile().id });
    expect((await exec("SELECT text_en FROM answer_versions WHERE id='version-fixture-import'")).rows[0].text_en).toBe(fixture.text);
    expect((await exec("SELECT id FROM personal_answers WHERE superseded_by_revision_id IS NULL")).rows).toHaveLength(2);
    expect((await exec("SELECT status FROM question_learning_units WHERE id='recovery-unit'")).rows[0].status).toBe("pending_review");
    expect((await exec("SELECT intro_done FROM learning_progress WHERE chunk_id='recovery-chunk'")).rows[0].intro_done).toBe(1);
  });
  it("重复应用完全幂等，旧链接只读可查并能找到替代答案", async () => {
    expect(await applySegmentRecovery(client, fixture.compile())).toMatchObject({ reused: true, addedAnswers: 0 });
    expect((await exec("SELECT id FROM personal_answers")).rows).toHaveLength(3);
    const { getPersonalAnswer, appendUserAnswerVersion, listQuestionAnswerHistory } = await import("../../src/lib/answers/service");
    const archived = await getPersonalAnswer("answer-fixture-import");
    expect(archived).toMatchObject({ status: "superseded", rawText: fixture.text });
    expect(archived!.recovery!.replacements).toHaveLength(2);
    await expect(appendUserAnswerVersion("answer-fixture-import", "Overwrite", 1)).rejects.toThrow(/取代/);
    expect(await listQuestionAnswerHistory("recovery-q")).toHaveLength(2);
    const { getQuestionActivity } = await import("../../src/lib/questions/activity");
    expect(await getQuestionActivity("recovery-q")).toMatchObject({ answerCount: 2, state: "materials_pending" });
  });
  it("事务中途失败时回滚新片段和回答归档", async () => {
    const f = await seed("rollback-import");
    const revision = f.compile();
    revision.attempts[1].originalSegmentIds = ["does-not-exist"];
    await expect(applySegmentRecovery(client, revision)).rejects.toThrow(/血缘/);
    expect((await exec("SELECT id FROM answer_import_revisions WHERE import_id='rollback-import'")).rows).toHaveLength(0);
    expect((await exec("SELECT superseded_by_revision_id FROM personal_answers WHERE id='answer-rollback-import'")).rows[0].superseded_by_revision_id).toBeNull();
    expect((await exec("SELECT id FROM personal_answers WHERE source_revision_id=?", [revision.id])).rows).toHaveLength(0);
  });
  it("准备后数据库原文漂移阻断，不能覆盖新数据", async () => {
    const f = await seed("drift-import");
    await exec("UPDATE answer_import_segments SET raw_text='changed' WHERE id=?", [f.segment.id]);
    await expect(applySegmentRecovery(client, f.compile())).rejects.toThrow(/已变化/);
    expect((await exec("SELECT id FROM answer_import_revisions WHERE import_id='drift-import'")).rows).toHaveLength(0);
  });
  it("缺失原问句建立中文个人描述，不伪造英文，完整保留来源", async () => {
    const f = await seed("missing-question-import");
    for (const piece of f.review.cases[0].pieces) {
      if (piece.answerGroupKey !== "initial") continue;
      piece.questionId = null; piece.part = 3; piece.questionText = "Part 3 原问句缺失：家庭烹饪";
    }
    const revision = f.compile();
    await applySegmentRecovery(client, revision);
    const question = (await exec("SELECT text,text_zh,part,source_refs_json FROM questions WHERE id=?", [revision.attempts[0].questionId])).rows[0];
    expect(question).toMatchObject({ text: "", text_zh: "Part 3 原问句缺失：家庭烹饪", part: 3 });
    expect(JSON.parse(String(question.source_refs_json))[0]).toMatchObject({ revisionId: revision.id, questionTextOrigin: "missing_question_description" });
  });
});
