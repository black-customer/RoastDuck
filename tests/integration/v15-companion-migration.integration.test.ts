import { createClient } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureSchema } from "../../db/migrate";
import { assertInsideTestResults, prepareTestDatabase } from "../helpers/temp-db";

const database = prepareTestDatabase("v15-companion-migration.integration");
assertInsideTestResults(database.file);
process.env.ROASTDUCK_SKIP_DB_BACKUP = "1";
const client = createClient({ url: database.url });

async function execute(sql: string, args: Array<string | number | null> = []) {
  return client.execute({ sql, args });
}

beforeAll(async () => {
  await ensureSchema(client, database.url);

  await execute("INSERT INTO books (id,title_zh,title_en,source_type,status) VALUES ('book_v15','迁移测试','Migration','question_bank','beta')");
  await execute("INSERT INTO topics (id,book_id,name_zh,name_en,status) VALUES ('topic_v15','book_v15','迁移','Migration','audited')");
  await execute("INSERT INTO questions (id,book_id,topic_id,part,text,text_zh,norm_text,status) VALUES ('question_v15','book_v15','topic_v15',1,'How do you learn English?','你怎样学英语？','how do you learn english','audited')");
  await execute(`INSERT INTO speaking_sessions
    (id,question_id,status,experience_version,created_at,updated_at)
    VALUES ('speaking_v15_a','question_v15','conversing','teacher_chat_v2','2026-08-01T00:00:00.000Z','2026-08-01T00:02:00.000Z'),
           ('speaking_v15_b','question_v15','completed','teacher_chat_v2','2026-08-02T00:00:00.000Z','2026-08-02T00:02:00.000Z')`);
  await execute(`INSERT INTO speaking_messages
    (id,session_id,sequence_no,role,message_kind,text,status,client_message_id,created_at)
    VALUES ('message_v15_1','speaking_v15_a',1,'user','text','First answer','sent','client-1','2026-08-01T00:01:00.000Z'),
           ('message_v15_2','speaking_v15_b',1,'teacher','text','Later feedback','sent','client-2','2026-08-02T00:01:00.000Z')`);
  await execute(`INSERT INTO learning_sessions
    (id,session_date,mode,status,queue_json,scope_type,scope_id)
    VALUES ('learning_v15','2026-08-02','learn','active','[]','question','question_v15')`);

  // 模拟真实 v14 数据库：结构已由测试夹具建立，但 v15 迁移记录和产物尚不存在。
  await execute("DELETE FROM companion_messages");
  await execute("DELETE FROM companion_threads");
  await execute("UPDATE speaking_sessions SET companion_thread_id=NULL");
  await execute("UPDATE learning_sessions SET companion_thread_id=NULL");
  // 只在此临时库回退为连续 v14 夹具，不能挖一个中间版本洞来冒充旧库。
  await execute("DELETE FROM _schema_migrations WHERE version>=15");
  for (const table of ["light_study_events","light_study_sessions","light_study_progress"]) await execute(`DROP TABLE ${table}`);
  await execute("DROP TABLE practice_material_stages");
  await execute("DROP TABLE practice_legacy_analyses");
  await execute("ALTER TABLE practice_materials DROP COLUMN contract_version");

  await ensureSchema(client, database.url);
});

afterAll(() => client.close());

describe("v15 Gap 提取与 Chloe 统一记忆迁移", () => {
  it("把同一道题的旧口语消息按时间回填到同一个 Chloe 线程", async () => {
    const threads = await execute("SELECT id,scope_key,scope_type,scope_id FROM companion_threads");
    expect(threads.rows).toEqual([
      expect.objectContaining({
        id: "companion_question_question_v15",
        scope_key: "question:question_v15",
        scope_type: "question",
        scope_id: "question_v15",
      }),
    ]);

    const messages = await execute("SELECT id,sequence_no,text,source_type,source_id FROM companion_messages ORDER BY sequence_no");
    expect(messages.rows).toEqual([
      expect.objectContaining({ id: "message_v15_1", sequence_no: 1, text: "First answer", source_type: "legacy_speaking", source_id: "message_v15_1" }),
      expect.objectContaining({ id: "message_v15_2", sequence_no: 2, text: "Later feedback", source_type: "legacy_speaking", source_id: "message_v15_2" }),
    ]);
  });

  it("回填口语与按题学习会话的统一线程关联", async () => {
    const speaking = await execute("SELECT companion_thread_id FROM speaking_sessions ORDER BY id");
    expect(speaking.rows.every((row) => row.companion_thread_id === "companion_question_question_v15")).toBe(true);
    const learning = await execute("SELECT companion_thread_id FROM learning_sessions WHERE id='learning_v15'");
    expect(learning.rows[0]?.companion_thread_id).toBe("companion_question_question_v15");
  });

  it("建立提取证据、个人变体、实验分配和可撤销记忆表", async () => {
    await execute(`INSERT INTO retrieval_attempts
      (id,session_id,chunk_id,phase,cue_hash,raw_input,normalized_input,judgement_route,verdict,client_event_id,local_date)
      VALUES ('attempt_v15','learning_v15','chunk_v15','retrieval','cue-hash','I rely on it.','i rely on it','exact','natural_equivalent','event_v15','2026-09-04')`);
    await execute(`INSERT INTO expression_variants
      (id,scope_key,chunk_id,expression,normalized_expression,source_attempt_id,review_decision)
      VALUES ('variant_v15','gap:gap_v15','chunk_v15','I count on it.','i count on it','attempt_v15','pending')`);
    await execute("INSERT INTO learning_experiment_assignments (experiment_id,chunk_id,gap_id,question_id) VALUES ('gap_retrieval_v3','chunk_v15','gap_v15','question_v15')");
    await execute(`INSERT INTO companion_memories
      (id,category,summary,source_type,source_id,evidence_json)
      VALUES ('memory_v15','learning','用户正在学习 rely on','retrieval_attempt','attempt_v15','[\"attempt_v15\"]')`);

    expect(Number((await execute("SELECT COUNT(*) AS n FROM retrieval_attempts")).rows[0]?.n)).toBe(1);
    expect(Number((await execute("SELECT COUNT(*) AS n FROM expression_variants")).rows[0]?.n)).toBe(1);
    expect(Number((await execute("SELECT COUNT(*) AS n FROM learning_experiment_assignments")).rows[0]?.n)).toBe(1);
    expect((await execute("SELECT status FROM companion_memories WHERE id='memory_v15'")).rows[0]?.status).toBe("active");
  });

  it("重复执行 ensureSchema 不重复旧消息或迁移记录", async () => {
    await ensureSchema(client, database.url);
    expect(Number((await execute("SELECT COUNT(*) AS n FROM companion_messages")).rows[0]?.n)).toBe(2);
    expect(Number((await execute("SELECT COUNT(*) AS n FROM _schema_migrations WHERE version=15")).rows[0]?.n)).toBe(1);
  });
});
