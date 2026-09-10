'use client';
import {useRef,useState,type ReactNode} from 'react';
import {useRouter} from 'next/navigation';
import type {SentenceScope,SentenceMode,SentenceCreate,SentenceSession} from '@/lib/sentence-study/contracts';
import {sentenceClient} from '@/lib/sentence-study/client';

export function sentenceScopeQuery(scope:SentenceScope){
  const query=new URLSearchParams({scope:scope.type});
  if('id' in scope)query.set('id',scope.id);
  if(scope.type==='collection')for(const key of ['questionId','topicId','seasonId'] as const)if(scope[key])query.set(key,scope[key]!);
  return query.toString();
}
export function StartSentenceButton({scope,mode,resumeSessionId,selection='scope',label,children,className}:{scope:SentenceScope;mode:SentenceMode;resumeSessionId?:string;selection?:SentenceCreate['selection'];label:string;children?:ReactNode;className?:string}){
  const router=useRouter(),lock=useRef(false),request=useRef<SentenceCreate|null>(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  async function start(){
    if(lock.current)return;lock.current=true;setBusy(true);setError('');
    if(resumeSessionId){router.push(`/sentence-study?session=${encodeURIComponent(resumeSessionId)}&resume=1`);return;}
    const key=`roastduck_sentence_start:${mode}:${sentenceScopeQuery(scope)}:${selection}`;
    try{
      if(!request.current){
        try{const raw=sessionStorage.getItem(key);if(raw){const previous=JSON.parse(raw) as SentenceCreate;if(previous.mode===mode&&JSON.stringify(previous.scope)===JSON.stringify(scope)&&previous.selection===selection&&previous.clientRequestId)request.current=previous;}}catch{/* Server request IDs also preserve response-loss retries. */}
        request.current??={scope,mode,selection,clientRequestId:crypto.randomUUID()};
      }
      try{sessionStorage.setItem(key,JSON.stringify(request.current));}catch{/* Stable in-memory receipt survives this retry. */}
      const value:SentenceSession=await sentenceClient.create(request.current);
      if(value.status==='completed'){request.current=null;try{sessionStorage.removeItem(key);}catch{}throw new Error('这次学习已结束，请重新选择下一道题。');}
      try{sessionStorage.removeItem(key);}catch{/* Confirmed server result is enough to proceed. */}
      router.push(`/sentence-study?session=${encodeURIComponent(value.id)}`);
    }catch(reason){setError(reason instanceof Error?reason.message:'暂时无法开始，请重试。');setBusy(false);lock.current=false;}
  }
  return <div><button type="button" className={className??'primary-button'} disabled={busy} aria-busy={busy} aria-label={label} onClick={()=>void start()}>{busy?<span role="status">正在打开…</span>:children??label}</button>{error&&<p className="sentence-entry-error" role="alert">{error}<button type="button" onClick={()=>void start()}>重试</button></p>}</div>;
}
