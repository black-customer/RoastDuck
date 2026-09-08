import { beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { prepareTestDatabase } from "../helpers/temp-db";

const database = prepareTestDatabase("content-review.integration");
process.env.ROASTDUCK_DB = database.url;
process.env.ROASTDUCK_SKIP_DB_BACKUP = "1";
let route: typeof import("@/app/api/review-content/route");
let db: Awaited<ReturnType<typeof import("@db/client")["getDbReady"]>>;

beforeAll(async () => {
  db = await (await import("@db/client")).getDbReady();
  await db.run(sql`INSERT INTO books (id,title_zh,title_en,source_type) VALUES ('review-book','测试','Fixture','question_bank')`);
  await db.run(sql`INSERT INTO chunks (id,book_id,canonical_chunk,display_chunk,unit_type,meaning_zh,quality_status,review_provenance)
    VALUES ('review-chunk','review-book','stay focused','stay focused','lexical_chunk','保持专注','approved','independent_reviewer')`);
  await db.run(sql`INSERT INTO learning_progress (chunk_id,intro_done,mastery) VALUES ('review-chunk',1,'learning')`);
  route = await import("@/app/api/review-content/route");
});
const post = (body: unknown) => route.POST(new Request("http://localhost/api/review-content", { method: "POST", body: JSON.stringify(body) }));

describe("内容管理不能绕过独立审核", () => {
  it("拒绝直接通过，保留原有审核和进度", async () => {
    expect((await post({ id: "review-chunk", action: "approve" })).status).toBe(409);
    expect(await db.all(sql`SELECT id FROM content_amendments`)).toHaveLength(0);
    expect((await db.all<{ status: string }>(sql`SELECT quality_status AS status FROM chunks WHERE id='review-chunk'`))[0].status).toBe("approved");
  });
  it("修改追加前后快照并退回待审；重复提交不重记，稳定 ID 和进度不变", async () => {
    const body = { id: "review-chunk", action: "edit", fields: { meaningZh: "集中注意力" } };
    expect(await (await post(body)).json()).toMatchObject({ ok: true, changed: true, qualityStatus: "pending_review" });
    expect(await (await post(body)).json()).toMatchObject({ changed: false });
    const rows = await db.all<{ before_json: string; after_json: string }>(sql`SELECT * FROM content_amendments`);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].before_json)).toMatchObject({ id: "review-chunk", meaning_zh: "保持专注", quality_status: "approved" });
    expect(JSON.parse(rows[0].after_json)).toMatchObject({ id: "review-chunk", meaning_zh: "集中注意力", quality_status: "pending_review", reviewer_version: null, review_provenance: "unreviewed" });
    expect(await db.all(sql`SELECT chunk_id,intro_done FROM learning_progress`)).toEqual([{ chunk_id: "review-chunk", intro_done: 1 }]);
  });
  it("隐藏不删除表达，原因必填且忽略无关编辑字段", async () => {
    expect((await post({ id: "review-chunk", action: "reject" })).status).toBe(400);
    const body = { id: "review-chunk", action: "reject", reason: "含义需要重新核实", fields: { displayChunk: "should not change" } };
    expect((await post(body)).status).toBe(200);
    expect(await (await post(body)).json()).toMatchObject({ changed: false });
    expect(await db.all(sql`SELECT display_chunk,quality_status FROM chunks WHERE id='review-chunk'`)).toEqual([{ display_chunk: "stay focused", quality_status: "rejected" }]);
    expect(await db.all(sql`SELECT id FROM content_amendments`)).toHaveLength(2);
  });
  it("非法 JSON、空编辑、未知 ID 和错误分页不导致假成功或状态写入", async () => {
    expect((await route.POST(new Request("http://localhost/api/review-content", { method: "POST", body: "{" }))).status).toBe(400);
    expect((await post({ id: "review-chunk", action: "edit", fields: {} })).status).toBe(400);
    expect((await post({ id: "missing-chunk", action: "edit", fields: { meaningZh: "缺失" } })).status).toBe(404);
    expect((await route.GET(new Request("http://localhost/api/review-content?limit=no"))).status).toBe(400);
    expect((await route.GET(new Request("http://localhost/api/review-content?status=no"))).status).toBe(400);
  });
});
