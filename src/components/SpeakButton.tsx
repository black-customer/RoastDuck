"use client";

import { getTTS } from "@/lib/tts";
import {useEffect,useRef,useState,useId} from 'react';
import type {LightAudioState} from '@/lib/light-study/audio';
import type {SpeechStyle} from '@/lib/speech/contracts';

export function SpeakButton({
  text,
  size = "md",
  rate = 0.95,
  lang,
  style,
  label = "播放示范",
}: {
  text: string;
  size?: "md" | "lg";
  rate?: number;
  lang?: string;
  style?: SpeechStyle;
  label?: string;
}) {
  const [state,setState]=useState<LightAudioState|null>(null),active=useRef(true);
  const ownerId=useId();
  useEffect(()=>{active.current=true;return()=>{active.current=false;getTTS().stop(ownerId);};},[ownerId,text]);
  const play=(retryUnknown=false)=>getTTS().speak(text,{rate,lang,style,ownerId,retryUnknown,onState:state=>{if(active.current)setState(state);}});
  const cls = size === "lg"
    ? "inline-flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-[var(--primary)] text-white shadow-[0_10px_24px_rgba(48,83,203,.24)] transition hover:bg-[var(--primary-strong)] active:scale-[.97]"
    : "inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--primary-soft)] text-[var(--primary-strong)] transition hover:bg-[var(--primary-soft-strong)] active:scale-[.97]";
  return (
    <span className="speech-control"><button type="button" aria-label={label} title={label} className={cls} disabled={!text.trim()} onClick={() => play()}>
      <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" className={size === "lg" ? "h-6 w-6" : "h-5 w-5"}>
        <path d="M5 9.5v5h3.1l4.4 3.5V6L8.1 9.5H5Z" fill="currentColor" />
        <path d="M15.5 9a4.2 4.2 0 0 1 0 6M18 6.8a7.3 7.3 0 0 1 0 10.4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    </button>{state?.message&&<span className="speech-control-status" role="status">{state.message}</span>}{['result_unknown','invalid_audio'].includes(state?.errorCode??'')&&<button type="button" onClick={()=>{if(window.confirm('重新合成这一条声音可能再次使用 MiMo 余额。确认继续？'))play(true);}}>重新生成此声音</button>}</span>
  );
}
