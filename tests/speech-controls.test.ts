import React,{createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {afterAll,expect,it,vi} from 'vitest';
import {SpeechPreferences} from '@/components/SpeechPreferences';

vi.stubGlobal('React',React);afterAll(()=>vi.unstubAllGlobals());
it('speaker, accent, and real playback speed are separate labeled native controls without duplicate ids',()=>{
  const html=renderToStaticMarkup(createElement('div',null,createElement(SpeechPreferences),createElement(SpeechPreferences,{compact:true})));
  expect(html).toContain('Milo · 年轻男声');expect(html).toContain('Dean · 沉稳男声');
  expect(html).toContain('value="Milo" selected=""');expect(html).toContain('value="en-US" selected=""');
  expect(html.match(/<select /g)).toHaveLength(6);expect(html.match(/<label /g)).toHaveLength(6);
  const ids=[...html.matchAll(/<select id="([^"]+)"/g)].map(match=>match[1]);expect(new Set(ids).size).toBe(6);
  for(const rate of ['0.85','1','1.1','1.2'])expect(html).toContain(`value="${rate}"`);
  expect(html).not.toContain('麦克风');expect(html).toContain('不重新生成');
});
