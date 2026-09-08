import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import {createHash} from 'node:crypto';
import {androidJava} from './android-toolchain.mjs';
import {prepareSigning} from './android-signing.mjs';

console.log("== 鱼块学英语 Android APK 一键构建 ==");

if (process.env.ROASTDUCK_NATIVE_HARNESS === "1"||process.env.ROASTDUCK_MOBILE_QA==="1") throw new Error("测试harness不能作为用户APK交付。");
if (!fs.existsSync(path.resolve("mobile/dist/index.html"))) throw new Error("本地安卓界面尚未构建：停止打包，不生成远程网页壳或假加载页APK。");
const metadata=JSON.parse(fs.readFileSync('mobile/dist/native-build.json','utf8'));
if(metadata.profile!=='production'||metadata.privateAnswers!==0)throw new Error('本地页面不是正式应用资源，停止签名。');
if(process.env.VITEST)throw new Error('普通单元测试不能触发真实 Android 构建或生成签名。');
const javaHome=androidJava(),signingFile=prepareSigning(javaHome);

// 1. Sync web assets into Android project
console.log("\n[1/2] 同步 Web 资源至 Capacitor Android 容器...");
const isWin = process.platform === "win32";
const syncResult = spawnSync(process.execPath, ["node_modules/@capacitor/cli/bin/capacitor", "sync", "android"], {
  stdio: "inherit",
  windowsHide:true,
});

if (syncResult.status !== 0) {
  console.error("Capacitor sync 失败！");
  process.exit(syncResult.status ?? 1);
}

// 2. The release key is stable, local and backed up; QA assets are rejected by Gradle as well.
console.log("\n[2/2] 执行 Gradle assembleRelease 本地签名打包...");
const androidDir = path.resolve("android");
const gradlew = path.join(androidDir, process.platform === "win32" ? "gradlew.bat" : "gradlew");

const gradleResult = spawnSync(gradlew, ["--no-daemon",":app:assembleRelease"], {
  cwd: androidDir,
  stdio: "inherit",
  shell: isWin,
  windowsHide:true,
  env:{...process.env,JAVA_HOME:javaHome,ROASTDUCK_ANDROID_SIGNING_FILE:signingFile},
});

if (gradleResult.status !== 0) {
  console.error("Gradle APK 编译打包失败！");
  process.exit(gradleResult.status ?? 1);
}

const apkPath = path.join(androidDir, "app", "build", "outputs", "apk", "release", "app-release.apk");
if (fs.existsSync(apkPath)) {
  const stat = fs.statSync(apkPath);
  const out=path.resolve('dist/android');fs.mkdirSync(out,{recursive:true});const target=path.join(out,'RoastDuck-v0.2.0.apk');fs.copyFileSync(apkPath,target);
  const sha256=createHash('sha256').update(fs.readFileSync(target)).digest('hex');fs.writeFileSync(path.join(out,'release.json'),JSON.stringify({apk:path.basename(target),sha256,bytes:stat.size,versionCode:2,package:'com.roastduck.app',builtAt:new Date().toISOString(),deviceAcceptance:'not_yet_verified'}));
  console.log("\n==================================================");
  console.log("✓ Android APK 构建成功！");
  console.log(`路径: ${target}`);
  console.log(`SHA-256: ${sha256}`);
  console.log('安装升级需核查手机已有包的签名；不会自动卸载或清空旧应用。');
  console.log(`大小: ${(stat.size / 1024 / 1024).toFixed(2)} MB`);
  console.log("==================================================");
} else {
  throw new Error("未能找到生成的 APK 文件，不宣称构建成功。");
}
