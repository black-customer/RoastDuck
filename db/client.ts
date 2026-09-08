import fs from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "./schema";
import { ensureSchema } from "./migrate";

export const DB_URL = process.env.ROASTDUCK_DB ?? "file:./data/app.db";

function createDatabase(activeClient: Client) {
  return drizzle(activeClient, { schema });
}

type Database = ReturnType<typeof createDatabase>;

let client: Client | null = null;
let database: Database | null = null;
let schemaReady: Promise<void> | null = null;
const transactionContext = new AsyncLocalStorage<Database>();
let transactionTail: Promise<unknown> = Promise.resolve();

export function getDb() {
  if(process.env.VITEST){
    const file=DB_URL.startsWith("file:")?path.resolve(DB_URL.slice(5)):"";
    const testsRoot=path.resolve("test-results")+path.sep;
    if(!file.startsWith(testsRoot))throw new Error("自动化数据库必须位于 test-results；拒绝连接真实数据或远端服务");
  }
  const transaction = transactionContext.getStore();
  if (transaction) return transaction;
  if (!client) {
    if (DB_URL.startsWith("file:")) {
      const filePath = DB_URL.slice("file:".length);
      const dir = path.dirname(path.resolve(filePath));
      fs.mkdirSync(dir, { recursive: true });
    }
    client = createClient({ url: DB_URL });
    database = createDatabase(client);
    schemaReady = ensureSchema(client, DB_URL);
  }
  return database!;
}

/** 新代码必须等待编号迁移完成后再访问表；getDb 仅保留给已存在的同步建构点。 */
export async function getDbReady() {
  const db = getDb();
  await schemaReady;
  return db;
}

export type Db = ReturnType<typeof getDb>;

/** 只包围短数据库操作，禁止在事务内等待 AI/网络。嵌套服务复用同一事务。 */
export async function withDbTransaction<T>(work: () => Promise<T>): Promise<T> {
  if (transactionContext.getStore()) return work();
  const run = transactionTail.then(async () => {
    const db = await getDbReady();
    return db.transaction((tx) => transactionContext.run(tx as unknown as Database, work));
  });
  transactionTail = run.catch(() => undefined);
  return run;
}
export { schema };
