import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { createClient } from "@libsql/client";
import path from "node:path";
import { assertInsideTestResults } from "../helpers/temp-db";

test("回答到四步：不可跳过、错误保留、刷新恢复、移动和桌面无答案泄露", async ({ page, request }) => {
  const question = "question_e2e_habits";
  const response = await request.post(`/api/speaking-practice/questions/${question}/attempts`, {
    data: { clientRequestId: "e2e-four-step-submission", mode: "practice", answerText: "I saw a 井盖 outside.", intendedMeaningZh: "我在外面看到了一个井盖。" },
  });
  expect(response.status()).toBe(202);
  const { attempt } = await response.json();
  await expect.poll(async () => (await (await request.get(`/api/speaking-practice/attempts/${attempt.id}`)).json()).attempt.status).toBe("completed");
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: () => { throw new Error("四步不得请求麦克风"); } } });
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/questions/${question}/attempts/${attempt.id}`);
  await page.getByText("查看四列材料、收藏与调整",{exact:true}).click();
  await page.locator(".expression-row").first().getByText("原句、入选理由与个人备注",{exact:true}).click();
  await expect(page.locator(".expression-row").first()).toContainText("I saw a 井盖 outside.");
  await expect(page.locator(".expression-row").first()).toContainText("我在外面看到了一个井盖。");
  await page.getByText("查看四列材料、收藏与调整",{exact:true}).click();
  for(const width of [1440,390,320]) {
    await page.setViewportSize({width,height:1000});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.evaluate(()=>window.scrollTo(0,0));
    await expect(page.getByRole("button",{name:"可选：四步强化",exact:true})).toBeInViewport();
    if(width!==320) await page.screenshot({path:`test-results/visual/material-evidence-${width}.png`,fullPage:true});
  }
  await page.setViewportSize({width:1440,height:1000});
  const resultAccessibility=await new AxeBuilder({page}).include(".material-result").analyze();
  expect(resultAccessibility.violations.filter((i)=>["serious","critical"].includes(i.impact??""))).toEqual([]);
  await page.getByRole("button", { name: "可选：四步强化",exact:true }).click();
  const dialog = page.getByRole("dialog", { name: "四步表达强化" });
  const field = page.getByRole("textbox", { name: "你的英文表达" });
  await expect(field).toBeVisible();
  await expect(dialog.getByText("manhole cover", { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "继续", exact: true })).toHaveCount(0);
  expect(await dialog.getByRole("listitem").count()).toBe(4);
  await field.fill("the");
  await page.getByRole("button", { name: "检查表达" }).click();
  await expect(page.getByText("这次尚未表达目标意思，请核对后重试。")).toBeVisible();
  await expect(field).toHaveValue("the");
  await page.screenshot({ path: "test-results/visual/four-step-desktop.png", fullPage: true });
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    const size = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
    expect(size.scroll).toBeLessThanOrEqual(size.width);
    await expect(field).toBeVisible();
  }
  await page.screenshot({ path: "test-results/visual/four-step-mobile.png", fullPage: true });
  const accessibility = await new AxeBuilder({ page }).include(".mastery-overlay").analyze();
  expect(accessibility.violations.filter((issue) => ["serious", "critical"].includes(issue.impact ?? ""))).toEqual([]);
  await page.reload();
  await page.getByRole("button", { name: "可选：四步强化",exact:true }).click();
  await expect(field).toHaveValue("the");
  const answers = ["manhole cover", "I saw a manhole cover outside.", "manhole cover", "I saw a manhole cover outside."];
  for (const [index, answer] of answers.entries()) {
    await field.fill(answer);
    await page.getByRole("button", { name: "检查表达" }).click();
    await expect(page.getByText("这次表达正确，意思一致。")).toBeVisible();
    await page.getByRole("button", { name: index === 3 ? "完成本轮强化" : "继续", exact: true }).click();
  }
  await expect(page.getByRole("heading", { name: "本轮强化已完成" })).toBeVisible();
  await expect(page.getByText(/还不等于无提示或跨日掌握/)).toBeVisible();
});

test("历史回答旧链接直接进入已审核四步材料，打开不触发在线生成",async({page,request})=>{
  const question="question_e2e_habits";
  const {attempt}=await(await request.post(`/api/speaking-practice/questions/${question}/attempts`,{data:{clientRequestId:"e2e-offline-link",mode:"practice",answerText:"I saw a 井盖 outside.",intendedMeaningZh:"我在外面看到了一个井盖。"}})).json();
  await expect.poll(async()=>(await(await request.get(`/api/speaking-practice/attempts/${attempt.id}`)).json()).attempt.status).toBe("completed");
  const url=process.env.ROASTDUCK_DB!;assertInsideTestResults(path.resolve(url.slice(5)));
  const client=createClient({url});
  try{
    await client.execute({sql:"INSERT INTO personal_answers(id,question_id,input_language,raw_text,status) VALUES(?,?,'en',?,'ready')",args:["e2e-historical-linked",question,"I saw a 井盖 outside."]});
    await client.execute({sql:"INSERT INTO practice_answer_sources VALUES(?,?,?,?)",args:["e2e-historical-linked",attempt.id,"synthetic-link-test",new Date().toISOString()]});
  }finally{client.close();}
  const writes:string[]=[];page.on("request",r=>{if(!["GET","HEAD"].includes(r.method()))writes.push(r.url());});
  await page.setViewportSize({width:390,height:844});
  await page.goto("/answer-studio/e2e-historical-linked");
  await expect(page).toHaveURL(new RegExp(`/questions/${question}/attempts/${attempt.id}$`));
  await expect(page.getByRole("button",{name:"可选：四步强化",exact:true})).toBeInViewport();
  await expect(page.getByText("材料处理未完成",{exact:true})).toHaveCount(0);
  expect(writes).toEqual([]);
  await page.goto(`/questions/${question}`);
  await expect(page.locator("#learning-units")).toContainText("manhole cover");
  await expect(page.getByText("回答已保存，但学习材料还没有通过发布闸门。",{exact:true})).toHaveCount(0);
  await expect(page.getByText("可借用的公共表达",{exact:true})).toHaveCount(0);
});

test("自然表达不因升级措辞制卡，零项提示不宣称完全掌握",async({page,request})=>{
  const question="question_e2e_habits";
  const {attempt}=await (await request.post(`/api/speaking-practice/questions/${question}/attempts`,{data:{clientRequestId:"e2e-selection-natural",mode:"practice",answerText:"I really like my major.",intendedMeaningZh:"我很喜欢我的专业。"}})).json();
  await expect.poll(async()=>(await(await request.get(`/api/speaking-practice/attempts/${attempt.id}`)).json()).attempt.status).toBe("completed");
  await page.goto(`/questions/${question}/attempts/${attempt.id}`);
  await expect(page.getByText("没有确认的必练表达，可以继续作答。不确定内容不会被强行编成学习材料。")).toBeVisible();
  await expect(page.getByRole("button",{name:"可选：四步强化",exact:true})).toHaveCount(0);
  await expect(page.locator(".natural-full-paragraph")).toHaveText("I really like my major.");
  await expect(page.getByText(/非常自然完整|意图表达非常完整自然/)).toHaveCount(0);
});

test("FreeTalk 使用真实消息快照复盘，无消息不伪造训练", async ({ request }) => {
  const { conversation } = await (await request.post("/api/free-talk/conversations", { data: { clientRequestId:"e2e-recap-create",title: "合成复盘测试", mode: "relaxed" } })).json();
  expect((await request.post(`/api/free-talk/conversations/${conversation.id}/materials`,{data:{startId:"missing",endId:"missing"}})).status()).toBe(400);
  await request.post(`/api/free-talk/conversations/${conversation.id}/messages`, { data: { clientMessageId:"e2e-recap-message",text: "I saw a 井盖 outside." } });
  const history=(await(await request.get(`/api/free-talk/conversations/${conversation.id}/messages`)).json()).messages;
  const range={startId:history[0].id,endId:history.at(-1).id};
  const one = await (await request.post(`/api/free-talk/conversations/${conversation.id}/materials`,{data:range})).json();
  const duplicate = await (await request.post(`/api/free-talk/conversations/${conversation.id}/materials`,{data:range})).json();
  expect(one.materialId).toBe(duplicate.materialId);
  await expect.poll(async () => (await (await request.get(`/api/training/materials/${one.materialId}`)).json()).status).toBe("ready");
  const { session } = await (await request.post("/api/training/sessions", { data: { materialId: one.materialId } })).json();
  expect(session.sourceType).toBe("free_talk");
  expect(session.sourceId).toBe(conversation.id);
  expect(session.questionId).toBeNull();
});

test("聊天响应丢失后原地重试，切换会话不串消息，题目抽屉显示真实字段", async ({ page, request }) => {
  const create = async (title: string) => (await (await request.post("/api/free-talk/conversations", { data: { clientRequestId:`create-${title}`,title, mode: "relaxed" } })).json()).conversation.id as string;
  const first = await create("消息恢复测试");
  const second = await create("第二个独立对话");
  await page.goto(`/free-talk?conversation=${first}`);
  await expect(page.getByRole("textbox", { name: "给 Chloe 的消息" })).toBeEnabled();
  let dropped = false;
  await page.route(`**/api/free-talk/conversations/${first}/messages`, async (route) => {
    if (route.request().method() !== "POST" || dropped) return route.continue();
    dropped = true;
    await route.fetch(); // 服务端已保存回答和回复，模拟只有客户端丢失响应。
    await route.fulfill({ status: 503, json: { error: "合成断线测试" } });
  });
  await page.getByRole("textbox", { name: "给 Chloe 的消息" }).fill("I saw a 井盖 outside.");
  await page.getByRole("button", { name: "发送 (Send)", exact: true }).click();
  await expect(page.getByRole("button", { name: "原地重试" })).toBeVisible();
  await page.getByRole("button", { name: "原地重试" }).click();
  await expect(page.getByText("回复未完成，原文已保留。")).toHaveCount(0);
  expect((await (await request.get(`/api/free-talk/conversations/${first}/messages`)).json()).messages).toHaveLength(3);
  await page.getByRole("combobox", { name: "当前对话" }).selectOption(second);
  await expect(page.getByText("I saw a 井盖 outside.", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "🎯 雅思题库", exact: true }).click();
  await expect(page.getByRole("dialog").getByText("What helps you study effectively?", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const assertNoClipping = async () => {
    const layout = await page.locator(".freetalk-main").evaluate((panel) => {
      const bounds = panel.getBoundingClientRect();
      return { scrollLeft: panel.scrollLeft, clipped: [...panel.querySelectorAll("h1, textarea, .header-controls button, .msg-content")].some((child) => {
        const rect = child.getBoundingClientRect();
        return rect.left < bounds.left - 1 || rect.right > bounds.right + 1;
      }) };
    });
    expect(layout).toEqual({ scrollLeft: 0, clipped: false });
  };
  await assertNoClipping();
  await page.screenshot({ path: "test-results/visual/four-step-chat-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  const sizes = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
  expect(sizes.scroll).toBeLessThanOrEqual(sizes.width);
  await assertNoClipping();
  await page.getByRole("textbox", { name: "给 Chloe 的消息" }).fill("A mobile draft");
  const composerVisible = await page.getByRole("textbox", { name: "给 Chloe 的消息" }).evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return element.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2));
  });
  expect(composerVisible).toBe(true);
  await page.screenshot({ path: "test-results/visual/four-step-chat-mobile.png", fullPage: true });
});

test("恢复期间服务端仍在处理时自动读取结果，不永久锁住输入", async ({ page, request }) => {
  const { attempt } = await (await request.post("/api/speaking-practice/questions/question_e2e_habits/attempts", { data: { clientRequestId: "e2e-recover-pending", mode: "practice", answerText: "I saw a 井盖 outside.", intendedMeaningZh: "我在外面看到一个井盖。" } })).json();
  await expect.poll(async () => (await (await request.get(`/api/speaking-practice/attempts/${attempt.id}`)).json()).attempt.status).toBe("completed");
  const { session } = await (await request.post("/api/training/sessions", { data: { materialId: attempt.materialId } })).json();
  await request.post(`/api/training/sessions/${session.id}/events`, { data: { type: "submit", input: "the", clientEventId: "e2e-before-reload", stepVersion: session.stepVersion } });
  await page.route("**/api/training/sessions", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    // 初始快照模拟尚在处理；后续 GET 读取真实、已保存的结果。
    await route.fulfill({ json: { ...body, session: { ...body.session, busy: true } } });
  });
  await page.goto(`/training/${attempt.materialId}`);
  const input = page.getByRole("textbox", { name: "你的英文表达" });
  await expect(input).toBeDisabled();
  await expect(input).toBeEnabled();
  await expect(input).toHaveValue("the");
  await expect(page.getByText("这次尚未表达目标意思，请核对后重试。")).toBeVisible();
});

test("逐句循环停止及离开后不再自动播放", async ({ page, request }) => {
  const question = "question_e2e_habits";
  const { attempt } = await (await request.post(`/api/speaking-practice/questions/${question}/attempts`, { data: { clientRequestId: "e2e-player-synthetic", mode: "practice", answerText: "I saw a 井盖 outside.", intendedMeaningZh: "我在外面看到了井盖。" } })).json();
  await expect.poll(async () => (await (await request.get(`/api/speaking-practice/attempts/${attempt.id}`)).json()).attempt.status).toBe("completed");
  await page.addInitScript(() => {
    class SyntheticAudio extends EventTarget {
      currentTime = 0;
      private timer?: ReturnType<typeof setTimeout>;
      async play() { this.timer = setTimeout(() => this.dispatchEvent(new Event("ended")), 50); }
      pause() { clearTimeout(this.timer); }
    }
    Object.defineProperty(window, "Audio", { configurable: true, value: SyntheticAudio });
  });
  let plays = 0;
  await page.route("**/api/speech/synthesis", async (route) => { plays++; await route.fulfill({ json: { audio: { audioUrl: "/synthetic-test.opus" } } }); });
  await page.goto(`/questions/${question}/attempts/${attempt.id}`);
  await page.getByRole("button", { name: "🎧 逐句跟读模式", exact: true }).click();
  await page.getByRole("button", { name: "🔂 单句循环", exact: true }).click();
  await page.getByRole("button", { name: "▶️ 播放", exact: true }).click();
  await expect.poll(() => plays).toBe(1);
  await page.getByRole("button", { name: "⏸️ 暂停", exact: true }).click();
  await page.waitForTimeout(800); // 特意越过循环间隔，以检验定时器没有复活。
  expect(plays).toBe(1);
  await page.getByRole("button", { name: "▶️ 播放", exact: true }).click();
  await expect.poll(() => plays).toBe(2);
  await page.getByRole("button", { name: "收起逐句播放器 ✕", exact: true }).click();
  await page.waitForTimeout(800);
  expect(plays).toBe(2);
});
