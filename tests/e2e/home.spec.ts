import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("首页在桌面使用三栏工作台，导航和学习入口可访问", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "今日学习", exact: true })).toBeVisible();
  const layout = await page.evaluate(() => {
    const main = document.querySelector("main")!.getBoundingClientRect();
    const nav = document.querySelector('[aria-label="工作台导航"]')!.getBoundingClientRect();
    const rail = document.querySelector('[aria-label="复习与口语练习"]')!.getBoundingClientRect();
    return { mainWidth: main.width, mainLeft: main.left, navWidth: nav.width, railLeft: rail.left, documentWidth: document.documentElement.scrollWidth };
  });
  expect(layout.mainWidth).toBeGreaterThan(950);
  expect(layout.mainLeft).toBeGreaterThanOrEqual(layout.navWidth);
  expect(layout.railLeft).toBeGreaterThan(850);
  expect(layout.documentWidth).toBeLessThanOrEqual(1280);
  const gapLearning = page.getByRole("region", { name: /花几分钟/ });
  await expect(gapLearning.getByRole("button", { name: /继续上次学习|复习到期表达|学几个新表达/ })).toBeVisible();
  await gapLearning.getByText("可选强化练习",{exact:true}).click();
  await expect(gapLearning.getByRole("link", { name: "继续四步强化",exact:true })).toHaveAttribute("href", /^(\/questions$|\/training\/pm_)/);
  await expect(gapLearning.getByText("复习题目／对话", { exact: true })).toBeVisible();
  await gapLearning.getByText("可选强化练习",{exact:true}).click();
  await expect(page.getByRole("navigation", { name: "主导航", exact: true }).getByRole("link", { name: "雅思题库", exact: true })).toHaveAttribute("href", "/questions");
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
  // Optional-controls checks moved focus. Test the first Tab on a fresh page.
  await page.reload();
  await expect(page.getByRole("heading",{name:"今日学习",exact:true})).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "跳到主要内容" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("main")).toBeFocused();
  await page.screenshot({path:"test-results/visual/light-home-1280.png",fullPage:true});
});

test("窄屏保留全部入口，320px 和 390px 无横向溢出", async ({ page }) => {
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "今日学习", exact: true })).toBeVisible();
    const dimensions = await page.evaluate(() => ({ width: window.innerWidth, scroll: document.documentElement.scrollWidth }));
    expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width);
    await page.getByRole("button", { name: "展开或收起导航" }).click();
    const nav = page.getByRole("navigation", { name: "主导航", exact: true });
    await expect(nav.getByRole("link", { name: "到期复习", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "学习设置", exact: true })).toBeVisible();
  }
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
  await page.getByRole("button",{name:"展开或收起导航"}).click();
  await page.screenshot({path:"test-results/visual/light-home-390.png",fullPage:true});
});

test("首页一键进入轻学习，启动丢响应刷新后仍恢复同一会话",async({page,request})=>{
  let id="",failed=false;
  await page.goto("/");
  await page.route("**/api/light-study/sessions",async route=>{
    if(!failed&&route.request().method()==="POST"){
      failed=true;const response=await route.fetch();id=(await response.json()).session.id;
      await route.fulfill({status:503,json:{error:"合成启动响应丢失"}});
    }else await route.continue();
  });
  await page.getByRole("region",{name:/花几分钟/}).getByRole("button",{name:/继续上次学习|复习到期表达|学几个新表达/}).click();
  await expect(page.getByRole("button",{name:"恢复刚才的启动"})).toBeVisible();
  await page.reload();
  await page.getByRole("button",{name:"恢复刚才的启动"}).click();
  await expect(page.getByRole("region",{name:"当前表达"})).toBeVisible();
  expect(new URL(page.url()).searchParams.get("session")).toBe(id);
  await expect(page.getByRole("button",{name:"揭晓表达",exact:true})).toBeVisible();
  await page.getByRole("button",{name:"保存并暂停"}).click();
  expect((await(await request.get(`/api/light-study/sessions/${id}`)).json()).session.status).toBe("paused");
});

test("随机题失败可重试，查询英文不记笔记或创建回答", async ({ page }) => {
  const writes: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "GET" && /\/api\//.test(request.url())) writes.push(request.url());
  });
  await page.goto("/");
  const randomPanel = page.getByRole("region", { name: "来聊一道题" });
  await page.route("**/api/questions/random", (route) => route.fulfill({ status: 503, json: { error: "随机题暂时不可用" } }));
  await page.getByRole("button", { name: "换一题", exact: true }).click();
  await expect(randomPanel.getByRole("alert")).toHaveText("随机题暂时不可用");
  await page.unroute("**/api/questions/random");
  await page.getByRole("button", { name: "重新抽取", exact: true }).click();
  await expect(randomPanel.getByRole("alert")).toHaveCount(0);
  // Wait for the new card, not just for the old error to clear at request start.
  await expect(randomPanel.getByRole('button',{name:'换一题',exact:true})).toBeEnabled();
  await expect(page.getByRole("link", { name: "去回答", exact: true })).toHaveAttribute("href", /\/questions\/.+\?from=random/);
  const annotation = page.getByRole("region", { name: "来聊一道题" }).getByRole("button", { name: /^查看 .* 的解释$/ }).first();
  await annotation.click();
  await expect(page.getByRole("dialog", { name: "英文解释卡片" })).toBeVisible();
  await page.getByRole("button", { name: "关闭英文小卡" }).click();
  await expect(annotation).toBeFocused();
  expect(writes).toEqual([]);
});
