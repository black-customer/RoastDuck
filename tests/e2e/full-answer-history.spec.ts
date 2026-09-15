import {expect,test} from '@playwright/test';
import type {FullAnswer} from '../../src/lib/answer-audio/contracts';

test('回答历史区分录制和保存时间，A→B只使用一个原速播放器',async({page})=>{
  const ids=['10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002'];
  const attempts:FullAnswer[]=ids.map((id,index)=>({id:`answer-${index}`,questionId:'history-browser-fixture',sourceKey:`take-${index}`,stage:'independent',promptCondition:'只看题目',materialId:null,text:'A synthetic full answer.',refs:{},createdAt:`2026-09-${index?'12':'10'}T02:00:00Z`,updatedAt:`2026-09-${index?'12':'10'}T02:00:00Z`,audio:[{id,fullAnswerId:`answer-${index}`,sha256:'0'.repeat(64),byteLength:16044,mimeType:'audio/wav',extension:'wav',durationSeconds:1,source:index?'recording':'upload',originalName:'synthetic.wav',note:'',createdAt:`2026-09-${index?'12':'10'}T02:00:00Z`,recordedAt:index?'2026-09-12T01:55:00Z':null,recordedAtSource:index?'recording':'unknown',removedAt:null,purgedAt:null}]}));
  attempts.unshift({id:'original-answer',questionId:'history-browser-fixture',sourceKey:'legacy-original',stage:'initial',promptCondition:'历史回答，提示条件未记录',materialId:null,text:'The original saved answer.',refs:{attemptId:'original-answer'},createdAt:'2025-01-01T00:00:00Z',updatedAt:'2025-01-01T00:00:00Z',audio:[],legacy:true,countsAsAttempt:true});
  await page.addInitScript(()=>{HTMLMediaElement.prototype.play=function(){this.dispatchEvent(new Event('play'));return Promise.resolve();};HTMLMediaElement.prototype.pause=function(){};});
  await page.route('**/api/full-answer-attempts?**',route=>route.fulfill({json:{question:{textEn:'Describe your day.',textZh:'描述你的一天。'},attempts}}));
  await page.route('**/api/answer-audio/**',route=>{
    const wav=Buffer.alloc(16044);wav.write('RIFF');wav.writeUInt32LE(16036,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(16000,40);return route.fulfill({contentType:'audio/wav',body:wav});
  });
  await page.goto('/answer-history/history-browser-fixture');await expect(page.getByRole('heading',{name:'听听每一次的自己',exact:true})).toBeVisible();
  await expect(page.getByText('沿用原回答记录与日期，没有补造录音或新提交。',{exact:true})).toBeVisible();await expect(page.getByText('这次回答没有保存原声。',{exact:true})).toBeVisible();
  await expect(page.locator('article').getByText(/^录制时间未知 · 保存于/)).toBeVisible();await expect(page.locator('article').getByText(/录音开始时间 · 保存于/)).toBeVisible();
  await page.getByRole('button',{name:'按 A → B 顺序回听',exact:true}).click();const player=page.getByLabel('完整回答原声播放器',{exact:true});
  await expect(player).toHaveAttribute('src',`/api/answer-audio/${ids[0]}`);await player.evaluate(element=>element.dispatchEvent(new Event('ended')));await expect(player).toHaveAttribute('src',`/api/answer-audio/${ids[1]}`);
  expect(await player.evaluate(element=>(element as HTMLAudioElement).playbackRate)).toBe(1);await expect(page.locator('audio')).toHaveCount(1);await player.evaluate(element=>element.dispatchEvent(new Event('ended')));await expect(page.getByRole('button',{name:'停止顺序回听',exact:true})).toHaveCount(0);
});
