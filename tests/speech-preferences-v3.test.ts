import {afterEach,expect,it,vi} from 'vitest';
import {getSpeechPreferences,resolveSpeechSelection,setSpeechPreferences,SPEECH_PREFERENCES_KEY,subscribeSpeechPreferences} from '@/lib/speech/preferences';
import {LightAudioPlayer} from '@/lib/light-study/audio';
import type {TTSProvider} from '@/lib/tts';

const disposers:Array<()=>void>=[];
afterEach(()=>{disposers.splice(0).forEach(dispose=>dispose());vi.unstubAllGlobals();vi.restoreAllMocks();});
function browser(seed:Record<string,string>={}) {
  const values=new Map(Object.entries(seed)),events=new EventTarget();
  const localStorage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);}};
  vi.stubGlobal('window',{localStorage,addEventListener:events.addEventListener.bind(events),removeEventListener:events.removeEventListener.bind(events),dispatchEvent:events.dispatchEvent.bind(events)});
  return {values,localStorage};
}
function wave(){const bytes=new Uint8Array(64);bytes.set([82,73,70,70]);bytes.set([87,65,86,69],8);return new Response(bytes);}

it('young male default is American; legacy accent and female choices remain, Dean is independently selectable',()=>{
  const {values}=browser();expect(getSpeechPreferences()).toMatchObject({voice:'Milo',accent:'en-US',playbackRate:1});
  values.set('roastduck_active_voice','uk-female');expect(getSpeechPreferences()).toMatchObject({voice:'Mia',accent:'en-GB'});
  values.set(SPEECH_PREFERENCES_KEY,'broken');expect(getSpeechPreferences()).toMatchObject({voice:'Mia',accent:'en-GB'});values.delete(SPEECH_PREFERENCES_KEY);
  values.set('roastduck_active_voice','uk-male');expect(getSpeechPreferences()).toMatchObject({voice:'Milo',accent:'en-GB'});
  setSpeechPreferences({voice:'Milo',accent:'en-US'});expect(JSON.parse(values.get(SPEECH_PREFERENCES_KEY)!)).toMatchObject({voice:'Milo',accent:'en-US'});
  setSpeechPreferences({voice:'Dean'});expect(getSpeechPreferences()).toMatchObject({voice:'Dean',accent:'en-US'});
  expect(resolveSpeechSelection({voiceId:'us-male',accent:'en-GB'})).toEqual({voice:'Dean',accent:'en-GB'});
});

it('preference updates are observable and unsubscribe; blocked storage still works for this session',()=>{
  const {localStorage}=browser(),listener=vi.fn(),unsubscribe=subscribeSpeechPreferences(listener);
  disposers.push(unsubscribe);setSpeechPreferences({playbackRate:1.1});expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({playbackRate:1.1}));
  unsubscribe();setSpeechPreferences({accent:'en-GB'});expect(listener).toHaveBeenCalledTimes(1);
  vi.spyOn(localStorage,'setItem').mockImplementation(()=>{throw new Error('quota');});
  expect(setSpeechPreferences({voice:'Dean',playbackRate:1.2})).toBe(false);
  expect(getSpeechPreferences()).toMatchObject({voice:'Dean',accent:'en-GB',playbackRate:1.2});
});

it('playback speed immediately changes a live media element while preserving pitch, without another synthesis',async()=>{
  browser();const audio={play:vi.fn(async()=>undefined),pause:vi.fn(),onended:null,onerror:null,playbackRate:0,preservesPitch:false};
  const fetcher=vi.fn(async(url:string|URL|Request,init?:RequestInit)=>String(url).includes('synthesis')?new Response(JSON.stringify({audio:{voice:JSON.parse(String(init?.body)).voice,accent:JSON.parse(String(init?.body)).accent,audioUrl:'/api/speech/assets/audio_test'}})):wave());
  const fallback:TTSProvider={name:'browser',getVoice:()=> 'us-male',setVoice:vi.fn(),stop:vi.fn(),speak:vi.fn()};
  const player=new LightAudioPlayer(fallback,()=>{},fetcher,()=>audio as unknown as HTMLAudioElement);disposers.push(()=>player.dispose());
  const input={text:'Actually, that works for me.',voiceId:'us-male' as const,playbackMode:'natural' as const};
  await player.play(input);expect(audio.playbackRate).toBe(1);expect(audio.preservesPitch).toBe(true);
  expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toMatchObject({voice:'Milo',accent:'en-US',rate:1});
  setSpeechPreferences({playbackRate:1.2});expect(audio.playbackRate).toBe(1.2);expect(fetcher).toHaveBeenCalledTimes(2);
  player.stop();await player.play(input);expect(audio.playbackRate).toBe(1.2);expect(fetcher).toHaveBeenCalledTimes(2);
  await player.play({...input,rate:.85});expect(audio.playbackRate).toBe(.85);expect(fetcher).toHaveBeenCalledTimes(2);
  player.dispose();setSpeechPreferences({playbackRate:1.1});expect(audio.playbackRate).toBe(.85);
});

it('the same voice with a different source accent has a different cache identity and is not mislabeled',async()=>{
  browser();const states:Array<{provider:unknown;errorCode?:string}>=[];
  const fetcher=vi.fn(async(url:string|URL|Request,init?:RequestInit)=>String(url).includes('synthesis')?new Response(JSON.stringify({audio:{voice:JSON.parse(String(init?.body)).voice,accent:'en-US',audioUrl:'/api/speech/assets/audio_test'}})):wave());
  const fallback:TTSProvider={name:'browser',getVoice:()=> 'us-male',setVoice:vi.fn(),stop:vi.fn(),speak:vi.fn()};
  const player=new LightAudioPlayer(fallback,state=>states.push(state),fetcher,()=>({play:async()=>{},pause:()=>{}} as unknown as HTMLAudioElement));disposers.push(()=>player.dispose());
  const input={text:'Actually, that works for me.',voiceId:'us-male' as const,voice:'Milo' as const,accent:'en-US' as const,playbackMode:'natural' as const};
  await player.play(input);await player.play({...input,accent:'en-GB'});
  expect(fetcher).toHaveBeenCalledTimes(3);expect(states.at(-1)).toMatchObject({provider:null,errorCode:'invalid_audio'});
  expect(fallback.speak).not.toHaveBeenCalled();
});
