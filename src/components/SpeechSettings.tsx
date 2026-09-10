'use client';
import {useEffect,useState,useId} from 'react';
import type {LightAudioState} from '@/lib/light-study/audio';
import {getTTS} from '@/lib/tts';
import {getSpeechPreferences} from '@/lib/speech/preferences';
import {SpeechPreferences} from './SpeechPreferences';
type Health={configured:boolean;status:string;displayName?:string;lastResult?:{status:string;error_code:string|null}|null};
export function SpeechSettings(){
  const ownerId=useId(),[audio,setAudio]=useState<LightAudioState|null>(null);
  const [speech,setSpeech]=useState<Health|null>(null),[text,setText]=useState<Health|null>(null),[provider,setProvider]=useState<'mimo'|'deepseek'|null>(null),[secret,setSecret]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
  async function load(){const [s,t]=await Promise.all([fetch('/api/speech/health').then(r=>r.json()),fetch('/api/ai/health').then(r=>r.json())]);setSpeech(s);setText(t);}
  useEffect(()=>{void load().catch(()=>setMessage('暂时无法读取服务状态，请重试'));return()=>getTTS().stop(ownerId);},[ownerId]);
  const sample=(retryUnknown=false)=>getTTS().speak("I'd like to reschedule my test.",{voice:getSpeechPreferences().voice,lang:getSpeechPreferences().accent,ownerId,retryUnknown,onState:setAudio,onEnd:()=>void load().catch(()=>undefined),onError:()=>setMessage('声音暂不可用，可以继续文字学习')});
  async function save(){if(!provider||busy)return;setBusy(true);setMessage('');try{const result=await fetch('/api/settings/credentials',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider,key:secret.trim()})});const body=await result.json();if(!result.ok)throw new Error(body.error);setSecret('');setProvider(null);await load();setMessage('已保存在本机服务端。配置存在不等于已验证服务可用，可以主动试听。');}catch(error){setMessage(error instanceof Error?error.message:'配置未保存');}finally{setBusy(false);}}
  const status=(health:Health|null)=>!health?'读取状态中…':!health.configured?'未配置：将使用备用声音或提示配置':health.lastResult?.status==='completed'?'最近一次服务请求成功':'已配置，尚需实际验证';
  return <section className="settings-section"><div className="settings-section-copy"><h2>声音与 AI 服务</h2><p>默认年轻美式男声。自然跟练优先MiMo，快捷试听可使用系统声音；始终显示实际音源。</p></div><div className="settings-field"><strong>MiMo 示范声音</strong><p>{status(speech)}</p><button type="button" className="secondary-button" onClick={()=>{setProvider('mimo');setSecret('');}}>配置自己的 MiMo Key</button></div><div className="settings-field"><strong>{text?.displayName??'DeepSeek V4.1 Flash'} 表达分析</strong><p>{text?.configured?'已配置（不代表本次连接一定成功）':'未配置；已有材料仍可学习'}</p><button type="button" className="secondary-button" onClick={()=>{setProvider('deepseek');setSecret('');}}>配置自己的 DeepSeek Key</button></div>
    {provider&&<div className="settings-field"><label htmlFor="new-runtime-key">{provider==='mimo'?'MiMo':'DeepSeek'} 新 Key</label><input id="new-runtime-key" type="password" autoComplete="new-password" spellCheck={false} value={secret} onChange={e=>setSecret(e.target.value)}/><p>请使用已轮换的新 Key。只保存在这台电脑的服务端，不回显、不放入浏览器持久存储。</p><div className="row-actions"><button type="button" className="primary-button" disabled={busy||!secret.trim()} onClick={()=>void save()}>保存到本机</button><button type="button" disabled={busy} onClick={()=>{setSecret('');setProvider(null);}}>取消</button></div></div>}
    <SpeechPreferences/>
    <div className="row-actions"><button type="button" className="secondary-button" onClick={()=>sample()}>试听一句</button><button type="button" onClick={()=>getTTS().stop(ownerId)}>停止</button><button type="button" onClick={()=>void load().catch(()=>setMessage('状态读取失败，请重试'))}>刷新状态</button></div>
    {audio?.message&&<p role="status">{audio.message}</p>}
    {['result_unknown','invalid_audio'].includes(audio?.errorCode??'')&&<button type="button" className="secondary-button" onClick={()=>{if(window.confirm('重新合成这条试听可能再次使用 MiMo 余额，继续？'))sample(true);}}>明确重新合成试听</button>}
    <p className="quiet">主动试听未缓存的句子可能使用你的 MiMo 余额；不自动生成全套音频。</p>{message&&<p role="status">{message}</p>}</section>;
}
