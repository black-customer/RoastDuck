import {expect,test,type Page} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
const fixture=()=>({itemId:'ui-expression-one',materialId:'ui-material-one',materialHash:'fixture',rowIndex:0,progressVersion:0,chinese:'习惯一个人住',english:'be used to living alone',sentenceZh:'我已经习惯一个人住了。',sentenceEn:"I'm used to living alone.",originalEnglish:'I am used to live alone.',reasonZh:'合成界面测试材料。',sourceTitle:'我的生活',sourceHref:'/questions/ui-question',questionId:'ui-question',sourceType:'ielts_practice',sources:[],preference:{hidden:0,favorite:0,self_known:0,note:'',version:0},progress:null});
async function mockExpressions(page:Page){
  const item=fixture(),writes:string[]=[];
  await page.route(/\/api\/expressions(?:\?|$)/,async route=>{
    if(route.request().method()==='PATCH'){
      const patch=route.request().postDataJSON();writes.push('preference');
      if(patch.selfKnown!==undefined)item.preference.self_known=Number(patch.selfKnown);
      if(patch.hidden!==undefined)item.preference.hidden=Number(patch.hidden);
      if(patch.favorite!==undefined)item.preference.favorite=Number(patch.favorite);
      item.preference.version++;
      return route.fulfill({json:{preference:item.preference}});
    }
    const p=item.preference,summary={total:1,eligibleTotal:p.hidden?0:1,studied:0,eligibleStudied:0,selfKnownUnstudied:p.self_known,eligibleSelfKnownUnstudied:p.hidden?0:p.self_known,new:p.hidden||p.self_known?0:1,due:0,hidden:p.hidden};
    await route.fulfill({json:{items:[item],summary}});
  });
  await page.route('**/api/light-study/**',route=>{writes.push('light-event');return route.fulfill({status:500,json:{error:'Quick review must not call learning'}});});
  await page.route('**/api/speech/**',route=>{writes.push('speech');return route.fulfill({status:503,json:{error:'Mock only'}});});
  return {writes,item};
}
test('快速回顾逐行真正隐藏英文，可键盘揭晓/收起，不产生学习写入',async({page})=>{
  const {writes}=await mockExpressions(page);
  await page.goto('/quick-review?extension=1&scope=collection&id=ielts');
  const row=page.getByRole('article',{name:'习惯一个人住'}),reveal=row.getByRole('button',{name:'揭晓英文',exact:true});
  await expect(reveal).toBeVisible();await expect(row.locator('[lang="en"]')).toHaveCount(0);await expect(row.getByRole('button',{name:/播放/})).toHaveCount(0);
  for(const width of [1440,390,320]){
    await page.setViewportSize({width,height:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    if(width!==320)await page.screenshot({path:`test-results/visual/quick-review-hidden-${width}.png`,fullPage:true});
  }
  await reveal.focus();await page.keyboard.press('Enter');await expect(row.locator('[lang="en"]')).toHaveCount(2);
  await expect(row.getByRole('button',{name:'播放英文表达'})).toBeVisible();await expect(row.getByRole('button',{name:'播放英文句子'})).toBeVisible();
  const collapse=row.getByRole('button',{name:'收起英文',exact:true});await expect(collapse).toBeFocused();await page.keyboard.press('Space');await expect(row.locator('[lang="en"]')).toHaveCount(0);
  await reveal.click();await page.setViewportSize({width:390,height:900});await page.screenshot({path:'test-results/visual/quick-review-revealed-390.png',fullPage:true});
  expect((await new AxeBuilder({page}).include('main').analyze()).violations).toEqual([]);expect(writes).toEqual([]);
  await page.reload();await expect(row.locator('[lang="en"]')).toHaveCount(0);
});
test('两个表达集合可切换，自评已掌握独立显示并可恢复',async({page})=>{
  const {writes,item}=await mockExpressions(page);await page.goto('/expressions?extension=1');
  await expect(page.getByRole('heading',{name:'我的雅思表达',exact:true})).toBeVisible();
  const row=page.locator('article').filter({has:page.getByRole('heading',{name:item.english,exact:true})});
  await row.getByText('说明、来源与管理',{exact:true}).click();
  await row.getByRole('button',{name:'已掌握（自评）',exact:true}).click();
  await expect(row.getByText('自评已会，尚未学习',{exact:true})).toBeVisible();
  await expect(page.getByRole('region',{name:'表达学习概况'}).getByRole('link',{name:/学新表达/})).toHaveCount(0);
  await page.getByText('筛选表达',{exact:true}).click();
  await page.getByLabel('表达范围').selectOption('known');await expect(row).toBeVisible();
  for(const width of [1440,390,320]){await page.setViewportSize({width,height:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);if(width!==320)await page.screenshot({path:`test-results/visual/expression-collection-${width}.png`,fullPage:true});}
  await row.getByRole('button',{name:'恢复推送',exact:true}).click();await expect(row).toHaveCount(0);
  await page.getByLabel('表达范围').selectOption('all');await expect(row.getByText('待学',{exact:true})).toBeVisible();
  await page.getByRole('navigation',{name:'个人表达集合'}).getByRole('link',{name:'我的对话表达'}).click();
  await expect(page).toHaveURL(/scope=collection&id=free_talk/);await expect(page.getByRole('heading',{name:'我的对话表达',exact:true})).toBeVisible();
  await expect(page.getByRole('region',{name:'表达学习概况'}).getByRole('link',{name:'快速回顾'})).toHaveAttribute('href','/quick-review?extension=1&scope=collection&id=free_talk');
  expect(writes).toEqual(['preference','preference']);
});
