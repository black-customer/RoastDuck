import { createClient } from "@libsql/client";
import fs from "node:fs";
import path from "node:path";
import { auditPracticeMaterials } from "../src/lib/four-step/audit";
const url = process.env.ROASTDUCK_DB || "file:./data/app.db";
if (!url.startsWith("file:")) throw new Error("只允许审计本地材料数据库");
const file = path.resolve(url.slice(5));
if (!fs.existsSync(file)) throw new Error("数据库不存在；先执行 init，不在审计中创建空库");
const relative = path.relative(path.resolve("test-results"), file);
const isolated = !relative.startsWith("..") && !path.isAbsolute(relative);
const client = createClient({ url });
try {
  await client.execute("PRAGMA query_only=ON");
  const result = await auditPracticeMaterials(client, isolated && process.env.AI_PROVIDER === "mock");
  const directory = path.resolve(process.env.ROASTDUCK_REPORTS_DIR || "test-results/material-audit");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "materials-audit.json"), JSON.stringify({ ...result, isolated, checkedAt: new Date().toISOString() }, null, 2));
  console.log(JSON.stringify(result));
  if (!result.checked) console.log("尚无正式可学的四步材料；这不代表内容已验收。");
  if (!result.ok) process.exitCode = 1;
} finally { client.close(); }
