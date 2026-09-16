import {expect,test,type Page} from '@playwright/test';
import {emptySentencePractice,focusSentence,projectSentenceEvent,sentenceEventSchema,sentencePracticeKey,type SentenceCard,type SentenceEvent,type SentenceSession} from '../../src/lib/sentence-study/contracts';

// Browser event/projection fixtures only. Session creation uses the existing isolated E2E seed,
// so server-rendered Home can offer the real session identity without touching user data.
const title='把自己的日常说清楚 · 合成九句';
function contextFixture(base:SentenceSession):SentenceSession{
  const cards:SentenceCard[]=Array.from({length:9},(_,index)=>({id:`context-fixture-${base.id}-${index}`,version:'context-ui-fixture-v1',materialId:'context-ui-material',sentenceId:`sentence-${index}`,ordinal:index,chinese:`合成日常里的第 ${index+1} 个完整意思。`,english:`I can describe part ${index+1} of my day in my own words.`,contextZh:'合成整题上下文',meaningOrigin:'user_chinese',usages:[],notes:[],progressVersion:index<4?1:0,userHighlights:[],source:{type:'ielts_practice',id:'context-ui-source',questionId:base.scope.type==='question'?base.scope.id:'sentence-e2e-new',title,href:'/questions/sentence-e2e-new'}}));
  const session:SentenceSession={...base,cards,index:0,focusId:cards[0].id,targetIds:cards.slice(4).map(card=>card.id),practiceByUnit:{},experienceVersion:'context-workspace-v1',practice:emptySentencePractice(),stage:'recall',status:'active',assessments:[],lastRatingEventId:null,nextDueAt:null,revealed:false,notice:null};focusSentence(session,cards[0].id);return session;
}
async function setup(page:Page){
  const sessions=new Map<string,SentenceSession>(),events:SentenceEvent[]=[],attempts:SentenceEvent[]=[],createScopes:unknown[]=[],receipts=new Map<string,string>();let dropType:SentenceEvent['type']|null=null;
  await page.addInitScript(()=>{
    const state={plays:0,microphones:0};Object.assign(window,{contextTestMedia:state});
    HTMLMediaElement.prototype.play=function(){state.plays++;return Promise.resolve();};HTMLMediaElement.prototype.pause=function(){};
    Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:()=>{state.microphones++;throw new Error('Real microphone is forbidden in this test');}}});
    const voice={name:'Synthetic local English',lang:'en-US',localService:true,default:true,voiceURI:'synthetic'};
    Object.defineProperty(window,'SpeechSynthesisUtterance',{configurable:true,value:class {constructor(public text:string){} }});
    Object.defineProperty(window,'speechSynthesis',{configurable:true,value:{getVoices:()=>[voice],cancel:()=>{},pause:()=>{},resume:()=>{},speaking:false,speak:(utterance:SpeechSynthesisUtterance)=>{state.plays++;for(let index=0;index<3;index++)utterance.onstart?.(new Event('start') as SpeechSynthesisEvent);}}});
  });
  await page.route('**/api/settings',route=>route.fulfill({json:{settings:{autoPlay:false}}}));
  await page.route('**/api/speech/synthesis',route=>route.fulfill({status:503,json:{error:'Synthetic unavailable voice',code:'mock_unavailable'}}));
  await page.route('**/api/sentence-study/highlights**',route=>route.fulfill({json:{highlights:[],unmappedCount:0}}));
  await page.route('**/api/sentence-study/sessions**',async route=>{
    const request=route.request(),url=new URL(request.url()),parts=url.pathname.split('/'),id=parts[4];
    if(request.method()==='POST'&&url.pathname.endsWith('/events')){
      const input=sentenceEventSchema.parse(request.postDataJSON()),live=sessions.get(id);if(!live)return route.continue();attempts.push(input);
      const receiptKey=id+':'+input.clientEventId,hash=JSON.stringify(input),receipt=receipts.get(receiptKey);
      if(receipt)return route.fulfill({status:receipt===hash?200:409,json:receipt===hash?{session:live}:{error:'事件编号负载冲突',code:'event_conflict'}});
      if(input.version!==live.version)return route.fulfill({status:409,json:{error:'学习位置已变化，请恢复',code:'version_conflict'}});
      const projected=projectSentenceEvent(live,input);sessions.set(id,projected);receipts.set(receiptKey,hash);events.push(input);
      if(dropType===input.type){dropType=null;return route.abort();}
      return route.fulfill({json:{session:projected}});
    }
    if(request.method()==='GET'&&sessions.has(id))return route.fulfill({json:{session:sessions.get(id)}});
    if(request.method()==='POST'&&url.pathname==='/api/sentence-study/sessions'){
      createScopes.push(request.postDataJSON().scope);const response=await route.fetch(),body=await response.json();if(!response.ok())return route.fulfill({response,json:body});
      const actual=body.session as SentenceSession;if(!sessions.has(actual.id))sessions.set(actual.id,contextFixture(actual));return route.fulfill({json:{session:sessions.get(actual.id)}});
    }
    return route.continue();
  });
  return {sessions,events,attempts,createScopes,dropNext:(type:SentenceEvent['type'])=>{dropType=type;},current:()=>sessions.get(new URL(page.url()).searchParams.get('session')!)!};
}
async function choose(page:Page,questionId='sentence-e2e-new'){
  await page.goto('/study?mode=learn&choose=questions');await page.locator(`[data-question-id="${questionId}"]`).getByRole('button').first().click();await expect(page.getByRole('heading',{name:title,exact:true})).toBeVisible();
}
const sentence=(page:Page,index:number)=>page.getByRole('region',{name:`第 ${index} 句`,exact:true});
const panel=(page:Page,name:string)=>page.getByRole('complementary',{name,exact:true});
const notSaving=(page:Page)=>expect(page.getByText(/正在保存.*服务端尚未确认/)).toHaveCount(0);

test('真实题库材料的学习页以英文题干为主，中文仅作辅助',async({page})=>{
  await page.setViewportSize({width:1440,height:900});
  await page.goto('/sentence-study?scope=question&id=sentence-e2e-new&mode=learn');
  await expect(page.getByRole('heading',{level:1,name:'How would you describe your day?',exact:true})).toBeVisible();
  await expect(page.getByText('你会怎样描述这一天？',{exact:true})).toBeVisible();
  await page.screenshot({path:'test-results/visual/question-en-first-1440.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await expect(page.getByRole('heading',{level:1,name:'How would you describe your day?',exact:true})).toBeVisible();
  await page.screenshot({path:'test-results/visual/question-en-first-390.png',fullPage:true});
});

test('首页保留自己选题和继续选择；整题九句、五个目标可自由切换而不评分',async({page})=>{
  const harness=await setup(page);await page.goto('/');await page.getByRole('link',{name:'学习',exact:true}).click();
  await expect(page.getByRole('heading',{name:'从一道题开始',exact:true})).toBeVisible();await page.getByRole('link',{name:'自己选题',exact:false}).click();
  await page.locator('[data-question-id="sentence-e2e-new"]').getByRole('button').first().click();await expect(page.getByRole('heading',{name:title,exact:true})).toBeVisible();
  await expect(page.locator('[data-sentence-id]')).toHaveCount(9);await expect(page.locator('[data-target="true"]')).toHaveCount(5);await expect(page.getByText('本次待回想 5 句',{exact:true})).toBeVisible();
  await page.setViewportSize({width:1440,height:1000});await page.screenshot({path:'test-results/visual/context-workspace-1440.png',fullPage:true});
  await sentence(page,9).getByRole('button',{name:'在第 9 句回想',exact:true}).click();await expect(sentence(page,9).getByRole('button',{name:'9 / 9',exact:true})).toHaveAttribute('aria-pressed','true');
  expect(harness.events.filter(event=>['rate','reveal','enter_teaching','exposure'].includes(event.type))).toEqual([]);
  const id=harness.current().id;await page.getByRole('button',{name:'今天先到这里',exact:true}).click();await notSaving(page);await expect(page.getByRole('heading',{name:'今天先到这里，也很好。',exact:true})).toBeVisible();
  await page.goto('/');await page.getByRole('link',{name:'学习',exact:true}).click();await expect(page.getByRole('button',{name:'继续上次',exact:true})).toBeVisible();await expect(page.getByRole('link',{name:'自己选题',exact:false})).toBeVisible();
  await page.getByRole('button',{name:'继续上次',exact:true}).click();await expect(page.getByRole('heading',{name:title,exact:true})).toBeVisible();expect(new URL(page.url()).searchParams.get('session')).toBe(id);expect(harness.createScopes).toHaveLength(1);
  await page.getByRole('button',{name:'暂停并换题',exact:true}).click();await expect(page.getByRole('heading',{name:'想学会哪一道题？',exact:true})).toBeVisible();
  await page.locator('[data-question-id="sentence-e2e-next"]').getByRole('button').first().click();await expect(page.getByRole('heading',{name:title,exact:true})).toBeVisible();expect(new URL(page.url()).searchParams.get('session')).not.toBe(id);expect(harness.createScopes.at(-1)).toEqual({type:'question',id:'sentence-e2e-next'});
});

test('不同句子的草稿与面板独立保存；刷新、Escape和键盘揭晓不串句',async({page})=>{
  const harness=await setup(page);await choose(page);await page.getByRole('button',{name:'写下我的尝试',exact:true}).click();
  await panel(page,'本句草稿').getByRole('textbox',{name:'我的本句尝试',exact:true}).fill('My first sentence stays here.');
  await panel(page,'本句草稿').getByRole('button',{name:'保存并继续',exact:true}).click();await sentence(page,6).getByRole('button',{name:'在第 6 句回想',exact:true}).click();
  await page.getByRole('button',{name:'写下我的尝试',exact:true}).click();await panel(page,'本句草稿').getByRole('textbox').fill('This belongs to sentence six.');await notSaving(page);
  await expect.poll(()=>harness.current().practice?.draft).toBe('This belongs to sentence six.');await page.reload();
  await expect(panel(page,'本句草稿').getByRole('textbox')).toHaveValue('This belongs to sentence six.');await panel(page,'本句草稿').getByRole('textbox').focus();await page.keyboard.press('Escape');await expect(panel(page,'本句草稿')).toHaveCount(0);
  await sentence(page,1).getByRole('button',{name:'在第 1 句回想',exact:true}).focus();await page.keyboard.press('Enter');await page.getByRole('button',{name:'写下我的尝试',exact:true}).click();await expect(panel(page,'本句草稿').getByRole('textbox')).toHaveValue('My first sentence stays here.');
  await panel(page,'本句草稿').getByRole('button',{name:'关闭辅助面板',exact:true}).click();expect(harness.events.filter(event=>['rate','reveal','enter_teaching','exposure'].includes(event.type))).toEqual([]);
  const slider=page.getByRole('slider',{name:'揭晓英文进度',exact:true});await slider.focus();await page.keyboard.press('ArrowRight');await expect(slider).toHaveValue('1');await slider.blur();
  await expect.poll(()=>harness.current().practiceByUnit?.[sentencePracticeKey(harness.current().cards[0])]?.maxRevealCount).toBe(1);expect(harness.current().assessments).toEqual([]);
});

test('上下文自评不结算，正式评分更正复用原事件而不增加成功次数',async({page})=>{
  const harness=await setup(page);await choose(page);await page.getByRole('button',{name:'记录本句回想',exact:true}).click();
  await panel(page,'记录本句回想').getByRole('button',{name:/^脱口而出/}).click();await notSaving(page);await expect(page.getByText('这次是上下文回看，未改变复习安排。',{exact:true})).toBeVisible();expect(harness.current().assessments).toHaveLength(0);
  await panel(page,'记录本句回想').getByRole('button',{name:'关闭辅助面板',exact:true}).click();await sentence(page,5).getByRole('button',{name:'在第 5 句回想',exact:true}).click();await page.getByRole('button',{name:'记录本句回想',exact:true}).click();
  await panel(page,'记录本句回想').getByRole('button',{name:/^脱口而出/}).click();await notSaving(page);const original=harness.current().lastRatingEventId;expect(harness.current().assessments).toHaveLength(1);
  await expect(panel(page,'记录本句回想').getByRole('button',{name:/^遇到卡壳/})).toBeDisabled();await panel(page,'记录本句回想').getByRole('button',{name:'修改本次自评',exact:true}).click();await panel(page,'记录本句回想').getByRole('button',{name:/^遇到卡壳/}).click();await notSaving(page);
  expect(harness.current().assessments).toHaveLength(1);expect(harness.current().lastRatingEventId).toBe(original);expect(harness.events.at(-1)).toMatchObject({type:'revise_rating',targetEventId:original,rating:'forgot'});
});

test('暂停的回执丢失时只说待确认，重试仍提交原事件编号',async({page})=>{
  const harness=await setup(page);await choose(page);harness.dropNext('pause');await page.getByRole('button',{name:'今天先到这里',exact:true}).click();
  await expect(page.getByRole('heading',{name:'先停在这里，保存仍待确认',exact:true})).toBeVisible();await expect(page.locator('[data-sentence-focus] [role="alert"]')).toBeVisible();await expect(page.getByText('保存确认后显示最新安排',{exact:true})).toBeVisible();
  const original=harness.attempts.find(event=>event.type==='pause')!.clientEventId;await page.getByRole('button',{name:'重试确认',exact:true}).click();await expect(page.locator('[data-sentence-focus] [role="alert"]')).toHaveCount(0);await notSaving(page);
  expect(harness.attempts.filter(event=>event.type==='pause').map(event=>event.clientEventId)).toEqual([original,original]);await expect(page.getByRole('heading',{name:'今天先到这里，也很好。',exact:true})).toBeVisible();expect(harness.events.filter(event=>event.type==='pause')).toHaveLength(1);
});

test('快捷声音的重复开始通知只记一次接触，窄屏仍可操作且不请求麦克风',async({page})=>{
  const harness=await setup(page);await page.setViewportSize({width:390,height:844});await choose(page);await page.getByRole('button',{name:'看自然表达与讲解',exact:true}).click();
  await expect(panel(page,'这句怎么说')).toBeVisible();await panel(page,'这句怎么说').getByRole('button',{name:'关闭辅助面板',exact:true}).click();await page.getByRole('button',{name:'播放本句自然声音',exact:true}).click();await page.getByRole('button',{name:'先听快捷声音',exact:true}).click();
  await expect.poll(()=>harness.events.filter(event=>event.type==='exposure'&&event.source==='audio').length).toBe(1);await notSaving(page);
  expect(await page.evaluate(()=>(window as unknown as {contextTestMedia:{microphones:number}}).contextTestMedia.microphones)).toBe(0);
  for(const width of [390,320]){await page.setViewportSize({width,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await expect(page.getByRole('button',{name:'写下我的尝试',exact:true})).toBeVisible();await page.screenshot({path:`test-results/visual/context-workspace-${width}.png`,fullPage:true});}
});
