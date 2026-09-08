import { expect,it } from "vitest";
import { createClient } from "@libsql/client";
import {createHash} from "node:crypto";
import { V20_DDL } from "../../db/migrations/v20-material-evidence";
import { V19_DDL } from "../../db/migrations/v19-four-step";
import { prepareTestDatabase,assertInsideTestResults } from "../helpers/temp-db";
import {migrationHistory,removePostV25Schema} from '../helpers/legacy-schema';

it("v20 旧分析原样归档，旧快照默认旧版本，无任何学习进度删除",async()=>{
  const temp=prepareTestDatabase("v20-archive-fixture");assertInsideTestResults(temp.file);
  const client=createClient({url:temp.url});
  try {
    await client.execute("CREATE TABLE practice_materials(id TEXT PRIMARY KEY)");
    await client.execute("CREATE TABLE speaking_question_attempts(id TEXT PRIMARY KEY,analysis_json TEXT,natural_version TEXT,answer_text TEXT)");
    await client.execute("CREATE TABLE learning_items(id TEXT PRIMARY KEY)");
    await client.execute("INSERT INTO practice_materials VALUES('old-material')");
    await client.execute("INSERT INTO learning_items VALUES('stable-item')");
    await client.execute({sql:"INSERT INTO speaking_question_attempts VALUES(?,?,?,?)",args:["old-answer",'{"legacy":"synthetic evidence"}',"Old reference.","Original answer."]});
    for(const ddl of V20_DDL) await client.execute(ddl);
    expect((await client.execute("SELECT contract_version FROM practice_materials")).rows[0].contract_version).toBe("legacy_v1");
    expect((await client.execute("SELECT analysis_json FROM practice_legacy_analyses")).rows[0].analysis_json).toBe('{"legacy":"synthetic evidence"}');
    expect((await client.execute("SELECT answer_text FROM speaking_question_attempts")).rows[0].answer_text).toBe("Original answer.");
    expect((await client.execute("SELECT * FROM learning_items")).rows).toHaveLength(1);
  }finally{client.close();}
});
it("连续迁移可重跑；v20 校验和被篡改时拒绝启动",async()=>{
  const temp=prepareTestDatabase("v20-continuity");assertInsideTestResults(temp.file);
  const client=createClient({url:temp.url});
  process.env.ROASTDUCK_SKIP_DB_BACKUP="1";
  try {
    const {ensureSchema}=await import("../../db/migrate");
    await ensureSchema(client,temp.url);
    const before=await migrationHistory(client);
    await ensureSchema(client,temp.url);
    expect((await migrationHistory(client)).map(row=>row.version)).toEqual(Array.from({length:32},(_,index)=>index+1));
    expect(await migrationHistory(client)).toEqual(before);
    await client.execute("UPDATE _schema_migrations SET checksum='synthetic-tamper' WHERE version=20");
    await expect(ensureSchema(client,temp.url)).rejects.toThrow("checksum");
  }finally{client.close();}
});

it("真实早期 v19 漏版本表的历史结构由 v21 补齐，保留原 checksum",async()=>{
  const temp=prepareTestDatabase("v21-early-v19");assertInsideTestResults(temp.file);
  const client=createClient({url:temp.url});
  process.env.ROASTDUCK_SKIP_DB_BACKUP="1";
  try {
    const {ensureSchema}=await import("../../db/migrate");
    await ensureSchema(client,temp.url);
    await removePostV25Schema(client,temp.url);
    // 仅此显式创建的临时库：重建缺表的早期 v19 迁移状态，不碰真实库。
    await client.execute("DROP TABLE practice_material_revisions");
    await client.execute("DELETE FROM _schema_migrations WHERE version>=21");
    for (const table of ["light_study_events","light_study_sessions","light_study_progress"]) await client.execute(`DROP TABLE ${table}`);
    const earlyChecksum=createHash("sha256").update(V19_DDL.filter((s)=>!s.includes("practice_material_revisions")).join("\n")).digest("hex");
    expect(earlyChecksum).toBe("2f19dafb503e4ceadb5e34cdd8f9caee20f5a7e98adfd50081223192f4041900");
    await client.execute({sql:"UPDATE _schema_migrations SET checksum=? WHERE version=19",args:[earlyChecksum]});
    const previousHistory=await migrationHistory(client,20);
    await ensureSchema(client,temp.url);
    expect((await migrationHistory(client)).map(row=>row.version)).toEqual(Array.from({length:32},(_,index)=>index+1));
    expect(await migrationHistory(client,20)).toEqual(previousHistory);
    expect((await client.execute("SELECT name FROM sqlite_master WHERE name='practice_material_revisions'")).rows).toHaveLength(1);
    expect((await client.execute("SELECT checksum FROM _schema_migrations WHERE version=19")).rows[0].checksum).toBe(earlyChecksum);
    await ensureSchema(client,temp.url);
  }finally{client.close();}
});
