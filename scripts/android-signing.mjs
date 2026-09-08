import fs from 'node:fs';
import path from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const sha=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export function prepareSigning(javaHome){
  const directory=path.resolve('data/android-signing'),store=path.join(directory,'release.p12'),properties=path.join(directory,'release.properties');fs.mkdirSync(directory,{recursive:true,mode:0o700});
  if(fs.existsSync(store)!==fs.existsSync(properties))throw new Error('签名文件不完整，停止生成新密钥；请从本地签名备份恢复。');
  if(!fs.existsSync(store)){
    const password=randomBytes(32).toString('hex'),tool=path.join(javaHome,'bin',process.platform==='win32'?'keytool.exe':'keytool');
    const result=spawnSync(tool,['-genkeypair','-keystore',store,'-storetype','PKCS12','-alias','roastduck','-keyalg','RSA','-keysize','3072','-validity','10000','-dname','CN=RoastDuck Local App','-storepass:env','ROASTDUCK_SIGN_PASSWORD','-keypass:env','ROASTDUCK_SIGN_PASSWORD'],{encoding:'utf8',windowsHide:true,env:{...process.env,ROASTDUCK_SIGN_PASSWORD:password}});
    if(result.status!==0)throw new Error('本地签名密钥生成未确认，已保留当前文件；没有切换其他签名。');
    const text=`storeFile=${store.replaceAll('\\','/')}\nstorePassword=${password}\nkeyAlias=roastduck\nkeyPassword=${password}\n`;
    fs.writeFileSync(properties,text,{flag:'wx',mode:0o600});fs.chmodSync(store,0o600);
  }
  const backup=path.join(directory,'backup');fs.mkdirSync(backup,{recursive:true,mode:0o700});
  for(const file of [store,properties]){const target=path.join(backup,path.basename(file));if(!fs.existsSync(target))fs.copyFileSync(file,target,fs.constants.COPYFILE_EXCL);if(sha(file)!==sha(target))throw new Error('签名备份与当前密钥不一致，停止自动覆盖。');}
  return properties;
}
