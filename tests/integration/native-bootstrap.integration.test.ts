import { createClient } from "@libsql/client";
import { expect,it } from "vitest";
import { prepareTestDatabase } from "../helpers/temp-db";
import { SerialDatabase,type TransactionDriver,type SqlCommand } from "@/lib/platform/database";
import { bootstrapNativeSchema } from "@/lib/platform/android/bootstrap";
import { sha256Text } from "@/lib/platform/hash";

it("fresh native bootstrap is atomic and idempotent, does not invent desktop migration history or overwrite unknown data",async()=>{
  const temporary=prepareTestDatabase("native-bootstrap");
  const client=createClient({url:temporary.url});
  const driver:TransactionDriver={
    async begin(){await client.execute("BEGIN IMMEDIATE");},async commit(){await client.execute("COMMIT");},async rollback(){await client.execute("ROLLBACK");},
    async all<T>(command:SqlCommand){return (await client.execute({sql:command.sql,args:command.args})).rows as T[];},
    async run(command){const result=await client.execute({sql:command.sql,args:command.args});return {changes:result.rowsAffected};},
  };
  const database=new SerialDatabase(driver);
  const statements=["CREATE TABLE _schema_migrations(version INTEGER)","CREATE TABLE original_answers(id TEXT PRIMARY KEY,text TEXT)"];
  const snapshot={formatVersion:1,schemaVersion:25,sha256:sha256Text(JSON.stringify(statements)),statements};
  try{
    expect(await bootstrapNativeSchema(database,snapshot)).toMatchObject({created:true});
    await client.execute("INSERT INTO original_answers VALUES('kept','synthetic original')");
    expect(await bootstrapNativeSchema(database,snapshot)).toMatchObject({created:false});
    expect((await client.execute("SELECT * FROM _schema_migrations")).rows).toHaveLength(0);
    expect((await client.execute("SELECT * FROM original_answers")).rows).toHaveLength(1);
    await expect(bootstrapNativeSchema(database,{...snapshot,sha256:"tampered"})).rejects.toThrow("校验失败");
    await client.execute("DROP TABLE _native_schema_bootstrap");
    await expect(bootstrapNativeSchema(database,snapshot)).rejects.toThrow("停止覆盖");
    expect((await client.execute("SELECT * FROM original_answers")).rows).toHaveLength(1);
  }finally{client.close();}
});
