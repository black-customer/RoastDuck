import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { setImmediate } from "node:timers/promises";
import { projectRuntime } from "../project-runtime.mjs";

// Synthetic, process-isolated native lifecycle probe. Never accepts a user DB path.
const mode = process.argv[2]?.startsWith("--") ? null : process.argv[2];
if (!mode) {
  const runtime = projectRuntime();
  const results = [];
  for (const variant of process.argv.includes("--rows-only") ? ["rows"] : ["transaction", "batch", "persistent"]) {
    const result = spawnSync(runtime.nodePath, ["--expose-gc", "--max-old-space-size=64", import.meta.filename, variant], {
      encoding: "utf8", timeout: 90_000, windowsHide: true,
      env: { ...process.env, NODE_OPTIONS: "", AI_PROVIDER: "mock", DEEPSEEK_API_KEY: "", MIMO_API_KEY: "" },
    });
    results.push({ variant, exitCode: result.status, signal: result.signal, error: result.error?.message, stdout: result.stdout, stderr: result.stderr });
    console.log(JSON.stringify(results.at(-1)));
  }
  fs.mkdirSync("test-results/native-probe", { recursive: true });
  fs.writeFileSync(`test-results/native-probe/result-${Date.now()}.json`, JSON.stringify(results, null, 2));
  if (results.some(result => result.exitCode !== 0)) process.exitCode = 1;
} else {
  if (!["transaction", "batch", "persistent", "rows"].includes(mode)) throw new Error("Unknown probe variant");
  fs.mkdirSync("test-results", { recursive: true });
  const directory = fs.mkdtempSync(path.resolve("test-results/native-probe-"));
  const { createClient } = await import("@libsql/client");
  const client = createClient({ url: `file:${path.join(directory, "synthetic.db")}` });
  await client.execute("CREATE TABLE probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
  console.log(JSON.stringify({ node: process.version, mode, directory, modules: process.report.getReport().sharedObjects.filter(file => file.endsWith(".node")) }));
  if (mode === "rows") {
    const value = JSON.stringify({ text: "synthetic 中英文 ".repeat(700) });
    await client.batch(Array.from({ length: 201 }, (_, id) => ({ sql: "INSERT INTO probe VALUES (?,?)", args: [id, value] })), "write");
    for (let index = 0; index < 200; index++) {
      const tx = await client.transaction("write");
      await tx.execute({ sql: "INSERT INTO probe VALUES (?,?) ON CONFLICT DO NOTHING RETURNING *", args: [index % 201, value] });
      await tx.commit();
      for (const limit of [0, 99, 100, 101, 201]) {
        const rows = await client.execute({ sql: "SELECT id,value,value AS a,value AS b FROM probe LIMIT ?", args: [limit] });
        if (rows.rows.length !== limit) throw new Error("Row count mismatch");
      }
      if (index % 10 === 0) console.log(JSON.stringify({ index, mode }));
      await setImmediate();
    }
    client.close();
    console.log("PASS 200 bounded large-result iterations");
    process.exit(0);
  }
  for (let index = 0; index < 500; index++) {
    const statement = { sql: "INSERT INTO probe VALUES (?,?)", args: [index, "synthetic"] };
    if (mode === "transaction") {
      await (async () => {
        const tx = await client.transaction("write");
        await tx.execute(statement);
        await tx.execute("SELECT COUNT(*) FROM probe");
        await tx.commit();
      })();
    } else if (mode === "batch") {
      await client.batch([statement, "SELECT COUNT(*) FROM probe"], "write");
    } else {
      await client.execute("BEGIN IMMEDIATE");
      await client.execute(statement);
      await client.execute("SELECT COUNT(*) FROM probe");
      await client.execute("COMMIT");
    }
    await client.execute("SELECT COUNT(*) FROM probe");
    await setImmediate();
    global.gc();
    if (index % 50 === 0) console.log(JSON.stringify({ index, mode }));
  }
  client.close();
  global.gc();
  console.log("PASS 500 synthetic iterations");
}
