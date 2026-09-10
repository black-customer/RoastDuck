import { afterEach, expect, it, vi } from 'vitest';
import { getStoredVoicePreference, setStoredVoicePreference } from '@/lib/tts';

afterEach(()=>vi.unstubAllGlobals());
function storage(initial:Record<string,string>={}){
  const values=new Map(Object.entries(initial));
  vi.stubGlobal('window',{localStorage:{getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>values.set(key,value)}});
  return values;
}

it('the default male preset remains traceable through legacy metadata',()=>{
  expect(getStoredVoicePreference()).toBe('us-male');
  const values=storage();
  expect(getStoredVoicePreference()).toBe('us-male');
  expect(JSON.parse(values.get('roastduck_voice_preference_v2')!)).toMatchObject({version:2,source:'default',voiceId:'us-male',previousDefault:'us-female'});
  expect(values.has('roastduck_active_voice')).toBe(false);
});

it('legacy choices remain intact and an explicit choice is tracked separately from a default',()=>{
  for(const voice of ['us-female','us-male','uk-female','uk-male'] as const){
    const values=storage({roastduck_active_voice:voice});
    expect(getStoredVoicePreference()).toBe(voice);
    expect(JSON.parse(values.get('roastduck_voice_preference_v2')!)).toMatchObject({source:'legacy-preserved',voiceId:voice});
    setStoredVoicePreference('us-female');
    expect(getStoredVoicePreference()).toBe('us-female');
    expect(JSON.parse(values.get('roastduck_voice_preference_v2')!)).toMatchObject({source:'explicit',voiceId:'us-female'});
  }
});

it('blocked preference writes do not discard a readable user choice',()=>{
  vi.stubGlobal('window',{localStorage:{getItem:(key:string)=>key==='roastduck_active_voice'?'uk-male':null,setItem:()=>{throw new Error('blocked');}}});
  expect(getStoredVoicePreference()).toBe('uk-male');
});
