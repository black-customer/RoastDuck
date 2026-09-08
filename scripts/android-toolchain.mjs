import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
export function androidJava(){
  const root=path.resolve('data/toolchains'),candidates=[];
  if(process.env.JAVA_HOME)candidates.push(process.env.JAVA_HOME);
  if(fs.existsSync(root))for(const entry of fs.readdirSync(root,{withFileTypes:true})){if(!entry.isDirectory()||!entry.name.startsWith('jdk21'))continue;const base=path.join(root,entry.name);candidates.push(base);for(const child of fs.readdirSync(base,{withFileTypes:true}))if(child.isDirectory())candidates.push(path.join(base,child.name));}
  for(const candidate of candidates){const java=path.join(candidate,'bin',process.platform==='win32'?'java.exe':'java');if(!fs.existsSync(java))continue;const result=spawnSync(java,['-version'],{encoding:'utf8',windowsHide:true});if(result.status===0&&/version "21\./.test(result.stderr+result.stdout))return candidate;}
  throw new Error('Android 构建需要项目 JDK 21；未找到兼容版本，未修改全局 Java。');
}
