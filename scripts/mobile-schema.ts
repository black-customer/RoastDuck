import fs from "node:fs";
import path from "node:path";
import { createClient } from "@libsql/client";
import { ensureSchema } from "../db/migrate";
import { sha256Text } from "../src/lib/platform/hash";

// Deterministic schema-only artifact from a brand-new, isolated database. No user rows.
process.env.ROASTDUCK_SKIP_DB_BACKUP="1";
fs.mkdirSync("test-results",{recursive:true});
const directory=fs.mkdtempSync(path.resolve("test-results/mobile-schema-"));
const client=createClient({url:`file:${path.join(directory,"empty.db")}`});
try{
  await ensureSchema(client,`file:${path.join(directory,"empty.db")}`);
  const definitions=(await client.execute("SELECT name,type,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END,name")).rows;
  const statements=definitions.map(row=>String(row.sql));
  const version=Number((await client.execute("SELECT MAX(version) AS version FROM _schema_migrations")).rows[0].version);
  const artifact={formatVersion:1,schemaVersion:version,sha256:sha256Text(JSON.stringify(statements)),statements};
  fs.mkdirSync("src/lib/platform/android/generated",{recursive:true});
  fs.writeFileSync("src/lib/platform/android/generated/schema.json",JSON.stringify(artifact,null,2)+"\n");
  console.log(JSON.stringify({schemaVersion:version,statements:statements.length,sha256:artifact.sha256,userDataRead:false,runtimeCalls:0}));
}finally{client.close();}
