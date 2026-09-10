'use client';

import {useEffect,useId,useState} from 'react';
import {DEFAULT_SPEECH_PREFERENCES,getSpeechPreferences,setSpeechPreferences,subscribeSpeechPreferences,type SpeechPreferences as Preferences} from '@/lib/speech/preferences';
import {PLAYBACK_RATES,type MimoVoice,type PlaybackRate,type SpeechAccent} from '@/lib/speech/contracts';
import styles from './SpeechPreferences.module.css';

const VOICES:Array<{id:MimoVoice;label:string}>=[{id:'Milo',label:'Milo · 年轻男声'},{id:'Dean',label:'Dean · 沉稳男声'},{id:'Chloe',label:'Chloe · 亲和女声'},{id:'Mia',label:'Mia · 清亮女声'}];

/** Reusable controls share preferences and update active media speed without a TTS request. */
export function SpeechPreferences({compact=false,onChange}:{compact?:boolean;onChange?:(preferences:Preferences)=>void}) {
  const id=useId(),[preferences,setPreferences]=useState<Preferences>(DEFAULT_SPEECH_PREFERENCES),[saveFailed,setSaveFailed]=useState(false);
  useEffect(()=>{setPreferences(getSpeechPreferences());return subscribeSpeechPreferences(setPreferences);},[]);
  function change(patch:Partial<Omit<Preferences,'version'>>){
    const next={...preferences,...patch};setPreferences(next);setSaveFailed(!setSpeechPreferences(patch));onChange?.(next);
  }
  return <div className={`${styles.preferences} ${compact?styles.compact:''}`}>
    <div className={styles.controls}>
      <label htmlFor={`${id}-voice`}>声音<select id={`${id}-voice`} value={preferences.voice} onChange={event=>change({voice:event.target.value as MimoVoice})}>{VOICES.map(voice=><option key={voice.id} value={voice.id}>{voice.label}</option>)}</select></label>
      <label htmlFor={`${id}-accent`}>口音<select id={`${id}-accent`} value={preferences.accent} onChange={event=>change({accent:event.target.value as SpeechAccent})}><option value="en-US">美式英语</option><option value="en-GB">英式英语</option></select></label>
      <label htmlFor={`${id}-speed`}>播放速度<select id={`${id}-speed`} value={preferences.playbackRate} onChange={event=>change({playbackRate:Number(event.target.value) as PlaybackRate})}>{PLAYBACK_RATES.map(rate=><option key={rate} value={rate}>{rate}×{rate===1?' · 原速':''}</option>)}</select></label>
    </div>
    {!compact&&<p className={styles.hint}>倍速立即调整自然音频，不重新生成；快捷系统声音可能在下一句话生效。</p>}
    {saveFailed&&<p role="status" className={styles.hint}>浏览器未能保存设置，此次选择仍可使用。请允许本机存储后重新选择。</p>}
  </div>;
}
