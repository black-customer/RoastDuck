import AxeBuilder from '@axe-core/playwright';
import {expect,test} from '@playwright/test';

test('极简首页只突出学习/复习，热力图只读，菜单和键盘入口可达',async({page})=>{
  const writes:string[]=[];page.on('request',r=>{if(r.method()!=='GET'&&r.url().includes('/api/'))writes.push(r.url());});
  await page.setViewportSize({width:1280,height:800});await page.goto('/');
  await expect(page.getByRole('heading',{name:'我的学习记录',exact:true})).toBeVisible();
  const actions=page.locator('[aria-label="学习与复习"]');
  await expect(actions.locator('a[aria-label="学习"],button[aria-label="学习"]')).toBeInViewport();
  await expect(actions.locator('a[aria-label="复习"],button[aria-label="复习"]')).toBeInViewport();
  await expect(page.locator('[aria-label="每日学习记录"] button')).toHaveCount(84);
  await expect(page.locator('[aria-label="每日学习记录"] button[tabindex="0"]')).toHaveCount(1);
  await page.locator('[aria-label="每日学习记录"] button:not(:disabled)').first().click();
  expect(writes).toEqual([]);
  await expect(page.getByRole('navigation',{name:'主导航',exact:true})).not.toBeVisible();
  await page.getByRole('button',{name:'展开或收起导航'}).click();
  await expect(page.getByRole('link',{name:'雅思题库',exact:true})).toBeVisible();
  await page.getByRole('link',{name:'雅思题库',exact:true}).focus();await page.keyboard.press('Escape');
  await expect(page.getByRole('button',{name:'展开或收起导航'})).toBeFocused();
  expect((await new AxeBuilder({page}).analyze()).violations).toEqual([]);
  await page.screenshot({path:'test-results/visual/simple-home-1280.png',fullPage:true});
});

test('320/390窄屏保留两主动作，不被统计挤出首屏',async({page})=>{
  for(const width of [320,390]){
    await page.setViewportSize({width,height:844});await page.goto('/');
    await expect(page.getByRole('heading',{name:'我的学习记录'})).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await expect(page.locator('[aria-label="学习与复习"]')).toBeInViewport();
    await page.getByRole('button',{name:'展开或收起导航'}).click();
    await expect(page.getByRole('link',{name:'学习设置',exact:true})).toBeVisible();
    await page.getByRole('button',{name:'展开或收起导航'}).click();
  }
  expect((await new AxeBuilder({page}).analyze()).violations).toEqual([]);
  await page.screenshot({path:'test-results/visual/simple-home-390.png',fullPage:true});
});

test('自动组选启动丢响应，刷新重试使用同一提交与会话',async({page,request})=>{
  let id='',failed=false;const ids:string[]=[];
  await page.goto('/study?mode=learn');
  await page.route('**/api/sentence-study/sessions',async route=>{
    if(route.request().method()!=='POST'){await route.continue();return;}
    ids.push(route.request().postDataJSON().clientRequestId);
    if(!failed){failed=true;const response=await route.fetch();expect(response.ok()).toBe(true);id=(await response.json()).session.id;await route.abort();}else await route.continue();
  });
  await page.getByRole('button',{name:'帮我选一道',exact:true}).click();
  await expect(page.getByRole('alert')).toBeVisible();await page.reload();
  await page.getByRole('button',{name:'帮我选一道',exact:true}).click();
  await expect(page.getByRole('button',{name:'看自然表达',exact:true})).toBeVisible();
  expect(new URL(page.url()).searchParams.get('session')).toBe(id);expect(new Set(ids).size).toBe(1);
  await page.getByRole('button',{name:'暂停学习'}).click();
  await expect.poll(async()=>(await(await request.get(`/api/sentence-study/sessions/${id}`)).json()).session.status).toBe('paused');
  await page.goto('/');await page.getByRole('button',{name:'学习',exact:true}).click();
  await expect(page.getByRole('button',{name:'看自然表达',exact:true})).toBeVisible();
  expect(new URL(page.url()).searchParams.get('session')).toBe(id);
});

test('选题直接开始本题新表达，不改变范围或经过四步',async({page,request})=>{
  const {question}=await(await request.get('/api/questions/light-e2e-home')).json();
  await page.goto('/study?mode=learn&choose=questions');
  await page.getByPlaceholder('输入题目中的中文或英文').fill(question.textEn);
  const choices=page.locator('[data-question-id="light-e2e-home"]').getByRole('button',{name:/^学习：/});
  await expect(choices.first()).toBeVisible();await choices.first().click();
  await expect(page.getByRole('button',{name:'看自然表达',exact:true})).toBeVisible();
  const sessionId=new URL(page.url()).searchParams.get('session');
  const session=(await(await request.get(`/api/sentence-study/sessions/${sessionId}`)).json()).session;
  expect(session.scope).toEqual({type:'question',id:'light-e2e-home'});expect(session.mode).toBe('learn');
  await expect(page.getByRole('button',{name:'看自然表达',exact:true})).toBeVisible();
  await expect(page.getByRole('textbox')).toHaveCount(0);
});
