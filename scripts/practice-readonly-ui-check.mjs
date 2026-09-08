import { chromium } from "@playwright/test";
import fs from "node:fs";
import assert from "node:assert/strict";
const browser=await chromium.launch({headless:true});
const page=await browser.newPage();
const url=process.argv[2];
if(!url||!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(url))throw new Error("传入本机已有回答详情 URL，只读检查不启动训练");
const blocked=[];
await page.route("**/*",async route=>{
  const request=route.request();
  if(!["GET","HEAD"].includes(request.method())||!new URL(request.url()).hostname.match(/^(localhost|127\.0\.0\.1)$/)){
    blocked.push({method:request.method(),path:new URL(request.url()).pathname});return route.abort();
  }
  return route.continue();
});
try{
  await page.goto(url,{waitUntil:"networkidle"});
  await page.getByRole("button",{name:"开始四步强化",exact:true}).waitFor();
  assert.equal(await page.getByText("材料处理未完成",{exact:true}).count(),0);
  fs.mkdirSync("test-results/visual",{recursive:true});
  for(const width of [1440,390]){
    await page.setViewportSize({width,height:1000});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.screenshot({path:`test-results/visual/recovered-reading-${width}.png`,fullPage:true});
    await page.screenshot({path:`test-results/visual/recovered-reading-viewport-${width}.png`});
  }
  const questionUrl=url.split("/attempts/")[0];
  await page.goto(questionUrl,{waitUntil:"networkidle"});
  await page.locator("#learning-units .question-learning-list").waitFor();
  assert.equal(await page.getByText("回答已保存，但学习材料还没有通过发布闸门。",{exact:true}).count(),0);
  for(const width of [1440,390]){
    await page.setViewportSize({width,height:1000});
    await page.locator("#learning-units").scrollIntoViewIfNeeded();
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.screenshot({path:`test-results/visual/recovered-question-materials-${width}.png`});
  }
  console.log(JSON.stringify({readOnly:true,url,blockedRequests:blocked,trainingEntryVisible:true}));
}finally{await browser.close();}
