import {expect,test} from '@playwright/test';
import type {SentenceCard,SentencePreference} from '../../src/lib/sentence-study/contracts';
import type {SentenceFeedback} from '../../src/lib/sentence-study/preferences';

test('当前句子库保留未提交备注，丢回执复用原请求，反馈可撤回且不写学习成绩',async({page})=>{
  let preference:SentencePreference={hidden:false,favorite:false,selfKnown:false,note:'',version:0};
  let feedback:SentenceFeedback[]=[];
  let dropNote=true;
  const receipts=new Map<string,SentencePreference>(),noteRequests:string[]=[],learningWrites:string[]=[];
  const card:SentenceCard={id:'library-ui-sentence',version:'library-ui-v1',materialId:'library-ui-material',sentenceId:'sentence-1',ordinal:0,chinese:'我喜欢清晨散步。',english:'I enjoy a walk in the morning.',contextZh:'谈自己的生活习惯',meaningOrigin:'user_chinese',usages:[],notes:[],progressVersion:0,source:{type:'ielts_practice',id:'library-ui-answer',questionId:'sentence-e2e-performance',title:'我自己的生活习惯',href:'/questions/sentence-e2e-performance'}};
  page.on('request',request=>{if(request.method()==='POST'&&/\/api\/sentence-study\/sessions/.test(request.url()))learningWrites.push(request.url());});
  await page.route('**/api/sentence-study/preferences?*',route=>route.fulfill({json:{scope:{type:'question',id:'sentence-e2e-performance'},cards:[{...card,preference,...(feedback.some(item=>item.kind==='incorrect'&&item.status==='open')?{unavailable:'本版内容待核对'}:{})}],feedback}}));
  await page.route('**/api/sentence-study/preferences',async route=>{
    const input=route.request().postDataJSON();
    if(typeof input.note==='string')noteRequests.push(input.clientRequestId);
    const saved=receipts.get(input.clientRequestId);if(saved)return route.fulfill({json:{preference:saved}});
    if(input.version!==preference.version)return route.fulfill({status:409,json:{error:'另一窗口已更新偏好，请重新读取'}});
    preference={...preference,...Object.fromEntries(['hidden','favorite','selfKnown','note'].filter(key=>input[key]!==undefined).map(key=>[key,input[key]])),version:preference.version+1};
    receipts.set(input.clientRequestId,structuredClone(preference));
    if(typeof input.note==='string'&&dropNote){dropNote=false;return route.abort('failed');}
    return route.fulfill({json:{preference}});
  });
  await page.route('**/api/sentence-study/feedback',route=>{
    const input=route.request().postDataJSON();
    const value:SentenceFeedback=input.action==='withdraw'?{...feedback.find(item=>item.id===input.feedbackId)!,status:'withdrawn'}:{id:'library-feedback',sentenceId:card.id,unitVersion:card.version,kind:input.kind,reason:input.reason,status:'open',createdAt:'2026-09-15T00:00:00Z'};
    feedback=[value,...feedback.filter(item=>item.id!==value.id)];return route.fulfill({json:{feedback:value}});
  });
  await page.goto('/expressions?scope=question&id=sentence-e2e-performance');
  await expect(page.getByText(card.english,{exact:true})).toBeVisible();
  await page.getByText('备注与学习偏好',{exact:true}).click();
  await page.getByRole('textbox',{name:'我的备注',exact:true}).fill('自写备注草稿');
  await page.getByRole('button',{name:'收藏这句',exact:true}).click();
  await expect(page.getByRole('button',{name:'取消收藏这句',exact:true})).toBeVisible();
  await page.reload();await page.getByText('备注与学习偏好',{exact:true}).click();
  await expect(page.getByRole('textbox',{name:'我的备注',exact:true})).toHaveValue('自写备注草稿');
  await page.getByRole('button',{name:'保存备注',exact:true}).click();
  await expect(page.getByRole('button',{name:'恢复同一次保存',exact:true})).toBeVisible();
  await page.reload();await page.getByRole('button',{name:'恢复同一次保存',exact:true}).click();
  await expect(page.getByText('我的备注：自写备注草稿',{exact:true})).toBeVisible();
  expect(noteRequests).toHaveLength(2);expect(new Set(noteRequests).size).toBe(1);
  await page.getByText('备注与学习偏好',{exact:true}).click();
  await page.getByRole('button',{name:'暂不学，停止提醒',exact:true}).click();
  await expect(page.getByRole('button',{name:'恢复学习提醒',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'恢复学习提醒',exact:true}).click();
  await expect(page.getByRole('button',{name:'暂不学，停止提醒',exact:true})).toBeVisible();
  await page.getByText('材料反馈',{exact:true}).click();
  await page.getByRole('combobox',{name:'反馈类型',exact:true}).selectOption('incorrect');
  await page.getByLabel('哪儿需要改进？',{exact:true}).fill('我原本想说傍晚。');
  await page.getByRole('button',{name:'保存材料反馈',exact:true}).click();
  await expect(page.getByText('这句材料暂缓使用',{exact:true})).toBeVisible();
  await expect(page.getByRole('link',{name:'打开整题学习',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'撤回这条反馈',exact:true}).click();
  await expect(page.getByRole('link',{name:'打开整题学习',exact:true})).toBeVisible();
  expect(preference.hidden).toBe(false);expect(feedback[0].status).toBe('withdrawn');expect(learningWrites).toEqual([]);
});
