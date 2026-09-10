import {createBrowserSpeechProvider,getStoredVoicePreference,getTTS} from "@/lib/tts";
import {LightAudioPlayer} from "./audio";
import {LightStudyError} from "./contracts";
import type {LightStudyClient} from "./client";
import {scopeQuery} from './scope-links';
async function request(url:string,body?:unknown){
  const response=await fetch(url,body===undefined?{cache:"no-store"}:{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
  const data=await response.json();
  if(!response.ok)throw new LightStudyError(data.error??"学习记录暂时无法保存，请重试",response.status,data.code??"request_failed");
  return data;
}
export const webLightClient:LightStudyClient={
  overview:async scope=>(await request(`/api/light-study/overview?${scopeQuery(scope)}`)).overview,
  get:async id=>(await request(`/api/light-study/sessions/${encodeURIComponent(id)}`)).session,
  create:async input=>(await request("/api/light-study/sessions",input)).session,
  event:async(id,event)=>(await request(`/api/light-study/sessions/${encodeURIComponent(id)}/events`,event)).session,
  autoPlay:async()=>{const result=await fetch("/api/settings",{cache:"no-store"}).then(r=>r.ok?r.json():null).catch(()=>null);return result?.settings?.autoPlay??true;},
  setAutoPlay:async value=>{const response=await fetch('/api/settings',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({autoPlay:value})});if(!response.ok)throw new Error('播放偏好未保存，请重试');},
  audio:update=>new LightAudioPlayer(createBrowserSpeechProvider(),update),
  voice:getStoredVoicePreference,setVoice:id=>getTTS().setVoice(id),
  rememberSession:id=>{const url=new URL(window.location.href);url.searchParams.set("session",id);window.history.replaceState(null,"",url);},
};
