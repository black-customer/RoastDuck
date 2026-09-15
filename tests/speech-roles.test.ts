import {afterEach,expect,it,vi} from 'vitest';
import {portableTestDatabase} from './helpers/portable-db';
import {createSpeechPreferenceService} from '@/lib/speech/preferences-service';
import {getSpeechPreferences,setSpeechPreferences,SPEECH_PREFERENCES_KEY} from '@/lib/speech/preferences';
import {beginRecording,recordingActive} from '@/lib/speech/recording-coordinator';
afterEach(()=>vi.unstubAllGlobals());
it('preserves the learning choice while teacher defaults to Chloe; speed is shared',()=>{
  const data=new Map([[SPEECH_PREFERENCES_KEY,JSON.stringify({version:3,voice:'Dean',accent:'en-GB',playbackRate:1.1})]]);
  vi.stubGlobal('window',{localStorage:{getItem:(k:string)=>data.get(k)??null,setItem:(k:string,v:string)=>data.set(k,v)},dispatchEvent:()=>true});
  expect(getSpeechPreferences()).toMatchObject({voice:'Dean',accent:'en-GB'});expect(getSpeechPreferences('teacher')).toMatchObject({voice:'Chloe',accent:'en-US',playbackRate:1.1});
  setSpeechPreferences({voice:'Mia',playbackRate:1.2},'teacher');expect(getSpeechPreferences()).toMatchObject({voice:'Dean',playbackRate:1.2});
  expect(getSpeechPreferences('teacher').voice).toBe('Mia');
});
it('persists both roles without accepting credential fields',async()=>{
  const f=portableTestDatabase();try{const service=createSpeechPreferenceService(f.database);expect(await service.get()).toBeNull();
    const prefs={version:4,learning:{voice:'Milo',accent:'en-US'},teacher:{voice:'Chloe',accent:'en-US'},playbackRate:1};
    await service.save(prefs);expect(await service.get()).toEqual(prefs);await expect(service.save({...prefs,apiKey:'forbidden'})).rejects.toThrow();
  }finally{f.close();}
});
it('recording ownership survives one recorder ending and releases idempotently',()=>{
  const first=beginRecording(),second=beginRecording();expect(recordingActive()).toBe(true);first();first();expect(recordingActive()).toBe(true);second();expect(recordingActive()).toBe(false);
});
