import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const question = 'question_e2e_habits';
function syntheticWav() { const b = Buffer.alloc(16044); b.write('RIFF'); b.writeUInt32LE(16036, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24); b.writeUInt32LE(16000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(16000, 40); return b; }
async function forbidRealMicrophone(page: Page) { await page.addInitScript(() => { Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: () => { throw new Error('Real microphone is forbidden in this test'); } } }); }); }

test('完整回答上传刷新恢复、丢失回执重试、原声历史与可恢复删除', async ({ page, request }) => {
  await forbidRealMicrophone(page); let runtimeCalls = 0;
  page.on('request', r => { if (r.method() === 'POST' && /\/api\/(speech\/synthesis|coaching\/messages)/.test(r.url())) runtimeCalls++; });
  await page.goto(`/questions/${question}/practice`);
  const panel = page.getByRole('region', { name: '完整回答原声' }); await expect(panel).toBeVisible();
  const before = (await (await request.get(`/api/full-answer-attempts?questionId=${question}`)).json()).attempts as Array<{ id: string }>;
  await panel.getByLabel('上传完整回答音频').setInputFiles({ name: 'synthetic-original.wav', mimeType: 'audio/wav', buffer: syntheticWav() });
  await expect(panel.getByRole('button', { name: '保存这次完整回答', exact: true })).toBeEnabled(); await page.reload();
  await expect(panel.getByRole('button', { name: '保存这次完整回答', exact: true })).toBeEnabled();
  let dropped = false;
  await page.route('**/api/answer-audio/uploads/*', async route => {
    if (!dropped && route.request().method() === 'POST') { dropped = true; const result = await route.fetch(); expect(result.ok()).toBeTruthy(); await route.abort(); } else await route.continue();
  });
  await panel.getByRole('button', { name: '保存这次完整回答', exact: true }).click(); await expect(panel.getByRole('alert')).toBeVisible();
  await panel.getByRole('button', { name: '保存这次完整回答', exact: true }).click(); await expect(panel.getByRole('status')).toContainText('完整回答已保存');
  const after = (await (await request.get(`/api/full-answer-attempts?questionId=${question}`)).json()).attempts as Array<{ id: string; audio: Array<{ id: string }> }>;
  expect(after).toHaveLength(before.length + 1); const saved = after.find(a => !before.some(b => b.id === a.id))!; expect(saved.audio).toHaveLength(1);
  const range = await request.get(`/api/answer-audio/${saved.audio[0].id}`, { headers: { Range: 'bytes=0-43' } }); expect(range.status()).toBe(206); expect((await range.body()).length).toBe(44);
  await panel.getByRole('link', { name: '查看已保存原声与历史对比' }).click(); await expect(page.getByRole('heading', { name: '听听每一次的自己' })).toBeVisible();
  const take = page.locator('article').filter({ hasText: 'synthetic-original.wav' }).last();
  await take.getByRole('textbox', { name: '给这次原声留个备注' }).fill('合成夹具，仅验证文件链路'); await take.getByRole('button', { name: '保存备注', exact: true }).click();
  for (const width of [1280, 390, 320]) { await page.setViewportSize({ width, height: 900 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy(); await page.screenshot({ path: `test-results/visual/answer-audio-history-${width}.png`, fullPage: true }); }
  expect((await new AxeBuilder({ page }).include('main').analyze()).violations).toEqual([]);
  await take.getByRole('button', { name: '移除原声', exact: true }).click(); await expect(take.getByRole('button', { name: '恢复原声', exact: true })).toBeVisible();
  await take.getByRole('button', { name: '恢复原声', exact: true }).click(); await expect(take.getByRole('link', { name: '下载原文件' })).toBeVisible();
  await take.getByRole('button', { name: '永久删除…', exact: true }).click(); await expect(take.getByRole('button', { name: '确认永久删除', exact: true })).toBeDisabled();
  await take.getByLabel('输入“永久删除原声”确认').fill('永久删除原声'); await take.getByRole('button', { name: '确认永久删除', exact: true }).click(); await expect(take).toContainText('原声已永久删除');
  expect((await request.get(`/api/answer-audio/${saved.audio[0].id}`)).status()).toBe(410); expect(runtimeCalls).toBe(0);
});

test('合成采集器只在点击后申请，分片暂存并在停止/离页释放，不把中断当完整回答', async ({ page }) => {
  await page.addInitScript((bytes: number[]) => {
    const diagnostics = { requests: 0, stopped: 0 }; Object.defineProperty(window, '__audioFixture', { value: diagnostics });
    const tracks = () => [{ stop: () => { diagnostics.stopped++; }, addEventListener: () => undefined }];
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => { diagnostics.requests++; const list = tracks(); return { getTracks: () => list, getAudioTracks: () => list }; } } });
    Object.defineProperty(window, 'MediaRecorder', { configurable: true, value: class {
      static isTypeSupported() { return false; }
      mimeType = 'audio/wav'; state = 'inactive'; ondataavailable?: (event: { data: Blob }) => void; onstop?: () => void;
      start() { this.state = 'recording'; setTimeout(() => this.ondataavailable?.({ data: new Blob([new Uint8Array(bytes.slice(0, 8000))], { type: 'audio/wav' }) }), 5); }
      stop() { if (this.state !== 'recording') return; this.state = 'inactive'; this.ondataavailable?.({ data: new Blob([new Uint8Array(bytes.slice(8000))], { type: 'audio/wav' }) }); queueMicrotask(() => this.onstop?.()); }
    } });
  }, Array.from(syntheticWav()));
  await page.goto(`/questions/${question}/practice`); const panel = page.getByRole('region', { name: '完整回答原声' }); await expect(panel).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __audioFixture: { requests: number } }).__audioFixture.requests)).toBe(0);
  await panel.getByRole('button', { name: '开始录音', exact: true }).click(); await expect(panel.getByRole('button', { name: '停止录音', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => new Promise<number>((resolve, reject) => { const r = indexedDB.open('roastduck-answer-audio-v1'); r.onerror = () => reject(r.error); r.onsuccess = () => { const tx = r.result.transaction('chunks'), request = tx.objectStore('chunks').count(); request.onsuccess = () => resolve(request.result); tx.oncomplete = () => r.result.close(); }; }))).toBeGreaterThan(0);
  await panel.getByRole('button', { name: '停止录音', exact: true }).click(); await expect(panel.getByRole('button', { name: '保存这次完整回答', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => (window as unknown as { __audioFixture: { stopped: number } }).__audioFixture.stopped)).toBeGreaterThan(0);
  await panel.getByRole('button', { name: '开始录音', exact: true }).click(); await expect(panel.getByRole('button', { name: '停止录音', exact: true })).toBeVisible();
  page.once('dialog', dialog => void dialog.accept()); await page.goto('/questions'); await page.goto(`/questions/${question}/practice`);
  await expect(panel.getByLabel('本机待保存原声')).toContainText('未完成片段');
});
