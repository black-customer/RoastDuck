import React,{createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {afterAll,expect,it,vi} from 'vitest';
import type {SentenceCard,SentenceOverview,SentenceSourceOption} from '@/lib/sentence-study/contracts';
import type {SentenceFeedback} from '@/lib/sentence-study/preferences';
import type {QuestionDetail} from '@/lib/questions/service';
import type {AttemptView} from '@/lib/speaking-practice/service';
vi.stubGlobal('React',React);
vi.mock('@/components/SpeakButton',()=>({SpeakButton:()=>createElement('button',null,'SPEECH')}));
vi.mock('@/components/InteractiveEnglishText',()=>({InteractiveEnglishText:()=>createElement('h1',null,'A real question')}));
vi.mock('@/components/LookupCard',()=>({LookupCard:()=>null}));
vi.mock('@/components/ChineseAlignment',()=>({ChineseAlignment:()=>createElement('div',null,'CHINESE ALIGNMENT')}));
vi.mock('@/components/AnswerComparison',()=>({AnswerComparison:()=>null}));
import {filterSentenceLibrary,sentenceCardScope,SentenceLibraryRow,sourceInSentenceScope} from '@/components/expressions/SentenceLibrary';
import {QuestionDetailView} from '@/components/QuestionDetailView';
import {SpeakingAttemptResult} from '@/components/SpeakingAttemptResult';
afterAll(()=>vi.unstubAllGlobals());

const card:SentenceCard={id:'s1',sentenceId:'unit-1',version:'v1',materialId:'material/a',ordinal:0,chinese:'我习惯一个人住。',english:'I am used to living alone.',contextZh:'谈论日常生活',meaningOrigin:'user_chinese',usages:[{id:'usage',text:'used to living',meaningZh:'习惯居住',start:5,end:19,kind:'preparation'}],notes:[],source:{type:'ielts_practice',id:'attempt',questionId:'q1',title:'自己的生活方式',href:'/questions/q1'},progressVersion:0,preference:{hidden:false,favorite:true,selfKnown:false,note:'留意动名词',version:1}};
const source:SentenceSourceOption={id:'q1',type:'question',title:'自己的生活方式',textEn:'How do you live?',part:1,topicId:'daily',topic:'日常',seasons:[{id:'season-a',name:'本题季'}],materialId:'material/a',totalCount:1,newCount:0,dueCount:0,materialStatus:'ready',href:'/questions/q1'};
const overview:SentenceOverview={scope:{type:'question',id:'q1'},newCount:0,dueCount:0,totalCount:1,studiedCount:1,unavailableCount:0,resumable:{},sources:[source]};
const feedback:SentenceFeedback={id:'feedback1',sentenceId:card.id,unitVersion:card.version,kind:'incorrect',reason:'这句与我的原意不符。',status:'open',createdAt:'2026-09-15T00:00:00Z'};

it('searches current sentences, usages and notes without losing paused entries',()=>{
  const paused={...card,id:'s2',preference:{...card.preference!,favorite:false,hidden:true,note:'睡前练习'}};
  expect(filterSentenceLibrary([card,paused],'动名词','all',[])).toEqual([card]);
  expect(filterSentenceLibrary([card,paused],'LIVING','favorite',[])).toEqual([card]);
  expect(filterSentenceLibrary([card,paused],'','paused',[])).toEqual([paused]);
  expect(filterSentenceLibrary([card,paused],'睡前','all',[])).toEqual([paused]);
  expect(filterSentenceLibrary([card,paused],'','feedback',[feedback])).toEqual([card]);
  expect(filterSentenceLibrary([card,paused],'','feedback',[{...feedback,status:'withdrawn'}])).toEqual([]);
});
it('keeps question, topic and season scope intersections and exact material identities',()=>{
  expect(sourceInSentenceScope(source,{type:'collection',id:'ielts',questionId:'q1',topicId:'daily',seasonId:'season-a'})).toBe(true);
  expect(sourceInSentenceScope(source,{type:'collection',id:'ielts',topicId:'different'})).toBe(false);
  expect(sourceInSentenceScope(source,{type:'collection',id:'ielts',seasonId:'unmarked'})).toBe(false);
  expect(sourceInSentenceScope({...source,seasons:[]},{type:'collection',id:'ielts',seasonId:'unmarked'})).toBe(true);
  expect(sourceInSentenceScope(source,{type:'collection',id:'free_talk'})).toBe(false);
  expect(sentenceCardScope(card)).toEqual({type:'material',id:'material/a'});
});
it('shows personal flags and exposure honestly without turning self-known into study credit',()=>{
  const html=renderToStaticMarkup(createElement(SentenceLibraryRow,{card:{...card,preference:{...card.preference!,selfKnown:true}},feedback:[],onPreference:()=>undefined,onFeedback:()=>undefined,onReload:()=>undefined}));
  expect(html).toContain('自评已会');expect(html).toContain('尚未接触');expect(html).not.toContain('已掌握');
  expect(html).toContain('scope=material&amp;id=material%2Fa&amp;mode=learn');
  expect(html).toContain('我的备注');expect(html).toContain('材料反馈');
});
it('quarantined editions show the feedback reason and withdraw action, not a study action',()=>{
  const html=renderToStaticMarkup(createElement(SentenceLibraryRow,{card:{...card,unavailable:'内容有误，待核对'},feedback:[feedback],onPreference:()=>undefined,onFeedback:()=>undefined,onReload:()=>undefined}));
  expect(html).toContain('这句材料暂缓使用');expect(html).toContain('撤回这条反馈');expect(html).toContain('这句与我的原意不符。');
  expect(html).not.toContain('打开整题学习');expect(html).not.toContain('SPEECH');
});
it('fully studied questions still open the full context and expose original-audio history',()=>{
  const question={id:'q1',favorite:false,part:1,textEn:'How do you live?',textZh:'你怎样生活？',topicEn:'Daily life',topicZh:'日常',stateLabel:'已有材料',answerCount:1,primaryAction:{label:'旧学习',href:'/light-study?scope=question&id=q1'},sources:[],publicChunks:[]} as unknown as QuestionDetail;
  const html=renderToStaticMarkup(createElement(QuestionDetailView,{question,learningPack:null,initialSentenceInfo:overview}));
  expect(html).toContain('打开整题学习');expect(html).toContain('/sentence-study?scope=question&amp;id=q1&amp;mode=learn');
  expect(html).toContain('/answer-history/q1');expect(html).not.toContain('1 / 1 句已学');
});
it('answer results wait for the reviewed sentence edition instead of showing a stale natural-version field',()=>{
  const attempt={id:'a1',questionId:'q1',status:'completed',materialId:'m1',answerText:'original',intendedMeaningZh:'原意',naturalVersion:'STALE NATURAL TEXT',analysis:{corrections:[],learningMaterials:[],gaps:[]}} as unknown as AttemptView;
  const html=renderToStaticMarkup(createElement(SpeakingAttemptResult,{attempt}));
  expect(html).toContain('把这道题连起来说');expect(html).toContain('/answer-history/q1');expect(html).toContain('正在读取已审核的自然回答');
  expect(html).not.toContain('STALE NATURAL TEXT');expect(html).not.toContain('开始四步强化');
});
