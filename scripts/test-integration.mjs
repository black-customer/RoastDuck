/** Windows 本地 libSQL 使用每文件独立进程，防止 native 句柄跨 Vitest worker 生命周期。
 * 不跳过失败：逐文件执行全部断言，持久化每个退出码；崩溃/超时同样失败。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
const args=process.argv.slice(2);
const filters=args.filter(a=>!a.startsWith("--"));
const options=args.filter(a=>a.startsWith("--"));
const files=fs.readdirSync("tests/integration").filter(f=>f.endsWith(".integration.test.ts"))
  .map(f=>`tests/integration/${f}`).filter(f=>!filters.length||filters.some(filter=>f.includes(filter.replaceAll("\\","/")))).sort();
if(!files.length)throw new Error("没有匹配的集成测试，不能以零测试通过");
const directory=path.resolve("test-results",`integration-${Date.now()}`);
fs.mkdirSync(directory,{recursive:true});
const results=[];
for(const file of files){
  const evidence=path.join(directory,path.basename(file,".ts"));
  fs.mkdirSync(evidence,{recursive:true});
  console.log(`集成测试：${file}`);
  const result=spawnSync(process.execPath,["--require",path.resolve("scripts/testing/worker-evidence.cjs"),"node_modules/vitest/vitest.mjs","run","--config","vitest.integration.config.ts",file,...options],{
    shell:false,stdio:["ignore","pipe","pipe"],encoding:"utf8",maxBuffer:32*1024*1024,timeout:120000,windowsHide:true,
    env:{...process.env,NODE_OPTIONS:"",AI_PROVIDER:"mock",DEEPSEEK_API_KEY:"",MIMO_API_KEY:"",
      ROASTDUCK_WORKER_EVIDENCE_DIR:evidence,
      ROASTDUCK_DB:`file:${path.join(directory,`${path.basename(file)}.db`).replaceAll("\\","/")}`,ROASTDUCK_SKIP_DB_BACKUP:"1"},
  });
  fs.writeFileSync(path.join(evidence,"stdout.log"),result.stdout??"");
  fs.writeFileSync(path.join(evidence,"stderr.log"),result.stderr??"");
  if(result.stdout)process.stdout.write(result.stdout);
  if(result.stderr)process.stderr.write(result.stderr);
  results.push({file,exitCode:result.status??1,signal:result.signal,error:result.error?.code??null,evidence});
  fs.writeFileSync(path.join(directory,"results.json"),JSON.stringify(results,null,2));
}
console.log(JSON.stringify({files:files.length,failures:results.filter(r=>r.exitCode!==0),evidence:directory}));
if(results.some(r=>r.exitCode!==0))process.exitCode=1;
