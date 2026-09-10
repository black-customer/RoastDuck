import { afterEach, expect, it, vi } from 'vitest';
import { getTTS,pickSpeechVoice,createBrowserSpeechProvider } from '@/lib/tts';
import type { LightAudioState } from '@/lib/light-study/audio';

afterEach(()=>{getTTS().stop();vi.unstubAllGlobals();});
it('shared TTS forwards style and uses downloaded audio on replay; an old button cannot stop its new owner',async()=>{
  const audio:Array<{pause:ReturnType<typeof vi.fn>;src:string}>=[];
  vi.stubGlobal('window',{});
  vi.stubGlobal('Audio',class {
    pause=vi.fn();play=vi.fn(async()=>undefined);onended=null;onerror=null;
    constructor(public src:string){audio.push(this);}
  });
  const fetcher=vi.fn(async(url:string|URL|Request,init?:RequestInit)=>{
    if(String(url)==='/api/speech/synthesis'){
      const input=JSON.parse(String(init?.body));
      return new Response(JSON.stringify({audio:{voice:input.voice,audioUrl:'/api/speech/assets/audio_mock'}}));
    }
    const bytes=new Uint8Array(64);bytes.set([82,73,70,70],0);bytes.set([87,65,86,69],8);
    return new Response(bytes,{headers:{'content-type':'audio/wav'}});
  });
  vi.stubGlobal('fetch',fetcher);
  const tts=getTTS(),states:LightAudioState[]=[];
  const options={style:'ielts-answer' as const,onState:(state:LightAudioState)=>states.push(state)};
  tts.speak("Well, I mean, that's what I think.",{...options,ownerId:'old-button'});
  await vi.waitFor(()=>expect(states.at(-1)).toMatchObject({phase:'playing',provider:'mimo',voice:'Milo'}));
  expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toMatchObject({text:"Well, I mean, that's what I think.",voice:'Milo',accent:'en-US',rate:1,style:'ielts-answer'});
  tts.speak("Well, I mean, that's what I think.",{...options,ownerId:'new-button'});
  await vi.waitFor(()=>expect(audio).toHaveLength(2));
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(audio[1].src).toMatch(/^blob:/);
  tts.stop('old-button');expect(audio[1].pause).not.toHaveBeenCalled();
  tts.stop('new-button');expect(audio[1].pause).toHaveBeenCalledOnce();
});

it('快捷语音只选择本机英语声音并报告实际名称，不能把女声名字误认为male',()=>{
  const voice=(name:string,lang:string,localService:boolean)=>({name,lang,localService}) as SpeechSynthesisVoice;
  const online=voice('Microsoft Guy Online (Natural)','en-US',false),female=voice('Female English','en-US',true),male=voice('Microsoft David','en-US',true);
  expect(pickSpeechVoice([online,female,male],'us-male',true)).toBe(male);
  expect(pickSpeechVoice([online],'us-male',true)).toBeNull();
  expect(pickSpeechVoice([voice('Chinese','zh-CN',true)],'us-male',true)).toBeNull();
  const speak=vi.fn();
  vi.stubGlobal('window',{speechSynthesis:{getVoices:()=>[online,male],speak,cancel:vi.fn()}});
  vi.stubGlobal('SpeechSynthesisUtterance',class {constructor(public text:string){} });
  const provider=createBrowserSpeechProvider(),state=vi.fn();
  provider.speak('I can say it.',{localOnly:true,voiceId:'us-male',onState:state});
  expect(speak.mock.calls[0][0].voice).toBe(male);
  expect(state).toHaveBeenCalledWith(expect.objectContaining({provider:'browser',voice:'Microsoft David',message:'本机声音 · Microsoft David'}));
  provider.stop();
});
