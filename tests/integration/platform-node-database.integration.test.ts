import { expect,it } from "vitest";
import { prepareTestDatabase } from "../helpers/temp-db";
const temporary=prepareTestDatabase("platform-node");
process.env.ROASTDUCK_DB=temporary.url;process.env.ROASTDUCK_SKIP_DB_BACKUP="1";process.env.AI_PROVIDER="mock";
it("desktop explicit port preserves bound values, readonly and rollback without global transaction inference",async()=>{
  const {nodeDatabase:db}=await import("@/lib/platform/node/database");
  await db.write(tx=>tx.run({sql:"CREATE TABLE port_values(id TEXT PRIMARY KEY,value TEXT)"}));
  const original="?' 中文🙂 ";
  await db.write(tx=>tx.run({sql:"INSERT INTO port_values VALUES(?,?)",args:["id",original]}));
  expect(await db.read(tx=>tx.all({sql:"SELECT value FROM port_values WHERE id=?",args:["id"]}))).toEqual([{value:original}]);
  await expect(db.read(tx=>tx.all({sql:"INSERT INTO port_values VALUES('bad','forbidden')"}))).rejects.toThrow();
  await expect(db.write(async tx=>{await tx.run({sql:"INSERT INTO port_values VALUES('rollback','x')"});throw new Error("abort");})).rejects.toThrow("abort");
  expect(await db.read(tx=>tx.all({sql:"SELECT id FROM port_values"}))).toEqual([{id:"id"}]);
});
