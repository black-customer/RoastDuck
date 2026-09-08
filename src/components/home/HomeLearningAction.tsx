"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createLightSchema } from "@/lib/light-study/contracts";
import type { HomeLightAction } from "@/lib/home/light-action";
import { Icon } from "@/components/ui/Icon";
import styles from "./HomeDashboard.module.css";

const storageKey="roastduck_home_light_start";
export function HomeLearningAction({action}:{action:HomeLightAction}) {
  const router=useRouter(),locked=useRef(false);
  const pending=useRef<ReturnType<typeof createLightSchema.parse>|null>(null);
  const [error,setError]=useState("");
  const [busy,setBusy]=useState(false);
  useEffect(()=>{
    try{
      const raw=sessionStorage.getItem(storageKey);
      if(raw){const result=createLightSchema.safeParse(JSON.parse(raw));if(result.success){pending.current=result.data;setError("刚才的启动尚未确认，可以继续恢复。");}}
    }catch{/* Session state remains recoverable through the server's active scope. */}
  },[]);
  async function start(){
    if(locked.current||(!pending.current&&action.kind==="question"))return;
    locked.current=true;setBusy(true);setError("");
    const input=pending.current??(action.kind!=="question"?{scope:action.scope,mode:action.mode,clientRequestId:crypto.randomUUID()}:null);
    if(!input){locked.current=false;setBusy(false);return;}
    pending.current=input;
    const raw=JSON.stringify(input);
    try{sessionStorage.setItem(storageKey,raw);}catch{/* In-memory retry keeps the same request ID. */}
    try{
      const response=await fetch("/api/light-study/sessions",{method:"POST",headers:{"content-type":"application/json"},body:raw});
      const result=await response.json();
      if(!response.ok||typeof result.session?.id!=="string")throw new Error(result.error??"暂时无法开始，原记录仍保留。");
      try{if(sessionStorage.getItem(storageKey)===raw)sessionStorage.removeItem(storageKey);}catch{/* No business data is stored here. */}
      pending.current=null;
      const params=new URLSearchParams({session:result.session.id,scope:input.scope.type});
      if(input.scope.type!=="all")params.set("id",input.scope.id);
      router.push(`/light-study?${params}`);
    }catch(reason){setError(reason instanceof Error?reason.message:"启动暂未确认，请重试。");}
    finally{locked.current=false;setBusy(false);}
  }
  return <div className={styles.focusActions}>
    {action.kind==="question"&&!pending.current?<Link className={styles.primaryButton} href="/questions">{action.label}<Icon name="arrow" /></Link>:
      <button className={styles.primaryButton} disabled={busy} onClick={()=>void start()}>{busy?"正在准备…":error?"恢复刚才的启动":action.label}<Icon name="arrow" /></button>}
    <Link href="/light-study" className={styles.textLink}>选择学习范围</Link>
    {error&&<p role="alert" className={styles.randomError}>{error}</p>}
  </div>;
}
