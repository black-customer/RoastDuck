import {expect,test} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
const question='question_e2e_habits';
test('单框混合草稿刷新恢复、提交丢响应原地恢复，不创建第二份回答',async({page,request})=>{
  await page.goto(`/questions/${question}/practice`);
  await page.getByLabel('我的回答与想法',{exact:true}).fill('I saw a 井盖 outside.\n我在外面看到了一个井盖。');
  await expect(page.getByText('已保存到本机',{exact:true})).toBeVisible();
  await page.reload();await expect(page.getByLabel('我的回答与想法',{exact:true})).toHaveValue('I saw a 井盖 outside.\n我在外面看到了一个井盖。');
  for(const width of [1440,390,320]){await page.setViewportSize({width,height:1000});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);if(width!==320)await page.screenshot({path:`test-results/visual/web-draft-${width}.png`,fullPage:true});}
  expect((await new AxeBuilder({page}).include('main').analyze()).violations).toEqual([]);
  let attemptId='',dropped=false;
  await page.route('**/api/answer-drafts/*',async route=>{if(route.request().method()==='POST'&&route.request().postDataJSON().action==='submit'&&!dropped){dropped=true;const response=await route.fetch();expect(response.ok()).toBe(true);attemptId=(await response.json()).attemptId;await route.abort();}else await route.continue();});
  await page.getByRole('button',{name:'保存并分析我的表达',exact:true}).click();await expect(page.locator('main').getByRole('alert')).toBeVisible();
  await page.getByRole('button',{name:'保存并分析我的表达',exact:true}).click();await expect(page).toHaveURL(new RegExp(`/attempts/${attemptId}$`));
  const history=(await(await request.get(`/api/speaking-practice/questions/${question}/attempts`)).json()).attempts;expect(history.filter((a:{id:string})=>a.id===attemptId)).toHaveLength(1);
  await expect(page.getByRole('link',{name:'轻松学本次表达',exact:true})).toBeVisible();
  await page.getByRole('link',{name:'不看提示，重新回答',exact:true}).click();
  await expect(page.getByLabel('我真正想表达的中文意思（可选）',{exact:true})).toHaveCount(0);await expect(page.getByLabel('我的英文尝试',{exact:true})).toHaveValue('');
  await page.getByLabel('我的英文尝试',{exact:true}).fill('I saw a manhole cover outside.');await page.getByRole('button',{name:'封存英文，再继续'}).click();
  await expect(page.getByLabel('我的英文尝试',{exact:true})).toBeDisabled();await expect(page.getByLabel('我真正想表达的中文意思（可选）',{exact:true})).toHaveValue('');
});
test('服务器不可用时先展示本机救援文字，不用空白覆盖',async({page})=>{
  await page.addInitScript(({question})=>localStorage.setItem(`roastduck_answer_draft:${question}:practice:`,JSON.stringify({clientId:'local-recovery-id',values:{english:'Keep my unsaved answer.',chinese:'保留我的原意。',englishUnknown:false}})),{question});
  await page.route('**/api/answer-drafts?*',route=>route.fulfill({status:503,json:{error:'模拟离线'}}));
  await page.goto(`/questions/${question}/practice`);await expect(page.getByLabel('我的回答与想法',{exact:true})).toHaveValue('Keep my unsaved answer.\n\n保留我的原意。');await expect(page.locator('main').getByRole('alert')).toContainText('模拟离线');
  expect(await page.evaluate(({question})=>JSON.parse(localStorage.getItem(`roastduck_answer_draft:${question}:practice:`)!).values.chinese,{question})).toBe('保留我的原意。');
});
test('当前材料可查找收藏、隐藏及恢复，隐藏不更新学习进度',async({page,request})=>{
  const {items}=await(await request.get('/api/expressions?scope=question&id=light-e2e-weak&includeHidden=1')).json(),item=items[0];
  await page.goto('/review-content');await page.getByPlaceholder('搜索中文或英文表达').fill(item.english);const card=page.getByTestId('expression-row').filter({has:page.getByRole('heading',{name:item.english,exact:true})});
  await card.getByText('说明、来源与管理',{exact:true}).click();
  await card.getByRole('button',{name:'收藏',exact:true}).click();await expect(card.getByRole('button',{name:'已收藏',exact:true})).toBeVisible();
  await card.getByRole('button',{name:'暂不学',exact:true}).click();await expect(card).toHaveCount(0);await page.locator('summary').filter({hasText:/^筛选表达/}).click();await page.getByLabel('表达范围').selectOption('hidden');await expect(card).toBeVisible();await card.getByText('说明、来源与管理',{exact:true}).click();await card.getByRole('button',{name:'恢复学习',exact:true}).click();await page.getByLabel('表达范围').selectOption('all');await expect(card).toBeVisible();
  const overview=(await(await request.get('/api/light-study/overview?scope=question&id=light-e2e-weak')).json()).overview;expect(overview.totalCount).toBe(5);
});
