import { expect,it } from "vitest";
import { SerialDatabase,type TransactionDriver,type SqlWriter } from "../src/lib/platform/database";
function fixture(){
  const trace:string[]=[];let committed=0,pending=0;
  const driver:TransactionDriver={
    async begin(mode){trace.push(`begin:${mode}`);pending=committed;},
    async all<T>(){trace.push("read");return [{value:pending}] as T[];},
    async run(command){trace.push("write");pending=Number(command.args![0]);return {changes:1};},
    async commit(){trace.push("commit");committed=pending;},
    async rollback(){trace.push("rollback");pending=committed;},
  };
  return {db:new SerialDatabase(driver),driver,trace};
}
it("independent reads/writes cannot enter another async native transaction or be rolled back with it",async()=>{
  const {db,trace}=fixture();let release!:()=>void,entered!:()=>void;
  const gate=new Promise<void>(resolve=>release=resolve),started=new Promise<void>(resolve=>entered=resolve);
  const first=db.write(async tx=>{await tx.run({sql:"set",args:[5]});entered();await gate;throw new Error("rollback A");});
  const firstResult=expect(first).rejects.toThrow("rollback A");
  await started;
  const read=db.read(async tx=>{expect("run" in tx).toBe(false);return tx.all<{value:number}>({sql:"read"});});
  const second=db.write(tx=>tx.run({sql:"set",args:[8]}));
  await Promise.resolve();expect(trace).toEqual(["begin:write","write"]);
  release();await firstResult;
  expect(await read).toEqual([{value:0}]);await second;
  expect(await db.read(tx=>tx.all({sql:"read"}))).toEqual([{value:8}]);
});
it("scoped handles cannot be used after completion; commit failure is never reported as saved",async()=>{
  const {db,driver}=fixture();let leaked!:SqlWriter;
  await db.write(async tx=>{leaked=tx;await tx.run({sql:"set",args:[1]});});
  await expect(leaked.run({sql:"set",args:[2]})).rejects.toThrow("已关闭");
  driver.commit=async()=>{throw new Error("disk full");};
  await expect(db.write(tx=>tx.run({sql:"set",args:[3]}))).rejects.toThrow("disk full");
});
it("rollback failure poisons the connection rather than letting later work join unknown state",async()=>{
  const {db,driver}=fixture();driver.rollback=async()=>{throw new Error("driver failure");};
  await expect(db.write(async()=>{throw new Error("original failure");})).rejects.toThrow("回滚未确认");
  await expect(db.read(tx=>tx.all({sql:"read"}))).rejects.toThrow("重新打开");
});
it("closing drains accepted work and rejects new work without interrupting a pending commit",async()=>{
  const {db,trace}=fixture();let release!:()=>void;
  const gate=new Promise<void>(resolve=>release=resolve);
  const pending=db.write(async tx=>{await gate;await tx.run({sql:"set",args:[6]});});
  const closing=db.close(async()=>{trace.push("close");});
  expect(db.close(async()=>{throw new Error("second close");})).toBe(closing);
  await expect(db.read(tx=>tx.all({sql:"read"}))).rejects.toThrow("正在关闭");
  release();await pending;await closing;
  expect(trace).toEqual(["begin:write","write","commit","close"]);
});
