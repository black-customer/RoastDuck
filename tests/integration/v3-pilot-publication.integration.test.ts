import { createClient } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureSchema } from "../../db/migrate";
import { applyV3PilotMaterials, auditV3Pilot } from "../../src/lib/imports/apply-v3-pilot";
import { V3_PILOT_VERSION, v3PilotHash, type V3PilotInput, type V3PilotMaterial } from "../../src/lib/imports/v3-pilot-material";
import { prepareTestDatabase } from "../helpers/temp-db";

const database = prepareTestDatabase("v3-pilot-publication.integration");
process.env.ROASTDUCK_DB = database.url;
process.env.ROASTDUCK_SKIP_DB_BACKUP = "1";
const client = createClient({ url: database.url });
const exec = (sql: string, args: Array<string | number | null> = []) => client.execute({ sql, args });

const glossary = ["make", "progress", "used", "for", "steady", "change", "in", "a", "project", "i", "english", "how", "is", "the", "work", "going", "am", "making", "today", "are", "you", "improving"]
  .map((surface) => ({ surface, meaningZh: `释义-${surface}`, ipa: "/test/" }));

function material(suffix: string): V3PilotMaterial {
  return {
    gapId: `gap-${suffix}`, answerId: `answer-${suffix}`, questionId: `question-${suffix}`, evidenceSha256: v3PilotHash(`evidence-${suffix}`),
    canonicalChunk: `make progress ${suffix}`, displayChunk: "make progress", unitType: "lexical_chunk", meaningZh: "取得进步",
    englishGloss: "used for steady change", pattern: "make progress in a project", ipa: "/meɪk ˈprɑːɡres/",
    example: { en: "I make progress in English.", zh: "我的英语取得进步。" },
    commonUsage: { settingZh: "同事在办公室聊工作进度", relationshipZh: "同事", purposeZh: "说明工作正在推进", register: "casual", accent: "en-US", targetSurface: "making progress", lines: [
      { speaker: "A", en: "How is the work going?", zh: "工作进展如何？", target: false },
      { speaker: "B", en: "I am making progress today.", zh: "我今天有进展。", target: true },
    ] },
    questionRepair: { settingZh: "老师询问英语学习进度", relationshipZh: "老师与学生", purposeZh: "说明英语有所提升", register: "neutral", accent: "en-US", targetSurface: "making progress", lines: [
      { speaker: "Teacher", en: "Are you improving?", zh: "你有进步吗？", target: false },
      { speaker: "Student", en: "I am making progress in English.", zh: "我的英语正在进步。", target: true },
    ] }, glossary,
  };
}

function inputFor(item: V3PilotMaterial): V3PilotInput {
  const selected = Array.from({ length: 10 }, (_, index) => ({
    gapId: index === 0 ? item.gapId : `unused-gap-${index}`, answerId: index === 0 ? item.answerId : `unused-answer-${index}`,
    answerVersionId: index === 0 ? `version-${item.answerId.slice(7)}` : `unused-version-${index}`, questionId: index === 0 ? item.questionId : `unused-question-${index}`,
    gapType: "grammar_construction" as const, clusterId: index === 0 ? `cluster-${item.gapId.slice(4)}` : `unused-cluster-${index}`,
    evidenceSha256: index === 0 ? item.evidenceSha256 : v3PilotHash(`unused-${index}`), intentZh: "表达正在取得进步", recommendedExpression: "make progress",
    explanationZh: "使用固定搭配表达逐渐取得进步。", impactLevel: "medium" as const, diagnosisReviewerRunId: "diagnosis-reviewer",
  }));
  return { schemaVersion: V3_PILOT_VERSION, pilotId: "pilot-integration", sourceBatchId: "batch-integration", sourceReviewSha256: v3PilotHash("review"),
    prompts: { generator: { version: "g", sha256: v3PilotHash("g") }, materialReviewer: { version: "m", sha256: v3PilotHash("m") }, scenarioReviewer: { version: "s", sha256: v3PilotHash("s") } }, selected };
}

const review = { generationSha256: v3PilotHash("generation"), materialReviewSha256: v3PilotHash("material-review"), scenarioReviewSha256: v3PilotHash("scenario-review"), generatorRunId: "generator-run", materialReviewerRunId: "material-reviewer-run", scenarioReviewerRunId: "scenario-reviewer-run" };

async function seed(suffix: string) {
  await exec("INSERT INTO topics (id,book_id,name_zh,name_en,status) VALUES (?, 'book_personal_ielts_answers','学习','Study','audited')", [`topic-${suffix}`]);
  await exec("INSERT INTO questions (id,book_id,topic_id,part,text,text_zh,norm_text,status) VALUES (?,'book_personal_ielts_answers',?,1,'Are you improving your English?','你的英语有进步吗？',?,'audited')", [`question-${suffix}`, `topic-${suffix}`, `question-${suffix}`]);
  await exec("INSERT INTO personal_answers (id,question_id,input_language,raw_text,status,current_version_id,source_kind) VALUES (?,?,'en','I improve English.','ready',?,'historical_import')", [`answer-${suffix}`, `question-${suffix}`, `version-${suffix}`]);
  await exec("INSERT INTO answer_versions (id,answer_id,version_no,kind,text_en) VALUES (?,?,1,'normalized_transcript','I improve English.')", [`version-${suffix}`, `answer-${suffix}`]);
  await exec("INSERT INTO personal_answer_sentences (id,answer_id,answer_version_id,question_id,sentence_index,text_en,text_zh) VALUES (?,?,?,?,0,'I improve English.','')", [`sentence-${suffix}`, `answer-${suffix}`, `version-${suffix}`, `question-${suffix}`]);
  await exec("INSERT INTO gap_clusters (id,canonical_key,title_zh,gap_type) VALUES (?,?,'取得进步','grammar_construction')", [`cluster-${suffix}`, `cluster-${suffix}`]);
  await exec("INSERT INTO answer_gaps (id,answer_id,answer_version_id,cluster_id,gap_type,evidence_text,intent_zh,recommended_expression,explanation_zh,confidence,impact_level,reviewer_decision,reviewer_reason,reviewer_run_id,learning_fit,status) VALUES (?,?,?,?, 'grammar_construction','I improve English.','表达正在取得进步','make progress','使用固定搭配表达逐渐取得进步。',1,'medium','approved','独立诊断审核通过','diagnosis-reviewer',1,'open')", [`gap-${suffix}`, `answer-${suffix}`, `version-${suffix}`, `cluster-${suffix}`]);
}

beforeAll(async () => { await ensureSchema(client, database.url); await seed("one"); });
afterAll(() => client.close());

describe("V3 个人材料发布", () => {
  it("原子发布完整学习项，重复运行不复制进度、语境或注解", async () => {
    const item = material("one"), input = inputFor(item);
    await exec("DELETE FROM personal_answer_sentences WHERE answer_id='answer-one'");
    expect(await applyV3PilotMaterials(client, input, [item], review)).toHaveLength(1);
    expect(Number((await exec("SELECT COUNT(*) AS n FROM personal_answer_sentences WHERE answer_id='answer-one'")).rows[0].n)).toBe(1);
    const before = {
      chunks: Number((await exec("SELECT COUNT(*) AS n FROM chunks WHERE book_id='book_personal_ielts_answers'")).rows[0].n),
      scenarios: Number((await exec("SELECT COUNT(*) AS n FROM learning_scenarios")).rows[0].n),
      annotations: Number((await exec("SELECT COUNT(*) AS n FROM text_annotations")).rows[0].n),
      units: Number((await exec("SELECT COUNT(*) AS n FROM question_learning_units")).rows[0].n),
    };
    await applyV3PilotMaterials(client, input, [item], review);
    const after = {
      chunks: Number((await exec("SELECT COUNT(*) AS n FROM chunks WHERE book_id='book_personal_ielts_answers'")).rows[0].n),
      scenarios: Number((await exec("SELECT COUNT(*) AS n FROM learning_scenarios")).rows[0].n),
      annotations: Number((await exec("SELECT COUNT(*) AS n FROM text_annotations")).rows[0].n),
      units: Number((await exec("SELECT COUNT(*) AS n FROM question_learning_units")).rows[0].n),
    };
    expect(after).toEqual(before);
    expect(before).toMatchObject({ chunks: 1, scenarios: 2, units: 1 });
    expect((await auditV3Pilot(client, 1)).ok).toBe(true);
    await exec("DELETE FROM text_annotations WHERE content_type='example'");
    expect((await auditV3Pilot(client, 1)).ok).toBe(false);
    await applyV3PilotMaterials(client, input, [item], review);
    expect((await auditV3Pilot(client, 1)).ok).toBe(true);
    expect(Number((await exec("SELECT COUNT(*) AS n FROM ai_runs")).rows[0].n)).toBe(0);
  });

  it("发布中途失败会回滚整项，不留下半成品", async () => {
    await seed("rollback");
    await exec("CREATE TRIGGER fail_v3_scenario BEFORE INSERT ON learning_scenarios WHEN NEW.gap_id='gap-rollback' BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
    const item = material("rollback");
    await expect(applyV3PilotMaterials(client, inputFor(item), [item], review)).rejects.toThrow();
    await exec("DROP TRIGGER fail_v3_scenario");
    expect(Number((await exec("SELECT COUNT(*) AS n FROM chunks WHERE canonical_chunk='make progress rollback'")).rows[0].n)).toBe(0);
    expect(Number((await exec("SELECT COUNT(*) AS n FROM question_learning_units WHERE gap_id='gap-rollback'")).rows[0].n)).toBe(0);
  });
});
