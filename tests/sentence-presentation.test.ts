import {expect,it} from 'vitest';
import {safeMaterialPresentation} from '@/lib/sentence-study/presentation';
import type {SentenceCard} from '@/lib/sentence-study/contracts';
const card=(index:number,unavailable?:string):SentenceCard=>({id:`s${index}`,version:'v',sentenceId:`s${index}`,materialId:'m',ordinal:index,english:`Safe synthetic sentence ${index}.`,chinese:`合成原意${index}。`,meaningOrigin:'user_chinese',contextZh:'',usages:[],notes:[],progressVersion:0,source:{type:'ielts_practice',id:'a',questionId:'q',title:'Test',href:'/questions/q'},unavailable});
it('does not publish a quarantined sentence as a complete correct answer or audio example',()=>{
  const result=safeMaterialPresentation([card(0),card(1,'内容有误'),card(2)]);
  expect(result.sentences.map(s=>s.id)).toEqual(['s0','s2']);
  expect(result.referenceText).not.toContain('sentence 1');
  expect(result.needsAttention).toEqual([{intentZh:'第 2 句',reasonZh:'内容有误'}]);
});
it('hidden practice targets retain safe context; pending source uncertainty is not discarded',()=>{
  const result=safeMaterialPresentation([{...card(0),preference:{hidden:true,favorite:false,selfKnown:false,note:'',version:1}},card(1)],[{chinese:'未明确的意思',reason:'需补充'}]);
  expect(result.sentences).toHaveLength(2);expect(result.needsAttention).toHaveLength(1);
});
