import {test,expect,type Locator} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

async function selectText(element:Locator,quote:string){
  await element.evaluate((root,text)=>{
    const complete=root.textContent??'',start=complete.indexOf(text);if(start<0)throw new Error('Selection text missing');
    function locate(offset:number){const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let node:Node|null,remaining=offset;while((node=walker.nextNode())){const length=node.textContent?.length??0;if(remaining<=length)return {node,offset:remaining};remaining-=length;}throw new Error('Selection boundary missing');}
    const a=locate(start),b=locate(start+text.length),range=document.createRange();range.setStart(a.node,a.offset);range.setEnd(b.node,b.offset);const selection=window.getSelection()!;selection.removeAllRanges();selection.addRange(range);root.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
  },quote);
}
test('个人中英文高亮可保存、刷新、失败重试和键盘取消，不改学习成绩',async({page,request})=>{
  await page.addInitScript(()=>localStorage.setItem('roastduck_sentence_reexpress_v1','0'));
  await page.route('**/api/speech/synthesis',route=>route.fulfill({status:503,contentType:'application/json',body:'{"error":"Mock audio unavailable"}'}));
  const overview=(await(await request.get('/api/sentence-study/overview?scope=question&id=sentence-e2e-performance')).json()).overview;
  const created=await request.post('/api/sentence-study/sessions',{data:{scope:{type:'material',id:overview.sources[0].materialId},mode:'learn',clientRequestId:'e2e-highlight-only'}});expect(created.ok()).toBe(true);
  const session=(await created.json()).session,card=session.cards[0];
  await page.goto(`/sentence-study?session=${session.id}`);
  const chinese=page.locator('article h1[lang="zh"]'),english=page.locator('article p[lang="en"]').first();
  await expect(chinese).toContainText('我想阅读第1章。');
  await selectText(chinese,'阅读');await page.getByRole('button',{name:'高亮',exact:true}).click();
  await expect(chinese.locator('mark')).toHaveText('阅读');
  await page.getByRole('button',{name:'看自然表达',exact:true}).click();
  await expect(english).toBeVisible();await selectText(english,'read chapter');
  let failed=false;await page.route('**/api/sentence-study/highlights',async route=>{if(route.request().method()==='POST'&&!failed){failed=true;await route.fulfill({status:503,contentType:'application/json',body:'{"error":"模拟断网：高亮尚未保存","code":"unavailable"}'});}else await route.continue();});
  await page.getByRole('button',{name:'高亮',exact:true}).click();await expect(page.getByText('模拟断网：高亮尚未保存',{exact:false})).toBeVisible();
  await page.getByRole('button',{name:'重试高亮保存',exact:true}).click();await expect(page.getByText('模拟断网：高亮尚未保存',{exact:false})).toHaveCount(0);
  const query=`sentenceId=${encodeURIComponent(card.id)}&textVersion=${encodeURIComponent(card.version)}`;
  await expect.poll(async()=>((await(await request.get(`/api/sentence-study/highlights?${query}`)).json()).highlights.length)).toBe(2);
  await page.reload();await expect(chinese.locator('mark')).toHaveText('阅读');await expect(english.locator('mark')).toHaveText('read chapter');
  const appearance=await english.locator('mark').evaluate(mark=>({background:getComputedStyle(mark).backgroundColor,weight:getComputedStyle(mark).fontWeight,parent:getComputedStyle(mark.parentElement!).fontWeight}));expect(appearance.background).toBe('rgb(255, 240, 166)');expect(appearance.weight).toBe(appearance.parent);
  await english.focus();await page.keyboard.press('Home');await page.keyboard.press('Shift+ArrowRight');await page.keyboard.press('Alt+h');
  await expect(page.getByRole('button',{name:'高亮',exact:true})).toBeFocused();await page.keyboard.press('Enter');
  await expect.poll(async()=>((await(await request.get(`/api/sentence-study/highlights?${query}`)).json()).highlights.length)).toBe(3);
  await page.setViewportSize({width:320,height:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'test-results/visual/sentence-highlights-320.png',fullPage:true});
  expect((await new AxeBuilder({page}).analyze()).violations.filter(item=>item.impact==='serious'||item.impact==='critical')).toEqual([]);
  const sessionAfter=(await(await request.get(`/api/sentence-study/sessions/${session.id}`)).json()).session;expect(sessionAfter.assessments).toHaveLength(0);
  await english.locator('mark',{hasText:'read chapter'}).click();await page.getByRole('button',{name:'取消高亮',exact:true}).click();
  await expect.poll(async()=>((await(await request.get(`/api/sentence-study/highlights?${query}`)).json()).highlights.length)).toBe(2);
});
