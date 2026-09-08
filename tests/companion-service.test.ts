import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { assertInsideTestResults, prepareTestDatabase } from "./helpers/temp-db";

const database = prepareTestDatabase("companion-service");
assertInsideTestResults(database.file);
process.env.ROASTDUCK_DB = database.url;
process.env.ROASTDUCK_SKIP_DB_BACKUP = "1";
process.env.AI_PROVIDER = "mock";

let db: Awaited<ReturnType<typeof import("@db/client").getDbReady>>;
let schema: typeof import("@db/schema");
let service: typeof import("@/lib/companion/service");

function message(text: string, retry = false) {
  return { clientMessageId: randomUUID(), text, inputLanguage: "mixed" as const, messageKind: "text" as const, retry };
}

beforeAll(async () => {
  schema = await import("@db/schema");
  db = await (await import("@db/client")).getDbReady();
  service = await import("@/lib/companion/service");
});

describe("Chloe 统一线程与长期记忆", () => {
  it("同一任务复用一条线程，并且开场消息不重复", async () => {
    const first = await service.createOrGetCompanionThread({ scopeType: "gap", scopeId: "gap_one", title: "取得稳定进步" });
    const second = await service.createOrGetCompanionThread({ scopeType: "gap", scopeId: "gap_one", title: "另一个标题" });
    expect(first?.id).toBe(second?.id);
    expect(first?.messages).toHaveLength(1);
    expect(first?.messages[0]).toMatchObject({ role: "teacher", status: "sent" });
  });

  it("每四个用户回合独立提取一次可追溯记忆，并支持撤销", async () => {
    const thread = await service.createOrGetCompanionThread({ scopeType: "general", scopeId: null });
    if (!thread) throw new Error("线程创建失败");
    const inputs = ["我喜欢咖啡。", "我正在准备雅思。", "今天先练口语。", "我们继续吧。"];
    let latest: Awaited<ReturnType<typeof service.sendCompanionMessage>> | null = null;
    for (const text of inputs) latest = await service.sendCompanionMessage(thread.id, message(text));
    expect(latest?.newMemories).toEqual([expect.objectContaining({ category: "preference", summary: "用户喜欢咖啡。" })]);
    const memories = await service.listCompanionMemories();
    expect(memories).toHaveLength(1);
    expect(memories[0].evidence).toHaveLength(1);
    await service.updateCompanionMemory({ id: memories[0].id, status: "dismissed" });
    expect(await service.listCompanionMemories()).toEqual([]);
  });

  it("相同消息幂等返回，失败时保留原文并要求显式重试", async () => {
    const thread = await service.createOrGetCompanionThread({ scopeType: "gap", scopeId: "gap_retry" });
    if (!thread) throw new Error("线程创建失败");
    const sent = message("怎么更自然地说这句话？");
    const first = await service.sendCompanionMessage(thread.id, sent);
    const repeated = await service.sendCompanionMessage(thread.id, sent);
    expect(repeated.thread.messages).toHaveLength(first.thread.messages.length);

    const failure = message("[mock:companion-always-fail] 请保留我的输入");
    await expect(service.sendCompanionMessage(thread.id, failure)).rejects.toThrow();
    const failed = await service.getCompanionThread(thread.id);
    expect(failed?.messages.find((item) => item.clientMessageId === failure.clientMessageId)).toMatchObject({ text: failure.text, status: "failed" });
    await expect(service.sendCompanionMessage(thread.id, failure)).rejects.toMatchObject({ status: 409 });
  });

  it("同一事实的新版本取代旧版本，但不删除历史证据", async () => {
    const thread = await service.createOrGetCompanionThread({ scopeType: "question", scopeId: "question_memory" });
    if (!thread) throw new Error("线程创建失败");
    for (const text of ["我喜欢咖啡。", "第二条", "第三条", "第四条"]) await service.sendCompanionMessage(thread.id, message(text));
    for (const text of ["我不再喜欢咖啡。", "第六条", "第七条", "第八条"]) await service.sendCompanionMessage(thread.id, message(text));
    const all = await db.select().from(schema.companionMemories).where(eq(schema.companionMemories.sourceType, "chat_message"));
    const coffee = all.filter((item) => JSON.parse(item.detailJson).memoryKey === "preferred_coffee" && item.status !== "dismissed");
    expect(coffee).toHaveLength(2);
    expect(coffee.map((item) => item.status).sort()).toEqual(["active", "superseded"]);
    expect(coffee.find((item) => item.status === "superseded")?.supersededById).toBe(coffee.find((item) => item.status === "active")?.id);
  });

  it("编辑时阻止保存凭证，一键清空会覆盖非活动历史版本", async () => {
    const active = await service.listCompanionMemories();
    expect(active.length).toBeGreaterThan(0);
    await expect(service.updateCompanionMemory({ id: active[0].id, summary: "API key 是 sk-secret-token-value" })).rejects.toMatchObject({ code: "sensitive_memory" });
    const cleared = await service.clearCompanionMemories();
    expect(cleared).toBeGreaterThan(1);
    const rows = await db.select().from(schema.companionMemories);
    expect(rows.every((item) => item.status === "deleted")).toBe(true);
  });
});
