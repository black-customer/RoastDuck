import { expect,it,vi } from "vitest";
import { AndroidSqliteDriver } from "../src/lib/platform/android/sqlite-driver";
import { SerialDatabase } from "../src/lib/platform/database";
function fixture(){
  const connection={execute:vi.fn(async()=>({changes:{changes:0}})),query:vi.fn(async()=>({values:[{value:7}]})),
    run:vi.fn(async()=>({changes:{changes:1,lastId:3}})),beginTransaction:vi.fn(async()=>({changes:{changes:0}})),
    commitTransaction:vi.fn(async()=>({changes:{changes:0}})),rollbackTransaction:vi.fn(async()=>({changes:{changes:0}})),isTransactionActive:vi.fn(async()=>({result:false}))};
  const driver=new AndroidSqliteDriver(connection);
  return {connection,driver,db:new SerialDatabase(driver)};
}
it("read scope enforces SQLite query_only and resets it; write uses one explicit native transaction",async()=>{
  const {db,connection}=fixture();
  expect(await db.read(tx=>tx.all({sql:"SELECT value"}))).toEqual([{value:7}]);
  expect(connection.execute).toHaveBeenNthCalledWith(1,"PRAGMA query_only=OFF",false);
  expect(connection.execute).toHaveBeenNthCalledWith(2,"PRAGMA query_only=ON",false);
  expect(connection.execute.mock.invocationCallOrder[1]).toBeGreaterThan(connection.beginTransaction.mock.invocationCallOrder[0]);
  expect(connection.execute).toHaveBeenNthCalledWith(3,"PRAGMA query_only=OFF",false);
  expect(await db.write(tx=>tx.run({sql:"UPDATE example SET value=?",args:[3]}))).toEqual({changes:1,lastInsertRowId:3});
  expect(connection.run).toHaveBeenCalledWith("UPDATE example SET value=?",[3],false,"no");
});
it("unsupported binary/unsafe numeric parameters reject rather than silently corrupting values",async()=>{
  const {db}=fixture();
  for(const value of [new Uint8Array([1]),BigInt(Number.MAX_SAFE_INTEGER)+1n,Number.NaN]){
    await expect(db.write(tx=>tx.run({sql:"UPDATE example SET value=?",args:[value]}))).rejects.toThrow();
  }
});
it("missing bind values never silently become NULL on Android",async()=>{
  const {db,connection}=fixture();
  await expect(db.write(tx=>tx.run({sql:"INSERT INTO example VALUES(?,?)",args:["id"]}))).rejects.toThrow("数量");
  expect(connection.run).not.toHaveBeenCalled();
  await expect(db.read(tx=>tx.all({sql:"SELECT :missing"}))).rejects.toThrow("命名");
  expect(connection.query).not.toHaveBeenCalled();
});
