import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn,spawnSync} from 'node:child_process';
import {projectRuntime,runtimeEnvironment} from '../project-runtime.mjs';
import {activateRelease,fingerprintSources,releaseDirectory} from './releases.mjs';

const root=path.resolve(fileURLToPath(new URL('../../',import.meta.url)));
const runtime=projectRuntime(root);
const git=(...args)=>{
  const result=spawnSync('git',args,{cwd:root,encoding:'utf8',windowsHide:true,shell:false});
  if(result.status!==0)throw new Error('无法读取本机 Git 构建基准');
  return result.stdout;
};
const sourceFiles=()=>git('ls-files','--cached','--others','--exclude-standard','-z').split('\0').filter(Boolean);
const sourceHash=fingerprintSources(root,sourceFiles());
const commit=git('rev-parse','--short=12','HEAD').trim();
const releaseId=`${commit}-${sourceHash.slice(0,10)}-${Date.now()}`;
const directory=releaseDirectory(root,releaseId);
fs.mkdirSync(directory,{recursive:true});
// Next may add generated type paths. Keep those edits out of the tracked tsconfig.
fs.writeFileSync(path.join(root,'.next-desktop',`tsconfig-${releaseId}.json`),JSON.stringify({
  extends:'../tsconfig.json',
  compilerOptions:{baseUrl:root,tsBuildInfoFile:`./releases/${releaseId}/build.tsbuildinfo`},
  include:['../next-env.d.ts','../src/**/*.ts','../src/**/*.tsx','../db/**/*.ts','../pipeline/**/*.ts',`./releases/${releaseId}/types/**/*.ts`],
  exclude:['../node_modules','../test-results','../data','../.publish'],
},null,2),{flag:'wx'});
const nextCli=path.join(root,'node_modules','next','dist','bin','next');
if(!fs.existsSync(nextCli))throw new Error('依赖尚未安装，请执行 npm ci');
const buildDb=`file:./test-results/desktop-build-${releaseId}.db`;
const env={...runtimeEnvironment(runtime),NODE_OPTIONS:'',NODE_ENV:'production',ROASTDUCK_E2E:'',
  ROASTDUCK_DESKTOP:'1',ROASTDUCK_DESKTOP_RELEASE:releaseId,ROASTDUCK_PROMPT_ROOT:path.join(root,'pipeline','prompts'),NEXT_TELEMETRY_DISABLED:'1',
  AI_PROVIDER:'mock',ROASTDUCK_DB:buildDb,ROASTDUCK_SKIP_DB_BACKUP:'1'};
console.log(`构建桌面版本 ${releaseId}，测试数据库 ${buildDb}`);
const result=await new Promise((resolve,reject)=>{
  const child=spawn(runtime.nodePath,[nextCli,'build'],{cwd:root,env,stdio:'inherit',windowsHide:true,shell:false});
  child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));
});
if(result.code!==0){console.error('构建失败，当前桌面版本保持不变。');process.exitCode=result.code||1;}
else if(fingerprintSources(root,sourceFiles())!==sourceHash){
  console.error('构建期间源码发生变化，此次产物未激活。请完成修改后重新构建；当前桌面版本保持不变。');process.exitCode=1;
}else{
  // Next cleans its distDir on build. Freeze prompts only after that build succeeds.
  fs.cpSync(path.join(root,'pipeline','prompts'),path.join(directory,'runtime-prompts'),{recursive:true,errorOnExist:true,force:false});
  const manifest={version:1,releaseId,commit,sourceHash,nodeVersion:runtime.version,builtAt:new Date().toISOString(),
    buildId:fs.readFileSync(path.join(directory,'BUILD_ID'),'utf8').trim()};
  fs.writeFileSync(path.join(directory,'desktop-release.json'),JSON.stringify(manifest,null,2),{flag:'wx'});
  activateRelease(root,manifest);
  console.log(`READY RELEASE ${releaseId}\n下一次服务启动使用此版本；当前运行中的服务未被停止。`);
}
