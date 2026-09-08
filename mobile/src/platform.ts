import {registerPlugin} from "@capacitor/core";
import type {AppServices} from "@/lib/app-services";
import type {LightStudyClient} from "@/lib/light-study/client";
import {LightAudioPlayer} from "@/lib/light-study/audio";
import {getStoredVoicePreference,setStoredVoicePreference} from "@/lib/tts";
import {createDeviceSpeech} from "@/lib/platform/android/speech";
import {VOICE_PRESETS} from "@/lib/speech/contracts";
export const credentials=registerPlugin<{
  status():Promise<{deepseek:boolean;mimo:boolean}>;
  configure(input:{provider:"deepseek"|"mimo"}):Promise<{changed:boolean}>;
  clear(input:{provider:"deepseek"|"mimo"}):Promise<{changed:boolean}>;
}>("RoastDuckCredentials");
export function createNativeLightClient(services:AppServices):LightStudyClient{return {
  overview:services.light.lightOverview,get:services.light.getLightView,create:services.light.createLightSession,event:services.light.applyLightEvent,
  autoPlay:async()=>(await services.settings.get()).autoPlay,voice:getStoredVoicePreference,setVoice:setStoredVoicePreference,
  audio:update=>new LightAudioPlayer(createDeviceSpeech(),update,undefined,undefined,async input=>{
    if(!services.speech)return null;const preset=VOICE_PRESETS.find(value=>value.id===input.voiceId)!;
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{return await Promise.race([services.speech.prepare({text:input.text,voice:preset.mimoVoice,accent:preset.accent,purpose:"example",rate:.95}).then(result=>({url:result.url})),new Promise<null>(resolve=>{timer=setTimeout(()=>resolve(null),12000);})]);}
    finally{clearTimeout(timer);}
  }),
  rememberSession:id=>{const url=new URL(window.location.hash.slice(1)||"/light-study","https://localhost");url.searchParams.set("session",id);window.history.replaceState(null,"",`#${url.pathname}${url.search}`);},
};}
