import { createClient } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureSchema } from "../../db/migrate";
import { prepareTestDatabase } from "../helpers/temp-db";

const temporary = prepareTestDatabase("v18-retired");
process.env.ROASTDUCK_DB = temporary.url;
process.env.ROASTDUCK_SKIP_DB_BACKUP = "1";
process.env.AI_PROVIDER = "mock";
const client = createClient({ url: temporary.url });
beforeAll(async () => {
  await ensureSchema(client, temporary.url);
  // 仅此隔离库模拟连续 v17，移除后续新增的 v20 结构后重放迁移。
  await client.execute("DELETE FROM _schema_migrations WHERE version>=18");
  for (const table of ["light_study_events","light_study_sessions","light_study_progress"]) await client.execute(`DROP TABLE ${table}`);
  await client.execute("DROP TABLE practice_material_stages");
  await client.execute("DROP TABLE practice_legacy_analyses");
  await client.execute("ALTER TABLE practice_materials DROP COLUMN contract_version");
  await client.execute("INSERT INTO questions (id,book_id,part,text,text_zh,norm_text) VALUES ('retired_question','removed_book',1,'How do you relax?','你怎样放松？','retired_question')");
  await client.execute("INSERT INTO learning_progress (chunk_id,fsrs_json,mastery) VALUES ('removed_chunk','{\"stability\":3}','reviewing')");
  await client.execute("INSERT INTO learning_sessions (id,mode,status,session_date,queue_json) VALUES ('removed_session','learn','active','2026-09-06','[\"removed_chunk\"]')");
  await client.execute("INSERT INTO review_log (chunk_id,training_type,rating) VALUES ('removed_chunk','practice','good')");
  await ensureSchema(client, temporary.url);
});
afterAll(() => client.close());

describe("词书退役后的非破坏性修复", () => {
  it("完整归档旧进度，不恢复任何旧内容或删除 review 历史", async () => {
    expect((await client.execute("SELECT * FROM chunks")).rows).toHaveLength(0);
    expect((await client.execute("SELECT * FROM books WHERE id='removed_book'")).rows).toHaveLength(0);
    expect((await client.execute("SELECT * FROM learning_progress")).rows).toHaveLength(0);
    const archived = (await client.execute("SELECT payload_json FROM retired_learning_records WHERE entity_type='learning_progress'")).rows[0];
    expect(JSON.parse(String(archived.payload_json))).toMatchObject({ chunk_id: "removed_chunk", fsrs_json: '{"stability":3}' });
    expect((await client.execute("SELECT * FROM review_log")).rows).toHaveLength(1);
    expect((await client.execute("SELECT status FROM learning_sessions")).rows[0].status).toBe("materials_removed");
    await ensureSchema(client, temporary.url);
    expect((await client.execute("SELECT * FROM retired_learning_records")).rows).toHaveLength(2);
  });
  it("题库列表、详情和随机题不再依赖词书存在", async () => {
    const { listQuestions, getQuestionDetail, randomQuestion } = await import("@/lib/questions/service");
    const { questionFiltersSchema } = await import("@/lib/questions/schemas");
    const filters = questionFiltersSchema.parse({});
    expect((await listQuestions(filters)).total).toBe(1);
    expect((await getQuestionDetail("retired_question"))?.textEn).toBe("How do you relax?");
    expect((await randomQuestion(filters))?.id).toBe("retired_question");
  });
  it("已移除材料的会话明确返回 410，客户端不能伪造完成", async () => {
    const { getSessionView } = await import("@/lib/learning/session-service");
    await expect(getSessionView("removed_session")).rejects.toMatchObject({ status: 410, code: "materials_removed" });
    const { POST } = await import("@/app/api/questions/[id]/mastery/route");
    const response = await POST(new Request("http://local", { method: "POST", body: JSON.stringify({ completedFourStep: true }) }), { params: Promise.resolve({ id: "retired_question" }) });
    expect(response.status).toBe(409);
    expect((await client.execute("SELECT * FROM question_mastery")).rows).toHaveLength(0);
  });
});
