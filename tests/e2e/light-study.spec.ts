import { expect,test,type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createClient } from "@libsql/client";
import path from "node:path";
import { assertInsideTestResults } from "../helpers/temp-db";

async function setup(page:Page){
  await page.addInitScript(()=>{
    Object.defineProperty(navigator,"mediaDevices",{configurable:true,value:{getUserMedia:()=>{throw new Error("轻学习禁止请求麦克风");}}});
    Object.defineProperty(window,"speechSynthesis",{configurable:true,value:{getVoices:()=>[],cancel:()=>{},speaking:false,speak:(u:SpeechSynthesisUtterance)=>{setTimeout(()=>u.onend?.(new Event("end") as SpeechSynthesisEvent),50);}}});
  });
  await page.route("**/api/speech/synthesis",r=>r.fulfill({status:503,contentType:"application/json",body:JSON.stringify({error:"模拟音频服务不可用"})}));
}
async function readCounts(){
  const url=process.env.ROASTDUCK_DB!;assertInsideTestResults(path.resolve(url.slice(5)));
  const client=createClient({url});
  try{
    await client.execute("PRAGMA query_only=ON");
    const result:Record<string,number>={};
    for(const table of ["ai_runs","four_step_sessions","learning_item_schedule","question_mastery"]){
      result[table]=Number((await client.execute(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0].n);
    }
    return result;
  }finally{client.close();}
}
test("轻学新项：只点击、丢响应不重复记录、暂停刷新恢复，原强化和AI记录不变",async({page})=>{
  await setup(page);const before=await readCounts();
  await page.goto("/light-study?scope=question&id=light-e2e-new");
  await page.getByRole("button",{name:"开始轻松学",exact:true}).click();
  await expect(page.getByRole("region",{name:"当前表达"})).toBeVisible();
  await expect(page.getByRole("textbox")).toHaveCount(0);
  await expect(page.getByRole("button",{name:"揭晓表达",exact:true})).toBeVisible();
  await expect(page.getByRole("region",{name:"当前表达"}).locator('[lang="en"]')).toHaveCount(0);
  await expect(page.getByRole("navigation",{name:"移动端底部导航"})).toHaveCount(0);
  const screenshots=[1440,390];
  for(const width of [1440,390,320]){
    await page.setViewportSize({width,height:1000});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await expect(page.getByRole("button",{name:"揭晓表达",exact:true})).toBeInViewport();
    if(screenshots.includes(width))await page.screenshot({path:`test-results/visual/light-study-new-${width}.png`,fullPage:true});
  }
  expect((await new AxeBuilder({page}).include("main").analyze()).violations).toEqual([]);
  let dropped=false;
  await page.route("**/api/light-study/sessions/*/events",async route=>{
    if(!dropped&&route.request().postDataJSON().type==="rate"){
      dropped=true;const response=await route.fetch();expect(response.ok()).toBe(true);await route.abort();
    }else await route.continue();
  });
  await page.getByRole("button",{name:"揭晓表达",exact:true}).click();
  await page.getByRole("button",{name:"想起来了",exact:true}).click();
  await expect(page.getByRole("button",{name:"重试保存"})).toBeVisible();
  await page.getByRole("button",{name:"重试保存"}).click();
  await expect(page.getByText("新表达 · 2 / 5",{exact:true})).toBeVisible();
  await page.getByRole("button",{name:"保存并暂停"}).click();
  await expect(page.getByRole("heading",{name:"位置已保存"})).toBeVisible();
  await page.getByRole("button",{name:"继续上次位置"}).click();
  await expect(page.getByText("新表达 · 2 / 5",{exact:true})).toBeVisible();
  await page.getByRole("button",{name:"保存并暂停"}).click();
  await page.getByRole("link",{name:"查看全部表达"}).click();
  await expect(page.getByRole("heading",{name:"从一小组开始"})).toBeVisible();
  await expect(page.getByRole("heading",{name:"位置已保存"})).toHaveCount(0);
  await page.goBack();
  await page.reload();await page.getByRole("button",{name:"继续上次位置"}).click();
  await expect(page.getByText("新表达 · 2 / 5",{exact:true})).toBeVisible();
  for(let index=0;index<4;index++){
    await page.getByRole("button",{name:"揭晓表达",exact:true}).click();
    await page.getByRole("button",{name:"想起来了",exact:true}).click();
  }
  await expect(page.getByRole("heading",{name:"本批已结束"})).toBeVisible();
  expect(await readCounts()).toEqual(before);
});
test("保存失败时计时不会覆盖原操作，刷新后以同一事件重试",async({page})=>{
  await setup(page);await page.clock.install();
  await page.goto("/light-study?scope=question&id=light-e2e-recovery");
  await page.getByRole("button",{name:"开始复习",exact:true}).click();
  await page.getByText("播放与揭晓设置",{exact:true}).click();
  await page.getByRole("checkbox",{name:"五秒自动揭晓"}).check();
  await page.clock.fastForward(4000);
  const events:Array<{type:string;clientEventId:string}>=[];
  let failed=false;
  await page.route("**/api/light-study/sessions/*/events",async route=>{
    const event=route.request().postDataJSON();events.push(event);
    if(!failed&&event.type==="pause"){
      failed=true;await route.fulfill({status:503,contentType:"application/json",body:JSON.stringify({error:"模拟保存失败"})});
    }else await route.continue();
  });
  await page.getByRole("button",{name:"保存并暂停"}).click();
  await expect(page.getByRole("button",{name:"重试保存"})).toBeVisible();
  await page.clock.fastForward(6000);
  await expect(page.getByRole("button",{name:"揭晓表达",exact:true})).toBeDisabled();
  expect(events.map(e=>e.type)).toEqual(["pause"]);
  await page.reload();
  await expect(page.getByRole("button",{name:"重试保存"})).toBeVisible();
  await page.clock.fastForward(6000);expect(events.map(e=>e.type)).toEqual(["pause"]);
  await page.getByRole("button",{name:"重试保存"}).click();
  await expect(page.getByRole("heading",{name:"位置已保存"})).toBeVisible();
  expect(events.map(e=>e.type)).toEqual(["pause","pause"]);
  expect(events[0].clientEventId).toBe(events[1].clientEventId);
  await page.getByRole("button",{name:"继续上次位置"}).click();
  await expect(page.getByRole("button",{name:"揭晓表达",exact:true})).toBeVisible();
});
test("轻复习：默认手动、计时可暂停和提前揭晓、三档自评均直接继续",async({page})=>{
  await setup(page);await page.clock.install();
  await page.goto("/light-study?scope=question&id=light-e2e-review");
  await expect(page.getByRole("button",{name:/复习到期表达/})).toHaveAttribute("aria-pressed","true");
  await page.getByRole("button",{name:"开始复习",exact:true}).click();
  await expect(page.getByRole("button",{name:"揭晓表达",exact:true})).toBeVisible();
  const region=page.getByRole("region",{name:"当前表达"});
  await expect(region.locator('[lang="en"]')).toHaveCount(0);
  await page.getByText("播放与揭晓设置",{exact:true}).click();
  const timer=page.getByRole("checkbox",{name:"五秒自动揭晓"});
  await expect(timer).not.toBeChecked();await timer.check();
  await page.clock.fastForward(2000);
  await expect(page.getByText("3 秒后揭晓",{exact:true})).toBeVisible();
  await page.getByRole("button",{name:"暂停计时",exact:true}).click();
  await page.clock.fastForward(6000);
  await expect(region.locator('[lang="en"]')).toHaveCount(0);
  await page.getByRole("button",{name:"揭晓表达",exact:true}).click();
  await expect(page.getByRole("button",{name:"想起来了",exact:true})).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button",{name:"想起来了",exact:true})).toBeVisible();
  await page.getByRole("button",{name:"想起来了",exact:true}).click();
  await expect(page.getByText("到期复习 · 2 / 3",{exact:true})).toBeVisible();
  await page.clock.fastForward(5000);
  await expect(page.getByRole("button",{name:"有点模糊",exact:true})).toBeVisible();
  await expect(page.getByText("到期复习 · 2 / 3",{exact:true})).toBeVisible();
  await page.getByRole("button",{name:"有点模糊",exact:true}).click();
  await expect(page.getByText("到期复习 · 3 / 3",{exact:true})).toBeVisible();
  await expect(page.getByRole("button",{name:"揭晓表达",exact:true})).toBeVisible();
  await page.evaluate(()=>{Object.defineProperty(document,"hidden",{configurable:true,value:true});document.dispatchEvent(new Event("visibilitychange"));});
  await page.clock.fastForward(6000);
  await expect(region.locator('[lang="en"]')).toHaveCount(0);
  await page.evaluate(()=>{Object.defineProperty(document,"hidden",{configurable:true,value:false});document.dispatchEvent(new Event("visibilitychange"));});
  await page.getByRole("button",{name:"揭晓表达",exact:true}).click();
  await page.setViewportSize({width:390,height:844});
  await page.evaluate(()=>window.scrollTo(0,0));
  for(const width of [390,320]){
    await page.setViewportSize({width,height:844});
    for(const name of ["想起来了","有点模糊","没想起来"]){
      const button=page.getByRole("button",{name,exact:true});
      await expect(button).toBeInViewport();
      expect(await button.evaluate(element=>{
        const rect=element.getBoundingClientRect();
        return element.contains(document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2));
      })).toBe(true);
    }
  }
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:"test-results/visual/light-study-review-390.png",fullPage:true});
  await page.getByRole("button",{name:"没想起来",exact:true}).click();
  await expect(page.getByRole("heading",{name:"本批已结束"})).toBeVisible();
  await expect(page.getByRole("textbox")).toHaveCount(0);
});
test("V2五项新学最多再见三次，失败不强制循环，揭晓/移动焦点和总结可用",async({page})=>{
  await setup(page);
  await page.goto("/light-study?scope=question&id=light-e2e-weak");
  await page.getByRole("button",{name:"开始轻松学",exact:true}).click();
  await expect(page.getByRole("heading",{level:2})).toBeFocused();
  await page.getByText("播放与揭晓设置",{exact:true}).click();
  await expect(page.getByRole("checkbox",{name:"五秒自动揭晓"})).not.toBeChecked();
  await page.getByText("播放与揭晓设置",{exact:true}).click();
  for(let index=0;index<8;index++){
    await expect(page.getByRole("button",{name:"揭晓表达",exact:true})).toBeVisible();
    if(index>0)await expect(page.getByRole("heading",{level:2})).toBeFocused();
    if(index===5)await expect(page.getByText("再想一次 · 1 / 3",{exact:true})).toBeVisible();
    await page.getByRole("button",{name:"揭晓表达",exact:true}).click();
    if(index===0){
      for(const width of [1440,390,320]){
        await page.setViewportSize({width,height:844});
        await expect(page.getByRole("button",{name:"没想起来",exact:true})).toBeInViewport();
        expect((await new AxeBuilder({page}).include("main").analyze()).violations).toEqual([]);
        if(width!==320)await page.screenshot({path:`test-results/visual/light-study-revealed-${width}.png`,fullPage:true});
      }
    }
    await page.getByRole("button",{name:"没想起来",exact:true}).click();
  }
  await expect(page.getByRole("heading",{name:"本批已结束"})).toBeVisible();
  await expect(page.getByRole("link",{name:"回到这道题",exact:true})).toHaveAttribute("href","/questions/light-e2e-weak");
  await expect(page.getByRole("button",{name:"揭晓表达",exact:true})).toHaveCount(0);
});

test("入口、无材料、无到期和错误范围明确；打开页面不创建训练",async({page,request})=>{
  await setup(page);const before=await readCounts();
  await page.goto("/");await expect(page.getByRole("link",{name:"选择学习范围"})).toHaveAttribute("href","/light-study");
  await page.goto("/questions/light-e2e-new");await expect(page.getByRole("link",{name:"轻松学本题"})).toHaveAttribute("href",/scope=question/);
  const {attempts}=await(await request.get("/api/speaking-practice/questions/light-e2e-new/attempts")).json();
  await page.goto(`/questions/light-e2e-new/attempts/${attempts[0].id}`);
  await expect(page.getByRole("link",{name:"轻松学本次表达"})).toHaveAttribute("href",/scope=material/);
  await page.goto("/light-study?scope=question&id=light-e2e-new");
  await page.getByRole("button",{name:/复习到期表达/}).click();
  await expect(page.getByText("暂时没有到期表达，稍后再来，或学一点新的。",{exact:true})).toBeVisible();
  await page.goto("/light-study?scope=invalid");await expect(page.locator("main").getByRole("alert")).toContainText("范围不正确");
  expect(await readCounts()).toEqual(before);
});
