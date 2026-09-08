import React,{createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {afterAll,expect,it,vi} from 'vitest';
import type {ExpressionItem} from '@/components/ExpressionLibrary';
import {expressionScope,scopeQuery} from '@/lib/light-study/scope-links';
vi.stubGlobal('React',React);
vi.mock('@/components/SpeakButton',()=>({SpeakButton:()=>createElement('button',null,'PLAY')}));
import {QuickReviewRow} from '@/components/expressions/QuickReview';
import {ExpressionSummary} from '@/components/expressions/ExpressionSummary';
afterAll(()=>vi.unstubAllGlobals());
const item:ExpressionItem={itemId:'item',materialId:'material',materialHash:'hash',rowIndex:0,progressVersion:0,chinese:'习惯独居',english:'be used to living alone',sentenceZh:'我已经习惯一个人住了。',sentenceEn:"I'm used to living alone.",originalEnglish:'original',reasonZh:'reason',sourceTitle:'我的回答',sourceHref:'/questions/q',questionId:'q',preference:{hidden:0,favorite:0,self_known:0,note:'',version:0},progress:null};
it('quick review starts with neither target English nor playback mounted in the document',()=>{
  const html=renderToStaticMarkup(createElement(QuickReviewRow,{item}));
  expect(html).toContain('习惯独居');expect(html).toContain('我已经习惯一个人住了。');
  expect(html).toContain('aria-expanded="false"');expect(html).toContain('揭晓英文');
  expect(html).not.toContain(item.english);expect(html).not.toContain(item.sentenceEn);expect(html).not.toContain('PLAY');
});
it('current progress uses eligible counts while lifetime studied history remains visible',()=>{
  const html=renderToStaticMarkup(createElement(ExpressionSummary,{scope:{type:'collection',id:'ielts'},summary:{total:8,eligibleTotal:5,studied:6,eligibleStudied:3,selfKnownUnstudied:1,eligibleSelfKnownUnstudied:1,new:1,due:0,hidden:3}}));
  expect(html).toContain('本轮已处理 4 / 5');expect(html).toContain('max="5" value="4"');
  expect(html).toContain('累计学过');expect(html).toContain('<dd>6</dd>');expect(html).toContain('不代表客观掌握');
  expect(html).toContain('/quick-review?scope=collection&amp;id=ielts');
});
it('default collection is IELTS and question/material scopes are preserved in links',()=>{
  expect(expressionScope({}).data).toEqual({type:'collection',id:'ielts'});
  for(const type of ['question','material'] as const){const parsed=expressionScope({scope:type,id:'example/1'});expect(parsed.success).toBe(true);expect(scopeQuery(parsed.data!)).toBe('scope='+type+'&id=example%2F1');}
  expect(expressionScope({scope:'collection',id:'retired_book'}).success).toBe(false);
  const filtered=expressionScope({scope:'collection',id:'ielts',topicId:'topic-a',seasonId:'unmarked'});
  expect(filtered.success).toBe(true);expect(scopeQuery(filtered.data!)).toBe('scope=collection&id=ielts&topicId=topic-a&seasonId=unmarked');
});
