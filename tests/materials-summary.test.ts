import React,{createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {afterAll,describe,expect,it,vi} from 'vitest';
import {speakingAttemptAnalysisSchema,type SpeakingAttemptAnalysis} from '@/lib/speaking-practice/schemas';

vi.stubGlobal('React',React);
vi.mock('@/components/ExpressionLibrary',()=>({ExpressionLibrary:()=>null}));
vi.mock('@/components/NaturalVersionPlayer',()=>({NaturalVersionPlayer:()=>null}));
vi.mock('@/components/SpeakButton',()=>({SpeakButton:({style}:{style:string})=>createElement('button',{'data-speech-style':style})}));

import {MaterialsSummary} from '@/components/MaterialsSummary';

function render(analysis:SpeakingAttemptAnalysis,questionId?:string){
  return renderToStaticMarkup(createElement(MaterialsSummary,{analysis,materialId:'material/1',questionId,sourceId:'source-1',originalEnglish:'我喜欢 music。',originalChinese:'',onStrengthen:()=>{}}));
}
function fixture(){
  return speakingAttemptAnalysisSchema.parse({
    gapCount:0,learningTargetCount:1,naturalVersion:'I enjoy live music.',
    learningMaterials:[{learningBasis:'preparation',chineseChunk:'现场音乐',englishChunk:'live music',yourChineseSentence:'我喜欢现场音乐。',naturalEnglishSentence:'I enjoy live music.'}],
    needsAttention:[{intentZh:'我说的那个地方',reasonZh:'暂不确定指的是哪一个地点。'}],
  });
}

describe('material summary preserves learning evidence semantics',()=>{
  afterAll(()=>vi.unstubAllGlobals());

  it('keeps prepared cards learnable when confirmed problem count is zero',()=>{
    const html=render(fixture(),'question-1');
    expect(html).toContain('1 个可学习的表达');
    expect(html).toContain('准备表达 1 项，修复表达 0 项');
    expect(html).toContain('不计作已犯错误');
    expect(html).toContain('/light-study?scope=material&amp;id=material%2F1');
    expect(html).toContain('/quick-review?scope=material&amp;id=material%2F1');
    expect(html).toContain('可选：四步强化');
    expect(html).toContain('我说的那个地方');
    expect(html).toContain('暂不确定指的是哪一个地点。');
    expect(html).toContain('中文、英文或混合');
    expect(html).toContain('<p>我喜欢 music。</p>');
    expect(html).not.toContain('仅依据本次英文分析');
    expect(html).toContain('data-speech-style="ielts-answer"');
  });

  it('does not infer errors from unclassified rows or historical gapCount',()=>{
    const analysis=fixture();
    analysis.learningMaterials[0].learningBasis=undefined;
    analysis.gapCount=1;
    const html=render(analysis,undefined);
    expect(html).toContain('准备表达 0 项，修复表达 0 项');
    expect(html).toContain('1 项未标注准备或修复类型');
    expect(html).toContain('data-speech-style="daily-conversation"');
  });

  it('shows unresolved meaning without offering an empty learning session',()=>{
    const analysis=fixture();
    analysis.learningMaterials=[];
    analysis.learningTargetCount=0;
    const html=render(analysis,'question-1');
    expect(html).toContain('有 1 处意思待确认');
    expect(html).toContain('这些部分暂未制卡，可以先补充或澄清原意');
    expect(html).not.toContain('/light-study?scope=material');
    expect(html).not.toContain('/quick-review?scope=material');
    expect(html).toContain('不看提示，重新回答');
  });
});
