import { expect,it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { projectRuntime,runtimeEnvironment } from "../scripts/project-runtime.mjs";
function fixture(config?:unknown) {
  fs.mkdirSync("test-results",{recursive:true});
  const root=fs.mkdtempSync(path.resolve("test-results/runtime-"));
  if(config!==undefined){fs.mkdirSync(path.join(root,"data/desktop"),{recursive:true});fs.writeFileSync(path.join(root,"data/desktop/runtime.json"),JSON.stringify(config));}
  return root;
}
it("无本机配置保持原Node；有效配置只影响本项目",()=>{
  expect(projectRuntime(fixture())).toMatchObject({nodePath:process.execPath,source:"current"});
  expect(projectRuntime(fixture({nodePath:process.execPath,validatedVersion:process.version}))).toMatchObject({nodePath:process.execPath,version:process.version,source:"project",warning:null});
});
it("拒绝相对路径、非Node程序和失效配置，不执行任意命令",()=>{
  for(const nodePath of ["node",process.execPath+";echo unsafe",path.resolve("test-results/missing/node.exe")]) expect(()=>projectRuntime(fixture({nodePath}))).toThrow();
});
it("版本变化告警，子进程PATH不修改宿主对象且不产生大小写重复",()=>{
  expect(projectRuntime(fixture({nodePath:process.execPath,validatedVersion:"v0.0.0"})).warning).toContain("版本已变化");
  const original={Path:"old",PATH:"duplicate",OTHER:"keep",NODE_ENV:"test" as const};
  const result=runtimeEnvironment({nodePath:process.execPath},original);
  expect(result.Path).toBe(path.dirname(process.execPath)+path.delimiter+"old");expect(result.PATH).toBeUndefined();expect(original.PATH).toBe("duplicate");expect(result.OTHER).toBe("keep");
});
