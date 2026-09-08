import fs from "node:fs";
import path from "node:path";
import {execFileSync} from "node:child_process";
import {_android,expect} from "@playwright/test";
const adb="D:/Apps/DevData/Android/Sdk/platform-tools/adb.exe",serial="emulator-5562",pkg="com.roastduck.app.debug";
const run=(...args)=>execFileSync(adb,["-s",serial,...args],{encoding:"utf8",windowsHide:true}).trim();
if(run("shell","getprop","ro.boot.qemu.avd_name")!=="RoastDuck_Test_API36")throw new Error("Refusing a non-owned test device");
const directory=path.resolve("test-results",`android-ui-${Date.now()}`);fs.mkdirSync(directory,{recursive:true});
let device,page;
async function connect(){
  device=(await _android.devices({omitDriverInstall:true})).find(candidate=>candidate.serial()===serial);
  if(!device)throw new Error("Owned test device unavailable");
  page=await (await device.webView({pkg})).page();
  if(!page)throw new Error("Expected bundled local WebView");
  const profile=await page.evaluate(async()=>await(await fetch("/native-build.json")).json());
  if(profile.profile!=="qa")throw new Error("Refusing to automate production data");
}
async function shot(name){const guest="/sdcard/roastduck-ui-qa.png";run("shell","screencap","-p",guest);run("pull",guest,path.join(directory,`${name}.png`));}
const results=[];
try{
  await connect();
  if(await page.getByRole('button',{name:'直接开始设置',exact:true}).isVisible()){
    await shot('onboarding');await page.getByRole('button',{name:'直接开始设置',exact:true}).click();await page.getByRole('navigation',{name:'主要导航'}).getByRole('link',{name:'今天',exact:true}).click();results.push('onboarding_can_skip_keys');
  }
  await expect(page.getByRole("heading",{name:"今天，从一点开始"})).toBeVisible({timeout:90000});await shot("home");
  await page.getByRole("navigation",{name:"主要导航"}).getByRole("link",{name:"题库",exact:true}).click();
  await page.getByRole("searchbox",{name:"搜索题目或话题"}).fill("Do you live alone?");await page.getByRole("button",{name:"搜索",exact:true}).click();
  await page.locator('a[href="#/questions/native-ui-question"]').click();await page.getByRole("button",{name:"开始回答",exact:true}).click();
  await page.getByLabel("我的英文尝试",{exact:true}).fill("I'm used to live alone.");await page.getByLabel("我真正想表达的中文意思",{exact:true}).fill("我已经习惯一个人住了。");
  await expect(page.getByRole("status")).toHaveText("草稿已保存在本机",{timeout:15000});await shot("draft");results.push("question_filters_and_saved_bilingual_draft");
  await page.getByRole("button",{name:"保存并分析我的表达",exact:true}).click();
  await expect(page.getByRole("link",{name:"轻松学本次表达",exact:true})).toBeVisible({timeout:30000});await shot("material");
  await page.getByRole("link",{name:"轻松学本次表达",exact:true}).click();await page.getByRole("button",{name:"开始轻松学",exact:true}).click();
  await expect(page.getByRole("button",{name:"揭晓表达",exact:true})).toBeVisible();await expect(page.getByText("be used to doing",{exact:true})).toHaveCount(0);await shot("light-prompt");
  await page.getByRole("button",{name:"揭晓表达",exact:true}).click();await expect(page.getByText("be used to doing",{exact:true})).toBeVisible();await shot("light-reveal");
  await page.getByRole("button",{name:"没想起来",exact:true}).click();await expect(page.getByRole("heading",{name:"本批已结束"})).toBeVisible();await shot("light-outcome");results.push("reviewed_material_to_local_click_only_learning");
  await page.getByRole("link",{name:"回到这道题",exact:true}).click();await page.locator('a[href*="/attempts/"]').first().click();
  await page.locator("summary").filter({hasText:"可选四步强化"}).click();await page.getByRole("link",{name:"开始或继续强化"}).click();
  for(const answer of ["be used to doing","I'm used to living alone.","used to living","I'm used to living alone."]){
    await page.getByRole("textbox",{name:"我的英文表达",exact:true}).fill(answer);await page.getByRole("button",{name:"检查表达",exact:true}).click();
    await expect(page.getByRole("button",{name:"继续下一项",exact:true})).toBeVisible();await page.getByRole("button",{name:"继续下一项",exact:true}).click();
  }
  await expect(page.getByRole("heading",{name:"本轮强化完成"})).toBeVisible();results.push("optional_four_steps_share_exact_judgement_and_finish");
  await page.getByRole("navigation",{name:"主要导航"}).getByRole("link",{name:"对话",exact:true}).click();await page.getByRole("button",{name:"开始一段新对话",exact:true}).click();
  await page.getByRole("textbox",{name:"给 Chloe 的消息",exact:true}).fill("I'm used to live alone.");await page.getByRole("button",{name:"发送",exact:true}).click();
  await expect(page.getByText("That makes sense. Tell me a little more.",{exact:true})).toBeVisible({timeout:30000});await shot("chat");results.push("saved_chat_and_multiple_teacher_messages");
  await page.getByRole("button",{name:"复盘这段对话",exact:true}).click();await page.getByRole("button",{name:"整理所选消息",exact:true}).click();
  await expect(page.getByRole("link",{name:"轻松学本次表达",exact:true})).toBeVisible({timeout:30000});results.push("saved_conversation_recap_to_reviewed_material");
  const snapshot=await page.evaluate(()=>window.roastduckQaSnapshot?.());
  fs.writeFileSync(path.join(directory,"result.json"),JSON.stringify({passed:true,results,snapshot,realAndroid:true,runtimeCalls:0}));console.log(JSON.stringify({passed:true,results,directory}));
}catch(error){if(page)await shot("failure").catch(()=>undefined);fs.writeFileSync(path.join(directory,"result.json"),JSON.stringify({passed:false,results,error:String(error),realAndroid:true,runtimeCalls:0}));console.error(error);process.exitCode=1;}
finally{if(device)await device.close();}
