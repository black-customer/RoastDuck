import {expect,test} from '@playwright/test';

test('Milo美式默认、独立口音与倍速可保存，改设置不合成音频',async({page})=>{
  let synthesis=0;
  page.on('request',request=>{if(request.url().includes('/api/speech/synthesis'))synthesis++;});
  await page.goto('/settings');
  await expect(page.getByRole('combobox',{name:'声音',exact:true})).toHaveValue('Milo');
  await expect(page.getByRole('combobox',{name:'口音',exact:true})).toHaveValue('en-US');
  await page.getByRole('combobox',{name:'播放速度',exact:true}).selectOption('1.2');
  await page.getByRole('combobox',{name:'口音',exact:true}).selectOption('en-GB');
  await expect(page.getByRole('combobox',{name:'声音',exact:true})).toHaveValue('Milo');
  await page.reload();await expect(page.getByRole('combobox',{name:'播放速度',exact:true})).toHaveValue('1.2');
  await expect(page.getByRole('combobox',{name:'口音',exact:true})).toHaveValue('en-GB');
  await page.getByRole('combobox',{name:'口音',exact:true}).selectOption('en-US');
  for(const width of [1440,390,320]){await page.setViewportSize({width,height:950});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:`test-results/visual/personal-focus-settings-${width}.png`,fullPage:true});}
  expect(synthesis).toBe(0);await expect(page.getByText('鱼块学英语 · v0.2.0 · 本机网页版',{exact:true})).toBeVisible();
});

test('纯英文的中文补充提醒可跳过，跳过只创建一份回答',async({page})=>{
  await page.goto('/questions/question_e2e_habits/practice');
  await page.locator('#input-thoughts').fill('I practice English every morning.');
  await page.getByRole('button',{name:'保存并分析我的表达',exact:true}).click();
  const reminder=page.getByRole('region',{name:'补充中文原意'});
  await expect(reminder).toBeVisible();
  await reminder.getByRole('button',{name:'回去补充中文',exact:true}).click();
  await expect(page.locator('#input-thoughts')).toHaveValue('I practice English every morning.');
  await page.getByRole('button',{name:'保存并分析我的表达',exact:true}).click();
  const response=page.waitForResponse(result=>result.request().method()==='POST'&&/\/api\/answer-drafts\/[^/]+$/.test(new URL(result.url()).pathname));
  await reminder.getByRole('button',{name:'仅根据英文继续',exact:true}).click();
  expect((await response).ok()).toBe(true);
  await expect(page).toHaveURL(/\/questions\/question_e2e_habits\/attempts\//);
  await expect(page.getByRole('link',{name:'开始句子学习',exact:true})).toBeVisible({timeout:20000});
});
