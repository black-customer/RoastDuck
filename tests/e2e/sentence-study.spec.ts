import {test,expect,type Page} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import fs from 'node:fs';
async function setup(page:Page){await page.addInitScript(()=>{localStorage.setItem('roastduck_sentence_reexpress_v1','0');Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:()=>{throw new Error('No microphone in sentence study');}}});});await page.route('**/api/speech/synthesis',r=>r.fulfill({status:503,contentType:'application/json',body:'{"error":"Mock audio unavailable"}'}));}
test('整题中文先行，揭晓/切句不等网络，三档评分后停留，完成后可更正评分',async({page,request})=>{
  await setup(page);await page.goto('/sentence-study?scope=question&id=sentence-e2e-new&mode=learn');
  await expect(page.getByRole('heading',{name:'我想做早餐。',exact:true})).toBeVisible();await expect(page.getByRole('textbox',{name:'写下你的尝试（可留空）',exact:true})).toBeVisible();await expect(page.getByText('I want to make breakfast.',{exact:true})).toHaveCount(0);await expect(page.getByText(/秒后揭晓/)).toHaveCount(0);
  await page.route('**/api/sentence-study/sessions/*/events',async route=>{await new Promise(resolve=>setTimeout(resolve,400));await route.continue();});
  for(const [index,label] of ['脱口而出','想出来了','遇到卡壳'].entries()){
    await page.getByRole('button',{name:'看自然表达与讲解',exact:true}).click();await expect(page.locator('article [lang="en"]').first()).toBeVisible();
    if(index===0){await page.setViewportSize({width:390,height:844});await page.screenshot({path:'test-results/visual/sentence-revealed-390.png',fullPage:true});expect((await new AxeBuilder({page}).analyze()).violations).toEqual([]);}
    await page.getByRole('button',{name:new RegExp('^'+label)}).first().click();
    await expect(page.locator('article')).toHaveAttribute('data-stage','rated');
    await page.getByRole('button',{name:index===2?'完成本题':'下一句',exact:true}).click();
  }
  await expect(page.getByRole('heading',{name:/本次(句子学习|到期复习)已完成/})).toBeVisible();
  await expect(page.getByText(/^下次复习：/)).toBeVisible({timeout:10000});
  const id=new URL(page.url()).searchParams.get('session')!;const before=(await(await request.get(`/api/sentence-study/sessions/${id}`)).json()).session;expect(before.cards).toHaveLength(3);expect(before.assessments).toHaveLength(3);
  await page.getByRole('button',{name:'修改上次自评',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'脱口而出',exact:true}).click();await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect.poll(async()=>((await(await request.get(`/api/sentence-study/sessions/${id}`)).json()).session.assessments.at(-1).rating)).toBe('remembered');
  const after=(await(await request.get(`/api/sentence-study/sessions/${id}`)).json()).session;expect(after.assessments).toHaveLength(3);
  await page.getByRole('link',{name:'选择下一道题',exact:true}).click();await expect(page.getByRole('heading',{name:'想学会哪一道题？'})).toBeVisible();
});
test('暂停/刷新恢复同一题，句子完整呈现；窄屏和旧模式隔离',async({page})=>{
  await setup(page);await page.goto('/sentence-study?scope=question&id=sentence-e2e-next&mode=learn');await expect(page.getByRole('heading',{name:'我想弹吉他。'})).toBeVisible();
  for(const width of [1280,390,320]){await page.setViewportSize({width,height:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await expect(page.getByRole('button',{name:'看自然表达与讲解',exact:true})).toBeInViewport();if(width!==320)await page.screenshot({path:`test-results/visual/sentence-prompt-${width}.png`,fullPage:true});}
  await page.getByRole('button',{name:'看自然表达与讲解',exact:true}).click();await page.getByRole('button',{name:/^脱口而出/}).click();await page.getByRole('button',{name:'下一句',exact:true}).click();await expect(page.getByRole('heading',{name:'我想听音乐。'})).toBeVisible();await page.getByRole('button',{name:'暂停学习',exact:true}).click();
  await expect(page.getByRole('heading',{name:'停在这里，下次继续'})).toBeVisible();await expect(page.getByText('位置已保存。',{exact:false})).toBeVisible();const id=new URL(page.url()).searchParams.get('session');await page.reload();await page.getByRole('button',{name:'继续学习',exact:true}).click();await expect(page.getByRole('heading',{name:'我想听音乐。'})).toBeVisible();expect(new URL(page.url()).searchParams.get('session')).toBe(id);
  await page.goto('/light-study');await expect(page.getByRole('heading',{name:/拓展|旧/})).toBeVisible();await expect(page.getByRole('button',{name:'开始轻松学',exact:true})).toHaveCount(0);
});
test('句子复习只装载到期内容，可选输出独立时没有旧答案',async({page,request})=>{
  await setup(page);await page.goto('/sentence-study?scope=question&id=sentence-e2e-review&mode=review');await expect(page.getByRole('button',{name:'看自然表达与讲解',exact:true})).toBeVisible();
  for(let i=0;i<2;i++){await page.getByRole('button',{name:'看自然表达与讲解',exact:true}).click();await page.getByRole('button',{name:/^脱口而出/}).click();await page.getByRole('button',{name:i===1?'完成本题':'下一句',exact:true}).click();}
  await expect(page.getByRole('heading',{name:/本次(句子学习|到期复习)已完成/})).toBeVisible();await page.getByRole('button',{name:'不看提示，独立回答',exact:true}).click();await expect(page.getByRole('textbox')).toBeVisible();await expect(page.getByText('我想喝点水。',{exact:true})).toHaveCount(0);await expect(page.getByText('I want to drink some water.',{exact:true})).toHaveCount(0);
  const overview=(await(await request.get('/api/sentence-study/overview?scope=question&id=sentence-e2e-review')).json()).overview;expect(overview.newCount).toBe(0);
});
test('连续三十句的浏览器揭晓和切句满足即时响应预算',async({page})=>{
  await setup(page);await page.goto('/sentence-study?scope=question&id=sentence-e2e-performance&mode=learn');await expect(page.getByRole('heading',{name:'我想阅读第1章。',exact:true})).toBeVisible();
  const samples=await page.evaluate(async()=>{
    const readings:number[]=[],ratings:number[]=[];
    const until=(test:()=>boolean)=>new Promise<void>((resolve,reject)=>{if(test()){resolve();return;}const timer=setTimeout(()=>{observer.disconnect();reject(new Error('UI transition exceeded 1500ms'));},1500),observer=new MutationObserver(()=>{if(test()){clearTimeout(timer);observer.disconnect();resolve();}});observer.observe(document.body,{subtree:true,childList:true,characterData:true});});
    for(let i=1;i<=30;i++){
      await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
      const reveal=Array.from(document.querySelectorAll('button')).find(b=>b.textContent?.trim()==='看自然表达与讲解');if(!reveal)throw new Error('Missing reveal');
      let start=performance.now();reveal.click();await until(()=>document.querySelector('article')?.getAttribute('data-stage')==='teaching');readings.push(performance.now()-start);
      await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
      const rate=Array.from(document.querySelectorAll<HTMLButtonElement>('footer button')).find(b=>b.textContent?.startsWith('脱口而出'));if(!rate)throw new Error('Missing rating');
      rate.click();await until(()=>document.querySelector('article')?.getAttribute('data-stage')==='rated');
      await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
      const advance=Array.from(document.querySelectorAll<HTMLButtonElement>('footer button')).find(b=>b.textContent?.trim()===(i===30?'完成本题':'下一句'));if(!advance)throw new Error('Missing advance');
      start=performance.now();advance.click();await until(()=>i===30?Array.from(document.querySelectorAll('h1')).some(h=>h.textContent==='本次句子学习已完成'):Array.from(document.querySelectorAll('h1')).some(h=>h.textContent===`我想阅读第${i+1}章。`));ratings.push(performance.now()-start);
    }
    return {readings,ratings};
  });
  const p95=(values:number[])=>[...values].sort((a,b)=>a-b)[Math.floor(values.length*.95)];
  const result={...samples,revealP95:p95(samples.readings),nextP95:p95(samples.ratings)};fs.mkdirSync('test-results/sentence-performance',{recursive:true});fs.writeFileSync('test-results/sentence-performance/browser.json',JSON.stringify(result,null,2));
  expect(result.revealP95).toBeLessThanOrEqual(200);expect(result.nextP95).toBeLessThanOrEqual(200);await expect(page.getByText(/^下次复习：/)).toBeVisible({timeout:15000});
});
test('可选本地再练刷新后保留当前输入，跳过不自动请求老师',async({page})=>{
  await setup(page);await page.goto('/sentence-study?scope=question&id=sentence-e2e-output&mode=learn');
  await expect(page.getByRole('heading',{name:'我想做晚饭。',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'学习设置',exact:true}).click();
  await page.getByRole('checkbox',{name:'自评后自动进入本地再练',exact:true}).check();
  await page.getByRole('button',{name:'学习设置',exact:true}).click();
  await page.getByRole('button',{name:'看自然表达与讲解',exact:true}).click();
  await page.getByRole('button',{name:/^遇到卡壳/}).click();
  await page.getByRole('textbox',{name:'再练一次的表达（可留空）',exact:true}).fill('I want to cook dinner.');
  await page.reload();
  await expect(page.getByRole('textbox',{name:'再练一次的表达（可留空）',exact:true})).toHaveValue('I want to cook dinner.');
  await expect(page.getByText('我想洗碗。',{exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'下一句',exact:true}).click();
  await expect(page.getByRole('heading',{name:'我想洗碗。',exact:true})).toBeVisible();
});
