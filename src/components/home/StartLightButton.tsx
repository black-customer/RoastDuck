'use client';
import {useRef,useState,type ReactNode} from 'react';
import {useRouter} from 'next/navigation';
import {createLightSchema,type LightScope,type LightMode} from '@/lib/light-study/contracts';
import {webLightClient} from '@/lib/light-study/web-client';
import {scopeQuery} from '@/lib/light-study/scope-links';
import {reconcileLightPending} from '@/lib/light-study/recovery';

export function StartLightButton({scope,mode,resumeSessionId,label,children,className}:{scope:LightScope;mode:LightMode;resumeSessionId?:string;label:string;children?:ReactNode;className?:string}){
  const router=useRouter(),locked=useRef(false),request=useRef<ReturnType<typeof createLightSchema.parse>|null>(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  async function start(){
    if(locked.current)return;locked.current=true;setBusy(true);setError('');
    const key=`roastduck_light_start:${mode}:${scopeQuery(scope)}:${resumeSessionId??''}`;
    let freshlyResolved=false;
    try{
      if(!request.current){
        try{const saved=createLightSchema.safeParse(JSON.parse(sessionStorage.getItem(key)??'null'));if(saved.success&&scopeQuery(saved.data.scope)===scopeQuery(scope)&&saved.data.mode===mode&&(!resumeSessionId||saved.data.resumeSessionId===resumeSessionId))request.current=saved.data;}catch{/* In-memory retry remains stable. */}
        // Preserve a pre-redesign start receipt, without applying another scope's pending choice.
        try{if(!request.current&&!resumeSessionId){const saved=createLightSchema.safeParse(JSON.parse(sessionStorage.getItem('roastduck_home_light_start')??'null'));if(saved.success&&scopeQuery(saved.data.scope)===scopeQuery(scope)&&saved.data.mode===mode)request.current=saved.data;}}catch{/* Invalid old records never replace an explicitly selected session. */}
        if(!request.current){
          const resume=resumeSessionId??(await webLightClient.overview(scope)).resumable[mode]?.id;
          request.current={scope,mode,clientRequestId:crypto.randomUUID(),...(resume?{resumeSessionId:resume}:{})};
          freshlyResolved=true;
        }
      }
      const input=request.current,raw=JSON.stringify(input);
      try{sessionStorage.setItem(key,raw);}catch{/* Server keeps the request receipt. */}
      const beforeCreate=input.resumeSessionId??(!freshlyResolved?(await webLightClient.overview(input.scope)).resumable[input.mode]?.id:undefined);
      if(beforeCreate)await reconcileLightPending(await webLightClient.get(beforeCreate),webLightClient);
      const result=await webLightClient.create(input);
      try{if(sessionStorage.getItem(key)===raw)sessionStorage.removeItem(key);}catch{/* Save confirmed: cleanup failure is not a business failure. */}
      try{if(JSON.parse(sessionStorage.getItem('roastduck_home_light_start')??'null')?.clientRequestId===input.clientRequestId)sessionStorage.removeItem('roastduck_home_light_start');}catch{/* Receipt is already confirmed. */}
      router.push(`/light-study?${scopeQuery(result.scope)}&mode=${result.mode}&session=${encodeURIComponent(result.id)}`);
    }catch(reason){setError(reason instanceof Error?reason.message:'暂时无法开始，请重试。原记录仍保留。');locked.current=false;setBusy(false);}
  }
  return <div><button className={className??'primary-button'} aria-label={label} disabled={busy} onClick={()=>void start()}>{busy?'正在恢复学习…':children??label}</button>{error&&<p role="alert">{error} <button className="secondary-button" disabled={busy} onClick={()=>void start()}>重试</button></p>}</div>;
}
