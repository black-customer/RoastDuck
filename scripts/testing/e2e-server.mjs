/** 直接启动测试专用 Next 进程并保留退出证据；不自动重启掩盖崩溃。 */
import {spawn} from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {pathToFileURL} from "node:url";
const port=process.argv[2];
if(!/^\d+$/.test(port??"")||Number(port)<1024||Number(port)>65535)throw new Error("无效测试端口");
const directory=path.resolve("test-results",`e2e-server-${Date.now()}`);
fs.mkdirSync(directory,{recursive:true});
const diagnostics=process.env.ROASTDUCK_E2E_DIAGNOSTICS==="1";
const preload=diagnostics?["--import",pathToFileURL(path.resolve("scripts/testing/e2e-diagnostics.mjs")).href]:[];
fs.writeFileSync(path.join(directory,"runtime.json"),JSON.stringify({node:process.version,execPath:process.execPath,diagnostics}));
const nodeArgs=[...preload,"node_modules/next/dist/bin/next","start","-H","127.0.0.1","-p",port];
const nativeProbe=process.platform==='win32'&&process.env.ROASTDUCK_WIN_DEBUGGER==='1';
const probeConfig=path.join(directory,'native-probe.json');
if(nativeProbe)fs.writeFileSync(probeConfig,JSON.stringify({node:process.execPath,arguments:nodeArgs,directory:process.cwd(),evidence:directory}));
const executable=nativeProbe?path.join(process.env.SystemRoot??'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe'):process.execPath;
const arguments_=nativeProbe?['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.resolve('scripts/testing/windows-native-probe.ps1'),'-Config',probeConfig]:nodeArgs;
const child=spawn(executable,arguments_,{
  shell:false,windowsHide:true,stdio:["ignore","pipe","pipe"],
  env:{...process.env,ROASTDUCK_E2E_DIAGNOSTIC_DIR:diagnostics?directory:"",AI_PROVIDER:"mock",ROASTDUCK_E2E:"1",ROASTDUCK_DB:"file:./test-results/e2e.db",ROASTDUCK_SKIP_DB_BACKUP:"1",MIMO_API_KEY:"",DEEPSEEK_API_KEY:""},
});
for(const [name,stream,destination] of [["stdout",child.stdout,process.stdout],["stderr",child.stderr,process.stderr]]){
  stream.on("data",chunk=>{fs.appendFileSync(path.join(directory,`${name}.log`),chunk);destination.write(chunk);});
}
child.on("error",error=>{fs.writeFileSync(path.join(directory,"spawn-error.json"),JSON.stringify({code:error.code}));process.exitCode=1;});
child.on("exit",(code,signal)=>{
  fs.writeFileSync(path.join(directory,"exit.json"),JSON.stringify({code,signal,at:new Date().toISOString()}));
  console.log(`E2E 服务退出：${code ?? signal}；证据 ${directory}`);
  process.exitCode=code??1;
});
const stop=reason=>{if(child.exitCode===null&&!child.killed){fs.appendFileSync(path.join(directory,"lifecycle.jsonl"),JSON.stringify({kind:"kill_requested",reason,at:new Date().toISOString()})+"\n");child.kill();}};
process.on("SIGINT",()=>stop("SIGINT"));process.on("SIGTERM",()=>stop("SIGTERM"));process.on("exit",()=>stop("parent_exit"));
