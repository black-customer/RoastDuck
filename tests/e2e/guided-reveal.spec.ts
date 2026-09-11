import {test,expect,type Page} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {emptySentencePractice,projectSentenceEvent,sentenceEventSchema,type SentenceCard,type SentenceSession} from '../../src/lib/sentence-study/contracts';

// Original, isolated demonstration content. No private materials or Runtime requests.
const english='I like starting with a simple breakfast on the weekend before trying new recipes.';
const chinese='我喜欢先在周末试做一顿简单的早餐，再慢慢尝试新菜。';
function fixture():SentenceSession{
  const phrases=[[chinese,english],['我会先把食材准备好。','I get the ingredients ready first.']];
  const cards:SentenceCard[]=phrases.map(([zh,en],i)=>({
    id:`guided-fixture-${i}`,version:'guided-text-1',materialId:'guided-material',sentenceId:`s${i}`,ordinal:i,
    chinese:zh,english:en,contextZh:'聊聊自己在家做饭的习惯。',meaningOrigin:'user_chinese',usages:[],notes:[],progressVersion:0,userHighlights:[],
    source:{type:'ielts_practice',id:'guided-attempt',questionId:'guided-question',title:'自己的早餐习惯',href:'/questions/guided-question'},
    teachingRevision:'original-test-teaching-v1',teaching:{version:'sentence-teaching-v1',overviewZh:'先说习惯，再说明做事的先后顺序。',parts:[{
      cueZh:zh,quoteEn:en,explanationZh:i===0?'like 后面可以接动词的 -ing 形式，表达喜欢做的事。':'get something ready 表示把某样东西准备好。',
      pattern:i===0?'I like + 动词-ing':'get + 事物 + ready',examples:[{english:'I like cooking with friends.',chinese:'我喜欢和朋友一起做饭。'}],
      alternatives:[{english:'I enjoy cooking.',chinese:'我喜欢做饭。',whenZh:'enjoy 更突出享受这件事的过程。'}],contrastZh:'这里描述习惯，不要求用户逐字重复参考答案。',
    }]},
  }));
  return {id:'guided-isolated-session',scope:{type:'question',id:'guided-question'},mode:'learn',status:'active',version:0,cards,index:0,revealed:false,assessments:[],lastRatingEventId:null,nextDueAt:null,notice:null,experienceVersion:'guided-reveal-v1',stage:'recall',practice:emptySentencePractice()};
}

async function setup(page:Page,{audioDelay=0,autoPlay=false}:{audioDelay?:number;autoPlay?:boolean}={}){
  let live=fixture(),dropNextCheckpoint=false;
  const events:Array<ReturnType<typeof sentenceEventSchema.parse>>=[],receipts=new Map<string,SentenceSession>();
  let coachingPosts=0;
  await page.addInitScript(()=>{
    localStorage.setItem('roastduck_sentence_reexpress_v1','0');
    const state={plays:0,microphones:0};Object.assign(window,{guidedTestMedia:state});
    HTMLMediaElement.prototype.play=function(){state.plays++;return Promise.resolve();};
    HTMLMediaElement.prototype.pause=function(){};
    if(window.speechSynthesis)window.speechSynthesis.speak=()=>{state.plays++;};
    Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:()=>{state.microphones++;throw new Error('Unexpected microphone request');}}});
  });
  await page.route('**/api/settings',route=>route.fulfill({json:{settings:{autoPlay}}}));
  await page.route('**/api/speech/synthesis',async route=>{
    if(!autoPlay)return route.fulfill({status:503,json:{code:'mock_unavailable',error:'Mock audio unavailable'}});
    const body=route.request().postDataJSON();
    if(audioDelay)await new Promise(resolve=>setTimeout(resolve,audioDelay));
    await route.fulfill({json:{audio:{audioUrl:'/api/speech/assets/guided-mock.wav',voice:body.voice,accent:body.accent}}});
  });
  await page.route('**/api/speech/assets/**',route=>{
    const wav=Buffer.alloc(48);wav.write('RIFF');wav.writeUInt32LE(40,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(4,40);
    return route.fulfill({contentType:'audio/wav',body:wav});
  });
  await page.route('**/api/sentence-study/highlights**',route=>route.fulfill({json:{highlights:[],unmappedCount:0}}));
  await page.route('**/api/sentence-study/sessions**',async route=>{
    if(route.request().method()==='POST'&&new URL(route.request().url()).pathname.endsWith('/events')){
      const event=sentenceEventSchema.parse(route.request().postDataJSON());
      const receipt=receipts.get(event.clientEventId);
      if(receipt)return route.fulfill({json:{session:receipt}});
      if(event.version!==live.version)return route.fulfill({status:409,json:{error:'位置已变化，请恢复最新位置',code:'version_conflict'}});
      live=projectSentenceEvent(live,event);if(event.type==='rate'||event.type==='revise_rating')live.nextDueAt='2026-09-15T04:00:00.000Z';
      events.push(event);receipts.set(event.clientEventId,structuredClone(live));
      if(dropNextCheckpoint&&event.type==='checkpoint'){dropNextCheckpoint=false;return route.abort('failed');}
    }
    return route.fulfill({json:{session:live}});
  });
  await page.route('**/api/coaching**',route=>{
    if(route.request().method()==='POST')coachingPosts++;
    return route.fulfill({json:{questionEn:'What do you like cooking?',chinese,threadId:'guided-coach',messages:[]}});
  });
  return {current:()=>live,events,dropCheckpoint:()=>{dropNextCheckpoint=true;},coachingPosts:()=>coachingPosts};
}

async function open(page:Page){await page.goto('/sentence-study?scope=question&id=guided-question&mode=learn');await expect(page.getByRole('heading',{level:1,name:chinese,exact:true})).toBeVisible();}
const recallBox=(page:Page)=>page.getByRole('textbox',{name:'写下你的尝试（可留空）',exact:true});
const retryBox=(page:Page)=>page.getByRole('textbox',{name:'再练一次的表达（可留空）',exact:true});
const saveError=(page:Page)=>page.locator('[data-sentence-focus] [role="alert"]');
const mediaPlays=(page:Page)=>page.evaluate(()=>(window as unknown as {guidedTestMedia:{plays:number}}).guidedTestMedia.plays);

test('跟手只揭晓前缀；草稿恢复，教学分层，自评停留，本地再练不请求老师',async({page})=>{
  const harness=await setup(page);await open(page);
  await expect(recallBox(page)).toHaveValue('');expect(await recallBox(page).evaluate(el=>el===document.activeElement)).toBe(false);
  await expect(page.getByTestId('guided-english')).not.toContainText('breakfast');
  await expect(page.getByRole('heading',{name:'这句怎么说',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'揭晓一点',exact:true}).click();await expect(page.getByTestId('guided-english')).toContainText('I');
  await expect(page.getByTestId('guided-english')).not.toContainText('like');
  await recallBox(page).fill('I like making breakfast');await page.getByRole('slider',{name:'揭晓英文进度'}).focus();
  await expect.poll(()=>harness.current().practice?.draft).toBe('I like making breakfast');
  await page.reload();await expect(recallBox(page)).toHaveValue('I like making breakfast');
  await expect(page.getByRole('slider')).toHaveValue('1');
  await page.getByRole('button',{name:'全部揭晓',exact:true}).click();await expect(page.getByTestId('guided-english')).toHaveText(english);
  await expect(page.locator('article')).toHaveAttribute('data-stage','recall');expect(await mediaPlays(page)).toBe(0);
  await page.getByRole('button',{name:'看自然表达与讲解',exact:true}).click();
  await expect(page.getByRole('heading',{name:'这句怎么说',exact:true})).toBeVisible();
  await expect(page.getByText('I like cooking with friends.',{exact:true})).not.toBeVisible();
  await page.getByText('例句、辨析与其他说法',{exact:true}).click();await expect(page.getByText('I like cooking with friends.',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:/^遇到卡壳/}).click();await expect(page.getByRole('heading',{level:1,name:chinese,exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'下一句',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'再练一遍',exact:true}).click();
  await expect(retryBox(page)).toBeVisible();await expect(page.getByRole('heading',{name:'这句怎么说',exact:true})).toHaveCount(0);
  await expect(page.locator('article [lang="en"]')).toHaveCount(0);
  expect(await page.locator('body').textContent()).not.toContain('I like making breakfast');
  await retryBox(page).fill('I enjoy cooking on weekends.');await page.reload();
  await expect(retryBox(page)).toHaveValue('I enjoy cooking on weekends.');
  await page.getByRole('button',{name:'揭晓并对照',exact:true}).click();await expect(page.getByText('I enjoy cooking on weekends.',{exact:true})).toBeVisible();
  expect(harness.coachingPosts()).toBe(0);expect(harness.events.filter(event=>event.type==='rate')).toHaveLength(1);
  await page.getByRole('button',{name:'请老师看看',exact:true}).click();await expect(page.getByRole('textbox',{name:'你的英文表达',exact:true})).toHaveValue('I enjoy cooking on weekends.');
  expect(harness.coachingPosts()).toBe(0);await page.getByRole('button',{name:'关闭表达练习',exact:true}).click();
  await page.getByRole('button',{name:'下一句',exact:true}).click();await expect(page.getByRole('heading',{name:'我会先把食材准备好。',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'看自然表达与讲解',exact:true}).click();await page.getByRole('button',{name:/^想出来了/}).click();
  await expect(page.getByRole('heading',{name:'本次句子学习已完成',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'完成本题',exact:true}).click();await expect(page.getByRole('heading',{name:'本次句子学习已完成',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'修改上次自评',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'脱口而出',exact:true}).click();
  await expect.poll(()=>harness.current().assessments.at(-1)?.rating).toBe('remembered');expect(harness.current().assessments).toHaveLength(2);
});

test('范围滑轨支持键盘、多行、窄屏及缩放，未揭晓内容不进入复制与读屏',async({page})=>{
  await setup(page);await open(page);
  const slider=page.getByRole('slider',{name:'揭晓英文进度'});
  await page.setViewportSize({width:390,height:844});await slider.scrollIntoViewIfNeeded();
  const touch=await page.context().newCDPSession(page);await touch.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1});
  const track=await slider.boundingBox();expect(track).not.toBeNull();
  const origin={x:track!.x+14,y:track!.y+track!.height/2};
  await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[origin]});
  for(let step=1;step<=4;step++)await touch.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:origin.x+(track!.width-28)*step/6,y:origin.y}]});
  await touch.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await expect.poll(async()=>Number(await slider.inputValue())).toBeGreaterThan(0);
  await touch.send('Emulation.setTouchEmulationEnabled',{enabled:false});await touch.detach();
  await slider.focus();await page.keyboard.press('Home');
  await slider.focus();await page.keyboard.press('ArrowRight');await page.keyboard.press('ArrowRight');await expect(slider).toHaveValue('2');
  const copied=await page.getByTestId('guided-english').evaluate(el=>{const range=document.createRange();range.selectNodeContents(el);const selection=getSelection();selection?.removeAllRanges();selection?.addRange(range);const text=selection?.toString();selection?.removeAllRanges();return text;});
  expect(copied).toContain('I like');expect(copied).not.toContain('breakfast');
  expect(await page.locator('body').ariaSnapshot()).not.toContain('recipes');
  for(const width of [1440,1280,390,320]){
    await page.setViewportSize({width,height:900});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await expect(slider).toHaveValue('2');await page.evaluate(()=>{(document.activeElement as HTMLElement)?.blur();window.scrollTo(0,0);});await page.screenshot({path:`test-results/visual/guided-recall-${width}.png`});
  }
  await page.setViewportSize({width:640,height:900});await page.evaluate(()=>document.documentElement.style.zoom='2');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.evaluate(()=>document.documentElement.style.zoom='');await page.setViewportSize({width:390,height:844});
  await expect(page.getByRole('button',{name:'看自然表达与讲解',exact:true})).toBeInViewport();
  await recallBox(page).scrollIntoViewIfNeeded();await recallBox(page).fill('I like cooking.');
  await expect.poll(()=>recallBox(page).evaluate(element=>{const box=element.getBoundingClientRect(),footer=document.querySelector('footer')!.getBoundingClientRect();return box.top>=64&&box.bottom<footer.top;})).toBe(true);
  await page.screenshot({path:'test-results/visual/guided-writing-390.png'});
  expect((await new AxeBuilder({page}).analyze()).violations).toEqual([]);
  await page.getByRole('button',{name:'看自然表达与讲解',exact:true}).click();await page.evaluate(()=>{(document.activeElement as HTMLElement)?.blur();window.scrollTo(0,0);});await page.screenshot({path:'test-results/visual/guided-teaching-390.png'});
  await page.getByRole('button',{name:/^脱口而出/}).click();await page.getByRole('button',{name:'再练一遍',exact:true}).click();
  await page.evaluate(()=>{(document.activeElement as HTMLElement)?.blur();window.scrollTo(0,0);});await page.screenshot({path:'test-results/visual/guided-retry-390.png'});
  await expect(page.getByRole('button',{name:'揭晓并对照',exact:true})).toBeInViewport();
});

test('服务端已存但回执丢失时恢复原草稿；最后一句仍可重练且不重复计分',async({page})=>{
  const harness=await setup(page);await open(page);harness.dropCheckpoint();
  await recallBox(page).fill('I like a simple breakfast.');await page.getByRole('slider').focus();
  await expect(saveError(page)).toBeVisible();await expect(recallBox(page)).toHaveValue('I like a simple breakfast.');
  await page.getByRole('button',{name:'重试保存／恢复',exact:true}).click();await expect(saveError(page)).toHaveCount(0);
  await page.getByRole('button',{name:'看自然表达与讲解',exact:true}).click();await page.getByRole('button',{name:/^脱口而出/}).click();
  await page.reload();await expect(page.getByRole('button',{name:'下一句',exact:true})).toBeVisible();expect(harness.current().index).toBe(0);
  await page.getByRole('button',{name:'下一句',exact:true}).click();await page.getByRole('button',{name:'看自然表达与讲解',exact:true}).click();
  await page.getByRole('button',{name:/^遇到卡壳/}).click();await page.getByRole('button',{name:'再练一遍',exact:true}).click();
  await page.getByRole('button',{name:'揭晓并对照',exact:true}).click();await page.getByRole('button',{name:'重新遮住，再练一遍',exact:true}).click();
  expect(harness.events.filter(e=>e.type==='rate')).toHaveLength(2);
  await page.getByRole('button',{name:'完成本题',exact:true}).click();await expect(page.getByRole('heading',{name:'本次句子学习已完成',exact:true})).toBeVisible();
});

test('英文全部跟手揭晓仍不发声，再练后迟到的音频只缓存',async({page})=>{
  await setup(page,{autoPlay:true,audioDelay:2500});await open(page);
  await page.getByRole('button',{name:'全部揭晓',exact:true}).click();expect(await mediaPlays(page)).toBe(0);
  await page.getByRole('button',{name:'看自然表达与讲解',exact:true}).click();await page.getByRole('button',{name:/^脱口而出/}).click();
  await page.getByRole('button',{name:'再练一遍',exact:true}).click();const before=await mediaPlays(page);
  await page.waitForTimeout(2800);expect(await mediaPlays(page)).toBe(before);await expect(page.locator('article [lang="en"]')).toHaveCount(0);
  expect(await page.evaluate(()=>(window as unknown as {guidedTestMedia:{microphones:number}}).guidedTestMedia.microphones)).toBe(0);
});

test('浏览器写入失败保留当前输入，恢复后再保存；不自动弹出老师',async({page})=>{
  await setup(page);await open(page);
  await page.evaluate(()=>{const original=Storage.prototype.setItem;Object.assign(window,{guidedRestoreStorage:()=>{Storage.prototype.setItem=original;}});Storage.prototype.setItem=function(key,value){if(key.startsWith('sentence_practice:'))throw new DOMException('quota','QuotaExceededError');return original.call(this,key,value);};});
  await recallBox(page).fill('My unfinished attempt');await expect(saveError(page)).toBeVisible();await expect(recallBox(page)).toHaveValue('My unfinished attempt');
  await page.evaluate(()=>(window as unknown as {guidedRestoreStorage:()=>void}).guidedRestoreStorage());
  await page.getByRole('button',{name:'重试保存／恢复',exact:true}).click();await expect(saveError(page)).toHaveCount(0);
  await page.reload();await expect(recallBox(page)).toHaveValue('My unfinished attempt');
  await page.getByRole('button',{name:'学习设置',exact:true}).click();await page.getByRole('checkbox',{name:'自评后自动进入本地再练',exact:true}).check();await page.getByRole('button',{name:'学习设置',exact:true}).click();
  await page.getByRole('button',{name:'看自然表达与讲解',exact:true}).click();await page.getByRole('button',{name:/^遇到卡壳/}).click();await expect(retryBox(page)).toBeVisible();
  await expect(page.getByRole('heading',{name:'再表达一次',exact:true})).toHaveCount(0);
});

test('待确认材料标明仅含确认内容，只能单句试听而不连播缺失的全文',async({page})=>{
  await setup(page);
  await page.route('**/api/materials/guided-partial',route=>route.fulfill({json:{verified:true,material:{id:'guided-partial',source_type:'free_talk',source_id:'guided-source',question_id:null,status:'ready',error_code:null,input_json:JSON.stringify({actualAnswer:'I used something in class.',intendedMeaningZh:''})},analysis:{learningMaterials:[],gaps:[],corrections:[],needsAttention:[]}}}));
  await page.route('**/api/sentence-study/materials/guided-partial',route=>route.fulfill({json:{lesson:{referenceText:'I remember trying something in class.',sentences:[{id:'partial-1',chinese:'我记得在课堂上尝试过一件事。',english:'I remember trying something in class.'}],needsAttention:[{intentZh:'那个东西的名称',reasonZh:'名称尚未确定，需要补充。'}]}}}));
  await page.goto('/materials/guided-partial');
  await expect(page.getByRole('heading',{name:'已确认的自然表达',exact:true})).toBeVisible();
  await expect(page.getByText('仅含已确认内容，另有细节待补充。',{exact:false})).toBeVisible();
  await expect(page.getByRole('button',{name:'播放自然表达全文',exact:true})).toHaveCount(0);
  await page.getByText('逐句试听',{exact:true}).click();
  await expect(page.getByRole('button',{name:'试听第 1 句',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:/连播|跟读停顿/})).toHaveCount(0);
  expect(await mediaPlays(page)).toBe(0);
});
