import { createClient } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureSchema } from "../../db/migrate";
import { prepareTestDatabase } from "../helpers/temp-db";

const database = prepareTestDatabase("gap-output-mastery.integration");
process.env.ROASTDUCK_DB = database.url;
process.env.ROASTDUCK_SKIP_DB_BACKUP = "1";
const client = createClient({ url: database.url });
const exec = (sql: string, args: Array<string | number | null> = []) => client.execute({ sql, args });

async function attempt(id: string, session: string, date: string, phase: string, verdict: string, assistance = 0) {
  await exec(`INSERT INTO retrieval_attempts
    (id,session_id,gap_id,chunk_id,phase,cue_hash,judgement_route,verdict,assistance_level,client_event_id,local_date,created_at)
    VALUES (?,?,'gap-mastery','chunk-mastery',?,'cue','exact',?,?,?, ?,?)`,
  [id, session, phase, verdict, assistance, `event-${id}`, date, `${date}T12:00:00.000Z`]);
}

beforeAll(async () => {
  await ensureSchema(client, database.url);
  await exec("INSERT INTO questions (id,book_id,part,text,text_zh,norm_text) VALUES ('question-mastery','book_personal_ielts_answers',1,'Are you improving?','你有进步吗？','are you improving')");
  await exec("INSERT INTO personal_answers (id,question_id,input_language,raw_text,status,current_version_id,source_kind) VALUES ('answer-mastery','question-mastery','en','I improve.','ready','version-mastery','historical_import')");
  await exec("INSERT INTO answer_versions (id,answer_id,version_no,kind,text_en) VALUES ('version-mastery','answer-mastery',1,'normalized_transcript','I improve.')");
  await exec("INSERT INTO answer_gaps (id,answer_id,answer_version_id,gap_type,evidence_text,intent_zh,recommended_expression,explanation_zh,confidence,impact_level,reviewer_decision,reviewer_reason,reviewer_run_id,learning_fit,status) VALUES ('gap-mastery','answer-mastery','version-mastery','grammar_construction','I improve.','表达进步','make progress','固定搭配',1,'medium','approved','独立审核','reviewer',1,'open')");
});
afterAll(() => client.close());

describe("个人表达的跨日输出掌握", () => {
  it("同日重试不累计；跨日独立使用加到期复习才解决", async () => {
    const { refreshGapOutputMastery } = await import("../../src/lib/learning/gap-mastery");
    await attempt("day1-initial", "session-day1", "2026-09-01", "initial", "natural_equivalent");
    await attempt("day1-transfer", "session-day1", "2026-09-01", "transfer", "natural_equivalent");
    await attempt("day1-repeat", "session-day1-repeat", "2026-09-01", "review", "natural_equivalent");
    expect(await refreshGapOutputMastery("gap-mastery")).toMatchObject({ status: "learning", independentDates: ["2026-09-01"], completedDueReview: true });

    await attempt("day2-review", "session-day2", "2026-09-02", "review", "natural_equivalent");
    expect(await refreshGapOutputMastery("gap-mastery")).toMatchObject({ status: "resolved", independentDates: ["2026-09-01", "2026-09-02"] });
    expect((await exec("SELECT status FROM answer_gaps WHERE id='gap-mastery'")).rows[0].status).toBe("resolved");
  });

  it("新的确认错误会回到学习中，但不删除历史证据", async () => {
    const { refreshGapOutputMastery } = await import("../../src/lib/learning/gap-mastery");
    await attempt("day3-error", "session-day3", "2026-09-03", "review", "incorrect");
    await attempt("day3-repair", "session-day3", "2026-09-03", "repair_recall", "natural_equivalent", 1);
    const result = await refreshGapOutputMastery("gap-mastery");
    expect(result).toMatchObject({ status: "learning", latestSessionConfirmedError: true, independentDates: ["2026-09-01", "2026-09-02"] });
    expect((await exec("SELECT COUNT(DISTINCT local_date) AS n FROM retrieval_attempts WHERE gap_id='gap-mastery'")).rows[0].n).toBe(3);
  });
});
