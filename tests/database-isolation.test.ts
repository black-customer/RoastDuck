import {afterEach,expect,it,vi} from "vitest";
afterEach(()=>{vi.unstubAllEnvs();vi.resetModules();});
it.each(["file:./data/app.db","libsql://example.invalid","file:./outside-test.db"])("自动化不能打开真实库或测试目录以外的库：%s",async(url)=>{
  vi.stubEnv("ROASTDUCK_DB",url);vi.stubEnv("VITEST","true");vi.resetModules();
  const {getDb}=await import("@db/client");
  expect(()=>getDb()).toThrow("自动化数据库必须位于 test-results");
});
