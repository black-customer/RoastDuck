import AxeBuilder from "@axe-core/playwright";
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createClient } from "@libsql/client";
import path from "node:path";
import { assertInsideTestResults } from "../helpers/temp-db";
import { personalGapFixture } from "../helpers/personal-gap-fixture";
import { applyPersonalGapBatch } from "../../src/lib/imports/apply-personal-gap-batch";

test('英文原文处理失败后始终可重试，并保留未保存编辑', async ({ page }) => {
  test.setTimeout(180_000);
  const url = process.env.ROASTDUCK_DB!;
  assertInsideTestResults(path.resolve(url.slice(5)));
  for (const width of [320, 390, 1280, 1440]) {
    const id = `retry_${randomUUID()}`, versionId = `${id}_v1`;
    const client = createClient({ url });
    try {
      await client.execute({ sql: "INSERT INTO personal_answers (id,question_id,input_language,raw_text,status,current_version_id) VALUES (?,'question_e2e_habits','en','I practice every day.','failed',?)", args: [id, versionId] });
      await client.execute({ sql: "INSERT INTO answer_versions (id,answer_id,version_no,kind,text_en) VALUES (?,?,1,'raw','I practice every day.')", args: [versionId, id] });
    } finally { client.close(); }
    let attempts = 0;
    await page.route(`**/api/answers/${id}/process`, (route) => ++attempts === 1
      ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '合成网络故障，请重试' }) }) : route.continue());
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/answer-studio/${id}`);
    const draft = page.getByLabel('可编辑的英文答案版本');
    await draft.fill('My unsaved draft stays here.');
    const retry = page.getByRole('button', { name: '重新处理', exact: true });
    await retry.focus();
    await expect(retry).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('.error-banner[role="alert"]')).toContainText('合成网络故障');
    await expect(draft).toHaveValue('My unsaved draft stays here.');
    await expect(retry).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect((await new AxeBuilder({ page }).analyze()).violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? ''))).toEqual([]);
    await page.screenshot({ path: `test-results/visual/review-retry-${width}.png`, fullPage: true });
    await retry.click();
    await expect(page.getByRole('status')).toContainText('重新处理完成', { timeout: 30_000 });
    await expect(draft).toHaveValue('My unsaved draft stays here.');
    await expect(page.locator('.workspace-original')).toContainText('I practice every day.');
  }
});

test("全站共享蓝白 Web 框架，桌面/手机/放大无溢出，保留导航与无障碍", async ({ page, request }) => {
  test.setTimeout(180_000);
  const created = await request.post("/api/answers", { data: { clientRequestId: randomUUID(), questionId: "question_e2e_habits", inputLanguage: "en", rawText: "I practice every day. It helps me make steady progress." } });
  expect(created.status()).toBe(201);
  const { answer } = await created.json();
  const routes = [
    ["home", "/"], ["questions", "/questions"],
    ["pack", "/questions/question_e2e_habits"],
    ["personal", "/personal-book"], ["books", "/books"],
    ["book", "/books/book_e2e"], ["chunk", "/chunks/c_e2e_progress"],
    ["answer", "/answer-studio?question=question_e2e_habits"],
    ["workspace", `/answer-studio/${answer.id}`],
    ["chat", "/speaking-arena?extension=1&question=question_e2e_habits"],
    ["search", "/search"], ["settings", "/settings"],
    ["content", "/review-content"], ["missing", "/missing-page"],
  ];
  const findings: Array<{ route: string; width: number; issue: string; detail?: unknown }> = [];
  for (const width of [1440, 390, 320, 1280]) {
    await page.setViewportSize({ width, height: width > 767 ? 900 : 844 });
    for (const [name, route] of routes) {
      await page.goto(route);
      if (name === "questions") await expect(page.locator(".question-list")).toBeVisible();
      if (name === "chat") await expect(page.getByRole("region", { name: "与 Chloe 的雅思口语对话" })).toBeVisible();
      if (name === "workspace") await expect(page.getByLabel("可编辑的英文答案版本")).toBeVisible();
      await expect(page.locator("[data-app-shell]")).toHaveCount(1);
      await expect(page.getByRole("main")).toHaveCount(1);
      if (width > 767 && name!=='home') await expect(page.getByRole("navigation", { name: "主导航", exact: true })).toBeVisible();
      else await expect(page.getByRole("button", { name: "展开或收起导航" })).toBeVisible();
      const metrics = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        width: window.innerWidth,
        background: getComputedStyle(document.body).getPropertyValue("--background").trim(),
        main: document.querySelector("main")!.getBoundingClientRect().width,
      }));
      if (metrics.scroll > metrics.width) findings.push({ route, width, issue: "horizontal-overflow", detail: metrics });
      if (metrics.background !== "#eaf0f8") findings.push({ route, width, issue: "wrong-theme", detail: metrics });
      if (width > 767 && metrics.main < width - 260) findings.push({ route, width, issue: "narrow-shell", detail: metrics });
      if (width === 1440 || width === 390) {
        await page.screenshot({ path: `test-results/visual/v02-${name}-${width}.png`, fullPage: true });
        const result = await new AxeBuilder({ page }).analyze();
        for (const item of result.violations.filter(v => ["serious", "critical"].includes(v.impact ?? ""))) {
          findings.push({ route, width, issue: item.id, detail: item.nodes.map(n => ({ target: n.target, reason: n.failureSummary })) });
        }
      }
    }
  }
  // CSS zoom=2 同时验证剩余有效视口，不以 deviceScaleFactor 冒充放大。
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/questions");
  await page.evaluate(() => { document.documentElement.style.zoom = "2"; });
  const zoomed = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, visible: document.documentElement.clientWidth }));
  if (zoomed.scroll > zoomed.visible) findings.push({ route: "/questions", width: 640, issue: "zoom-overflow", detail: zoomed });
  await page.screenshot({ path: "test-results/visual/v02-questions-200pct.png", fullPage: true });
  await test.info().attach("ui-audit", { body: JSON.stringify(findings, null, 2), contentType: "application/json" });
  expect(findings).toEqual([]);
});

test("手机导航可展开、Escape 收起；搜索失败明确且可重试", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/search");
  const toggle = page.getByRole("button", { name: "展开或收起导航" });
  await toggle.click();
  await page.getByRole("navigation", { name: "主导航", exact: true }).getByRole("link", { name: "雅思题库", exact: true }).focus();
  await page.keyboard.press("Escape");
  await expect(toggle).toBeFocused();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await page.route("**/api/expressions?*", route => route.fulfill({ status: 503, json: { error: "搜索服务暂时不可用" } }));
  await page.reload();
  await page.getByLabel("搜索当前中文或英文表达").fill("brush my teeth");
  await expect(page.getByRole("main").getByRole("alert")).toContainText("搜索服务暂时不可用");
  await page.unroute("**/api/expressions?*");
  await page.getByRole("button", { name: "重新读取", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: 'brush my teeth',exact:true })).toBeVisible();
});

test("切分修复旧链接只读，缺失原问句不显示伪造英文或播放按钮", async ({ page }) => {
  const url = process.env.ROASTDUCK_DB!;
  expect(url?.startsWith("file:")).toBe(true);
  assertInsideTestResults(path.resolve(url.slice(5)));
  const client = createClient({ url });
  const suffix = randomUUID(), questionId = `q_recovery_${suffix}`, oldId = `archived_${suffix}`, newId = `recovered_${suffix}`;
  try {
    await client.execute({ sql: "INSERT INTO questions (id,book_id,part,text,text_zh,norm_text,status) VALUES (?,'book_personal_ielts_answers',3,'','Part 3 原问句缺失：测试描述',?,'personal')", args: [questionId, `fixture ${suffix}`] });
    for (const id of [oldId, newId]) {
      await client.execute({ sql: "INSERT INTO personal_answers (id,question_id,input_language,raw_text,status,current_version_id,source_segment_id,source_revision_id,superseded_by_revision_id) VALUES (?,?,'en','I cook daily.','ready',?,'fixture-segment',?,?)", args: [id, questionId, `${id}_v1`, id === newId ? suffix : null, id === oldId ? suffix : null] });
      await client.execute({ sql: "INSERT INTO answer_versions (id,answer_id,version_no,kind,text_en) VALUES (?,?,1,'raw_transcript','I cook daily.')", args: [`${id}_v1`, id] });
    }
  } finally { client.close(); }
  let processCalls = 0;
  await page.route("**/api/answers/*/process", (route) => { processCalls++; return route.abort(); });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/answer-studio/${oldId}`);
  await expect(page.getByRole("heading", { name: "这份原始记录已完成切分修复" })).toBeVisible();
  await expect(page.getByLabel("英文答案版本（只读）")).toHaveAttribute("readonly", "");
  await expect(page.getByRole("button", { name: "另存为新版本" })).toBeDisabled();
  await page.screenshot({ path: "test-results/visual/v02-archived-answer-1440.png", fullPage: true });
  await page.getByRole("link", { name: "查看修复后的回答 1" }).click();
  await expect(page.getByLabel("可编辑的英文答案版本")).toBeEditable();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/questions/${questionId}`);
  await expect(page.getByRole("heading", { name: "历史回答 · 原始问句缺失" })).toBeVisible();
  await expect(page.getByRole("button", { name: "播放题目" })).toBeDisabled();
  await page.screenshot({ path: "test-results/visual/v02-missing-question-390.png", fullPage: true });
  expect((await new AxeBuilder({ page }).analyze()).violations.filter((v) => ["serious", "critical"].includes(v.impact ?? ""))).toEqual([]);
  expect(processCalls).toBe(0);
});

test("离线诊断进入按题问题账本，未编译材料不冒充可学，刷新无自动 AI", async ({ page }) => {
  const url = process.env.ROASTDUCK_DB!;
  assertInsideTestResults(path.resolve(url.slice(5)));
  const client = createClient({ url });
  const f = personalGapFixture(randomUUID()), a = f.input.answers[0];
  try {
    const exec = (sql: string, args: Array<string | number | null>) => client.execute({ sql, args });
    await exec("INSERT INTO questions (id,book_id,part,text,text_zh,norm_text,status) VALUES (?,'book_personal_ielts_answers',1,?,?,?,'personal')", [a.questionId, a.question.textEn, a.question.textZh, a.questionId]);
    await exec("INSERT INTO answer_import_segments (id,import_id,source_order,start_offset,end_offset,segment_type,raw_text) VALUES (?,?,0,0,?,'answer',?)", [a.source.segmentId, a.source.importId, a.rawText.length, a.rawText]);
    await exec("INSERT INTO personal_answers (id,question_id,input_language,raw_text,status,import_id,source_segment_id,source_kind,current_version_id) VALUES (?,?,'en',?,'ready',?,?,'historical_import',?)", [a.answerId, a.questionId, a.rawText, a.source.importId, a.source.segmentId, a.answerVersionId]);
    await exec("INSERT INTO answer_versions (id,answer_id,version_no,kind,text_en) VALUES (?,?,1,'normalized_transcript',?)", [a.answerVersionId, a.answerId, a.rawText]);
    await applyPersonalGapBatch(client, f.validate());
    await exec("INSERT INTO answer_gaps (id,answer_id,gap_type,evidence_text,explanation_zh,confidence,reviewer_decision,reviewer_reason,reviewer_run_id,status) VALUES (?,?,'lexical_gap','quarantined fixture','旧错误诊断',0.5,'pending_review','未独立审核','fixture','pending_review')", [`pending-${a.answerId}`, a.answerId]);
  } finally { client.close(); }
  let writes = 0;
  page.on("request", (request) => { if (request.url().includes("/api/") && request.method() !== "GET") writes++; });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/questions/${a.questionId}?extension=1`);
    await expect(page.locator("#gap-ledger .question-gap-list > li")).toHaveCount(2);
    await expect(page.locator("#gap-ledger")).toContainText("really like");
    await expect(page.locator("#gap-ledger")).toContainText("haven't seen");
    await expect(page.locator("#gap-ledger")).not.toContainText("quarantined fixture");
    await expect(page.getByRole('link',{name:'开始句子学习',exact:true})).toHaveCount(0);
    await expect(page.getByRole("article").getByRole("link", { name: "材料待处理", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "学习本题表达", exact: true })).toHaveCount(0);
    await page.screenshot({ path: `test-results/visual/v02-offline-gap-ledger-${width}.png`, fullPage: true });
  }
  await page.reload();
  await expect(page.locator("#gap-ledger .question-gap-list > li")).toHaveCount(2);
  expect(writes).toBe(0);
});
