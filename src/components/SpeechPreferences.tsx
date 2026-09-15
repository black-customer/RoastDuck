'use client';

import {useEffect,useId,useState} from 'react';
import {DEFAULT_SPEECH_PREFERENCES,DEFAULT_TEACHER_PREFERENCES,getSpeechPreferences,hydrateSpeechPreferences,setSpeechPreferences,subscribeSpeechPreferences,SPEECH_SYNC_EVENT,type SpeechPreferences as Preferences} from '@/lib/speech/preferences';
import {PLAYBACK_RATES,type MimoVoice,type PlaybackRate,type SpeechAccent,type SpeechRole} from '@/lib/speech/contracts';
import styles from './SpeechPreferences.module.css';

const VOICES:Array<{id:MimoVoice;label:string}>=[{id:'Milo',label:'Milo · 年轻男声'},{id:'Dean',label:'Dean · 沉稳男声'},{id:'Chloe',label:'Chloe · 亲和女声'},{id:'Mia',label:'Mia · 清亮女声'}];

/** Reusable controls share preferences and update active media speed without a TTS request. */
export function SpeechPreferences({compact=false,onChange,role='learning'}:{compact?:boolean;role?:SpeechRole;onChange?:(preferences:Preferences)=>void}) {
  const id=useId(),[preferences,setPreferences]=useState<Preferences>(role==='teacher'?DEFAULT_TEACHER_PREFERENCES:DEFAULT_SPEECH_PREFERENCES),[saveFailed,setSaveFailed]=useState(false),[serverFailed,setServerFailed]=useState(false);
  useEffect(()=>{setPreferences(getSpeechPreferences(role));const unsubscribe=subscribeSpeechPreferences(setPreferences,role),sync=(event:Event)=>setServerFailed((event as CustomEvent).detail==='error');window.addEventListener(SPEECH_SYNC_EVENT,sync);void hydrateSpeechPreferences();return()=>{unsubscribe();window.removeEventListener(SPEECH_SYNC_EVENT,sync);};},[role]);
  function change(patch:Partial<Omit<Preferences,'version'>>){
    const next={...preferences,...patch};setPreferences(next);setSaveFailed(!setSpeechPreferences(patch,role));onChange?.(next);
  }
  return <div className={`${styles.preferences} ${compact?styles.compact:''}`}>
    <div className={styles.controls}>
      <label htmlFor={`${id}-voice`}>{role==='teacher'?'老师声音':'学习声音'}<select id={`${id}-voice`} value={preferences.voice} onChange={event=>change({voice:event.target.value as MimoVoice})}>{VOICES.map(voice=><option key={voice.id} value={voice.id}>{voice.label}</option>)}</select></label>
      <label htmlFor={`${id}-accent`}>{role==='teacher'?'老师口音':'学习口音'}<select id={`${id}-accent`} value={preferences.accent} onChange={event=>change({accent:event.target.value as SpeechAccent})}><option value="en-US">美式英语</option><option value="en-GB">英式英语</option></select></label>
      <label htmlFor={`${id}-speed`}>播放速度<select id={`${id}-speed`} value={preferences.playbackRate} onChange={event=>change({playbackRate:Number(event.target.value) as PlaybackRate})}>{PLAYBACK_RATES.map(rate=><option key={rate} value={rate}>{rate}×{rate===1?' · 原速':''}</option>)}</select></label>
    </div>
    {!compact&&<p className={styles.hint}>倍速立即调整自然音频，不重新生成；快捷系统声音可能在下一句话生效。</p>}
    {saveFailed&&<p role="status" className={styles.hint}>浏览器未能保存设置，此次选择仍可使用。请允许本机存储后重新选择。</p>}
    {serverFailed&&<p role="status" className={styles.hint}>声音偏好暂未存入本机服务端，当前选择仍可使用。<button type="button" onClick={()=>change({})}>重试保存声音设置</button></p>}
  </div>;
}
