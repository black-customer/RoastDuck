import {beforeEach,expect,it,vi} from "vitest";
const mocks=vi.hoisted(()=>({open:vi.fn(),close:vi.fn(),create:vi.fn(),bootstrap:vi.fn()}));
vi.mock("@capacitor/core",()=>({Capacitor:{getPlatform:()=>"android"},registerPlugin:()=>({backupDatabase:async()=>({backupRef:"synthetic-backup"})})}));
vi.mock("@capacitor-community/sqlite",()=>({CapacitorSQLite:{},SQLiteConnection:class {
  checkConnectionsConsistency=async()=>undefined;
  createConnection=async()=>{mocks.create();return {open:mocks.open};};
  closeConnection=mocks.close;
}}));
vi.mock("../src/lib/platform/android/bootstrap",()=>({bootstrapNativeSchema:mocks.bootstrap}));
beforeEach(()=>{vi.resetModules();for(const mock of Object.values(mocks))mock.mockReset();mocks.open.mockResolvedValue(undefined);mocks.close.mockResolvedValue(undefined);mocks.bootstrap.mockResolvedValue(undefined);});
it("opening shares one connection; reopening waits for close and stale close cannot kill replacement",async()=>{
  const {openNativeDatabase}=await import("../src/lib/platform/android/database");
  const a=openNativeDatabase();expect(openNativeDatabase()).toBe(a);const first=await a;
  let release!:()=>void;mocks.close.mockImplementationOnce(()=>new Promise<void>(resolve=>release=resolve));
  const closed=first.close(),reopened=openNativeDatabase();
  expect(first.close()).toBe(closed);
  await Promise.resolve();expect(mocks.create).toHaveBeenCalledTimes(1);
  await expect(first.database.read(tx=>tx.all({sql:"SELECT 1"}))).rejects.toThrow("正在关闭");
  release();await closed;const second=await reopened;expect(second.database).not.toBe(first.database);
  await first.close();expect(mocks.close).toHaveBeenCalledTimes(1);
});
it("failed close stays failed instead of resolving open with a permanently closed handle",async()=>{
  const {openNativeDatabase}=await import("../src/lib/platform/android/database");
  const first=await openNativeDatabase();mocks.close.mockRejectedValueOnce(new Error("native close failed"));
  await expect(first.close()).rejects.toThrow("native close failed");
  await expect(openNativeDatabase()).rejects.toThrow("重启应用");
  expect(mocks.create).toHaveBeenCalledTimes(1);
});
it("failed initialization never retries through an unconfirmed native close",async()=>{
  mocks.bootstrap.mockRejectedValue(new Error("schema error"));mocks.close.mockRejectedValue(new Error("close error"));
  const {openNativeDatabase}=await import("../src/lib/platform/android/database");
  await expect(openNativeDatabase()).rejects.toThrow("关闭未确认");
  await expect(openNativeDatabase()).rejects.toThrow("重启应用");
  expect(mocks.create).toHaveBeenCalledTimes(1);
});
