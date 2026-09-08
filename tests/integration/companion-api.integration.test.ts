import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { assertInsideTestResults, prepareTestDatabase } from "../helpers/temp-db";

const database = prepareTestDatabase("companion-api.integration");
assertInsideTestResults(database.file);
process.env.ROASTDUCK_DB = database.url;
process.env.ROASTDUCK_SKIP_DB_BACKUP = "1";
process.env.AI_PROVIDER = "mock";

let threadRoute: typeof import("@/app/api/companion/threads/route");
let messageRoute: typeof import("@/app/api/companion/threads/[id]/messages/route");
let memoryRoute: typeof import("@/app/api/companion/memories/route");

beforeAll(async () => {
  [threadRoute, messageRoute, memoryRoute] = await Promise.all([
    import("@/app/api/companion/threads/route"),
    import("@/app/api/companion/threads/[id]/messages/route"),
    import("@/app/api/companion/memories/route"),
  ]);
});

function request(url: string, method: string, body?: unknown) {
  return new Request(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
}

describe("Chloe API", () => {
  it("创建线程、发送混合消息并可恢复读取", async () => {
    const created = await threadRoute.POST(request("http://local/api/companion/threads", "POST", { scopeType: "general", scopeId: null }));
    expect(created.status).toBe(201);
    const thread = (await created.json()).thread as { id: string; messages: unknown[] };
    expect(thread.messages).toHaveLength(1);

    const clientMessageId = randomUUID();
    const sent = await messageRoute.POST(request("http://local/messages", "POST", { clientMessageId, text: "I like coffee，也想提高口语。", inputLanguage: "mixed", messageKind: "text" }), { params: Promise.resolve({ id: thread.id }) });
    expect(sent.status).toBe(200);
    expect((await sent.json()).thread.messages).toHaveLength(4);
    const loaded = await messageRoute.GET(request("http://local/messages", "GET"), { params: Promise.resolve({ id: thread.id }) });
    expect(loaded.status).toBe(200);
    expect((await loaded.json()).thread.messages[1]).toMatchObject({ text: "I like coffee，也想提高口语。", status: "sent" });
  });

  it("拒绝非法作用域，并支持记忆修改和清空", async () => {
    const invalid = await threadRoute.POST(request("http://local/api/companion/threads", "POST", { scopeType: "gap", scopeId: null }));
    expect(invalid.status).toBe(400);

    const service = await import("@/lib/companion/service");
    const db = await (await import("@db/client")).getDbReady();
    const schema = await import("@db/schema");
    await db.insert(schema.companionMemories).values({ id: "memory_api", category: "goal", summary: "用户准备雅思。", sourceType: "test", sourceId: "source_api" });
    const patched = await memoryRoute.PATCH(request("http://local/api/companion/memories", "PATCH", { id: "memory_api", summary: "用户正在准备雅思口语。" }));
    expect(patched.status).toBe(200);
    expect((await patched.json()).memory.summary).toContain("雅思口语");
    expect(await service.listCompanionMemories()).toHaveLength(1);
    const cleared = await memoryRoute.DELETE(request("http://local/api/companion/memories", "DELETE", { all: true }));
    expect(cleared.status).toBe(200);
    expect((await cleared.json()).deleted).toBe(1);
  });
});
