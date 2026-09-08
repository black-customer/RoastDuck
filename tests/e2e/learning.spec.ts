import AxeBuilder from "@axe-core/playwright";
import {expect,test} from "@playwright/test";

test("难点笔记可回看、修改状态并持久化", async ({ page,request }) => {
  const lookup=(await(await request.get("/api/questions/question_e2e_habits")).json()).question.interactiveQuestion.annotations[0].id;
  const {note:createdNote}=await(await request.post("/api/notes",{data:{annotationId:lookup,trigger:"user_added"}})).json();
  await request.patch(`/api/notes/${createdNote.id}`,{data:{userRemark:"E2E：这个词需要回看"}});
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/difficulties");

  await expect(page.getByRole("heading", { name: "我的难点" })).toBeVisible();
  const note = page.locator("article").filter({ hasText: "E2E：这个词需要回看" }).first();
  await expect(note).toBeVisible();
  await note.getByRole("button", { name: "标记已解决" }).click();
  await expect(note).toHaveCount(0);

  await page.getByRole("button", { name: "已解决", exact: true }).click();
  const resolvedNote = page.locator("article").filter({ hasText: "E2E：这个词需要回看" }).first();
  await expect(resolvedNote).toBeVisible();
  await expect(resolvedNote.getByText("已解决", { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "已解决", exact: true }).click();
  await expect(page.locator("article").filter({ hasText: "E2E：这个词需要回看" }).first()).toBeVisible();

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations.filter((item) => ["serious", "critical"].includes(item.impact ?? ""))).toEqual([]);
});

test("设置页默认不自动收集，保存后可持久化", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "学习设置" })).toBeVisible();
  const autoCollect = page.getByRole("checkbox", { name: /查询时自动收藏/ });
  await expect(autoCollect).not.toBeChecked();
  await page.getByRole("checkbox",{name:/揭晓后自动播放/}).uncheck();
  await page.getByRole("button", { name: "保存设置" }).click();
  await expect(page.getByText("设置已保存，下一步学习会立即使用。", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("checkbox",{name:/揭晓后自动播放/})).not.toBeChecked();

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations.filter((item) => ["serious", "critical"].includes(item.impact ?? ""))).toEqual([]);
});

test("题库中心支持 URL 筛选、英文小卡、收藏、来源和随机题", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/questions");
  await expect(page.getByRole("heading", { name: "雅思题库" })).toBeVisible();
  await expect(page.getByText("What helps you study effectively?", { exact: true })).toBeVisible();

  await page.getByLabel("题集").selectOption("qs_2026_01_04");
  await expect(page).toHaveURL(/set=qs_2026_01_04/);
  await page.getByRole("button", { name: "Part 1", exact: true }).click();
  await expect(page).toHaveURL(/part=1/);
  await page.getByLabel("搜索中英文题目或话题").fill("高效学习");
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await expect(page).toHaveURL(/q=/);
  await expect(page.getByText("What helps you study effectively?", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: /查看 What 的解释/ }).click();
  await expect(page.getByRole("dialog", { name: "英文解释卡片" })).toBeVisible();
  await expect(page.getByText("已在难点中", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "关闭英文小卡" }).click();

  await page.locator('a[href="/questions/question_e2e_habits"]').click();
  await expect(page.getByText("Part1新题.pdf", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "打开第 8 页" })).toHaveAttribute("href", /part1_new_2026q1#page=8$/);
  await page.getByRole("button", { name: "收藏", exact: true }).click();
  await expect(page.getByRole("button", { name: "已收藏", exact: true })).toBeVisible();

  const desktopAccessibility = await new AxeBuilder({ page }).analyze();
  expect(desktopAccessibility.violations.filter((item) => ["serious", "critical"].includes(item.impact ?? ""))).toEqual([]);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/questions?favorite=1");
  await expect(page.getByText("What helps you study effectively?", { exact: true })).toBeVisible();
  const bodyWidth = await page.evaluate(() => ({ scroll: document.body.scrollWidth, client: document.body.clientWidth }));
  expect(bodyWidth.scroll).toBeLessThanOrEqual(bodyWidth.client);
  await page.getByRole("button", { name: "随机一道" }).click();
  await expect(page).toHaveURL(/\/questions\/question_e2e_habits\?from=random/);
  await expect(page).toHaveTitle(/鱼块学英语/);

  const mobileAccessibility = await new AxeBuilder({ page }).analyze();
  expect(mobileAccessibility.violations.filter((item) => ["serious", "critical"].includes(item.impact ?? ""))).toEqual([]);
});

test("回答工作台先保存中英混合原文，并可恢复同一 AI 任务", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/answer-studio?question=question_e2e_habits");
  await expect(page.getByRole("heading", { name: "把真实想法说出来" })).toBeVisible();
  await expect(page.getByText("What helps you study effectively?", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /中英混合/ }).click();
  await page.getByLabel("你的回答").fill("I can stay focused because 我会把手机放到另一个房间。" );
  await page.getByRole("button", { name: "保存并生成个人材料" }).click();
  await expect(page).toHaveURL(/\/answer-studio\/answer_/);
  await expect(page.getByRole("heading", { name: "你的原始回答" })).toBeVisible();
  await expect(page.getByText("I can stay focused because 我会把手机放到另一个房间。", { exact: true })).toBeVisible();
  await expect(page.getByText("永不覆盖", { exact: true })).toBeVisible();
  await expect(page.getByText("I stay focused by putting my phone in another room.", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("个人英文版本和学习材料已经生成，并完成独立自动审核。", { exact: true })).toBeVisible();

  await page.reload();
  await expect(page.getByText("I can stay focused because 我会把手机放到另一个房间。", { exact: true })).toBeVisible();
  await expect(page.locator(".workspace-revision textarea")).toHaveValue("I stay focused by putting my phone in another room.");
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations.filter((item) => ["serious", "critical"].includes(item.impact ?? ""))).toEqual([]);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  const bodyWidth = await page.evaluate(() => ({ scroll: document.body.scrollWidth, client: document.body.clientWidth }));
  expect(bodyWidth.scroll).toBeLessThanOrEqual(bodyWidth.client);

  await page.goto("/personal-book");
  await expect(page.getByRole("heading", { name: "我的雅思答案" })).toBeVisible();
  await expect(page.getByRole("link", { name: "stay focused" })).toBeVisible();
  await page.getByRole("button", { name: /查看 putting 的解释/ }).click();
  await expect(page.getByRole("dialog", { name: "英文解释卡片" })).toBeVisible();
});

test("口语输出场支持中英混合、多气泡老师回复、可点击英文与完成后入库", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/questions/question_e2e_habits");
  await page.goto("/speaking-arena?question=question_e2e_habits");

  await expect(page.getByRole("region", { name: "与 Chloe 的雅思口语对话" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/AI 起步提示|来自历史回答/)).toBeVisible();
  await expect(page.getByText("我是 Chloe。你可以放心用中文、英文或中英混合回答", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: /关键词/ }).click();
  await expect(page.getByRole("button", { name: /查看 focus 的解释/ })).toBeVisible();
  await page.getByRole("button", { name: /查看 focus 的解释/ }).click();
  await expect(page.getByRole("dialog", { name: "英文解释卡片" })).toBeVisible();
  await expect(page.getByText("已在难点中", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "关闭英文小卡" }).click();

  await page.getByRole("button", { name: /可用表达/ }).click();
  await expect(page.getByText("把手机收起来", { exact: true })).toBeVisible();

  await page.getByLabel("给 Chloe 的回答").fill("I put my phone in another room，这样我更容易 stay focused。");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByText("更自然可以说：", { exact: false })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("现在试着用自己的话再说一次，好吗？", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /查看 putting 的解释/ }).last().click();
  await expect(page.getByRole("dialog", { name: "英文解释卡片" })).toBeVisible();
  await expect(page.getByText("已在难点中", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "关闭英文小卡" }).click();

  await page.getByLabel("给 Chloe 的回答").fill("I stay focused by putting my phone in another room.");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByText("2/4 建议轮次", { exact: true })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "提前结束并分析" }).click();
  await expect(page.getByText("本轮回答、Gap 与学习材料审核已完成", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/本轮记录 1 个新问题/)).toBeVisible();
  await expect(page.getByText(/1 个表达通过双语境审核并进入本题学习包/)).toBeVisible();

  const desktopAccessibility = await new AxeBuilder({ page }).analyze();
  expect(desktopAccessibility.violations.filter((item) => ["serious", "critical"].includes(item.impact ?? ""))).toEqual([]);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByText("本轮回答、Gap 与学习材料审核已完成", { exact: true })).toBeVisible();
  const bodyWidth = await page.evaluate(() => ({ scroll: document.body.scrollWidth, client: document.body.clientWidth }));
  expect(bodyWidth.scroll).toBeLessThanOrEqual(bodyWidth.client);

  await page.getByRole("main").getByRole("link", { name: "我的雅思答案" }).click();
  await expect(page.getByRole("link", { name: /stay focused|putting my phone in another room/ }).first()).toBeVisible();
  const mobileAccessibility = await new AxeBuilder({ page }).analyze();
  expect(mobileAccessibility.violations.filter((item) => ["serious", "critical"].includes(item.impact ?? ""))).toEqual([]);
});
