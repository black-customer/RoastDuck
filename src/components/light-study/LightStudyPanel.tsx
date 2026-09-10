"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Icon } from "@/components/ui/Icon";
import { VOICE_PRESETS, type VoicePresetId } from "@/lib/speech/contracts";
import type { LightAudioState } from "@/lib/light-study/audio";
import type { LightStudyClient,LightLink,LightAudioController } from "@/lib/light-study/client";
import { LightStudyError } from "@/lib/light-study/contracts";
import type { LightEvent, LightMode, LightOverview, LightScope, LightView } from "@/lib/light-study/contracts";
import { savePending,clearPending,type PendingOperation } from "@/lib/light-study/pending";
import {PendingSaveError,reconcileLightPending} from '@/lib/light-study/recovery';
import {expressionScopeTitle} from '@/lib/light-study/scope-links';
import styles from "./LightStudy.module.css";

const TIMER_KEY="roastduck_light_auto_reveal";
type Action={type:"reveal"|"advance"|"pause"}|{type:"rate";rating:"remembered"|"uncertain"|"forgot"};

export function LightStudyPanel({scope,initialSessionId,initialError,initialMode,client,Link}:{scope:LightScope;initialSessionId?:string;initialError?:string;initialMode?:LightMode;client:LightStudyClient;Link:LightLink}) {
  const scopeJson=JSON.stringify(scope);
  const stableScope=useMemo(()=>JSON.parse(scopeJson) as LightScope,[scopeJson]);
  const [overview,setOverview]=useState<LightOverview|null>(null);
  const [view,setView]=useState<LightView|null>(null);
  const [mode,setMode]=useState<LightMode>("learn");
  const [loading,setLoading]=useState(true);
  const [readAttempt,setReadAttempt]=useState(0);
  const lastReadAttempt=useRef(0);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState(initialError??"");
  const [autoReveal,setAutoReveal]=useState(false);
  const [seconds,setSeconds]=useState(5);
  const [clockKey,setClockKey]=useState("");
  const [timerPaused,setTimerPaused]=useState(false);
  const [hidden,setHidden]=useState(false);
  const [autoPlay,setAutoPlay]=useState(true);
  const [voice,setVoice]=useState<VoicePresetId>("us-male");
  const [audioState,setAudioState]=useState<LightAudioState>({phase:"idle",provider:null,message:""});
  const player=useRef<LightAudioController|null>(null);
  const active=useRef(true),locked=useRef(false),interacted=useRef(false);
  const pending=useRef<PendingOperation|null>(null);
  const createRequest=useRef<{mode:LightMode;clientRequestId:string;context:string;resumeSessionId?:string}|null>(null);
  const autoAttempt=useRef("");
  const heading=useRef<HTMLHeadingElement|null>(null);
  const sessionRef=useRef<LightView|null>(null);
  const acceptView=useCallback((session:LightView)=>{sessionRef.current=session;setView(session);setMode(session.mode);},[]);
  const currentExperience=useCallback(async(session:LightView)=>session.needsUpgrade?client.create({scope:session.scope,mode:session.mode,resumeSessionId:session.id,clientRequestId:`upgrade:${session.id}`}):session,[client]);

  const loadOverview=useCallback(async()=>{
    const data=await client.overview(stableScope);
    if(active.current)setOverview(data);
    return data;
  },[stableScope,client]);
  useEffect(()=>{
    active.current=true;
    const audio=client.audio(state=>{if(active.current&&player.current===audio)setAudioState(state);});
    player.current=audio;setVoice(client.voice());
    try{setAutoReveal(localStorage.getItem(TIMER_KEY)==="1");}catch{/* 偏好不可存时仅本次生效。 */}
    const visibility=()=>{setHidden(document.hidden);if(document.hidden)audio.stop();};
    document.addEventListener("visibilitychange",visibility);
    return()=>{active.current=false;audio.dispose();document.removeEventListener("visibilitychange",visibility);};
  },[client]);
  useEffect(()=>{
    // Updating our own URL must not reinitialize the in-flight session from browser storage.
    if(locked.current||(initialSessionId&&sessionRef.current?.id===initialSessionId&&lastReadAttempt.current===readAttempt))return;
    lastReadAttempt.current=readAttempt;
    let cancelled=false;
    const initialize=async()=>{
      try {
        setLoading(true);setError(initialError??'');pending.current=null;
        if(!initialSessionId||initialError){sessionRef.current=null;setView(null);}
        if(initialError)return;
        const data=await loadOverview();if(!cancelled)setMode(initialMode??data.defaultMode);
        if(initialSessionId){
          let session=await client.get(initialSessionId);
          if(!cancelled)acceptView(session);
          session=await reconcileLightPending(session,client);
          session=await currentExperience(session);
          if(!cancelled){
            pending.current=null;acceptView(session);
            client.rememberSession(session.id);
          }
        }
        const auto=await client.autoPlay().catch(()=>true);
        if(!cancelled)setAutoPlay(auto);
      }catch(reason){if(!cancelled){if(reason instanceof PendingSaveError)pending.current=reason.operation;setError(reason instanceof Error?reason.message:"读取失败，请重试");}}
      finally{if(!cancelled)setLoading(false);}
    };
    void initialize();return()=>{cancelled=true;};
  },[loadOverview,initialSessionId,initialError,initialMode,client,currentExperience,acceptView,readAttempt]);
  const rememberUrl=client.rememberSession;
  const begin=async(nextMode:LightMode)=>{
    if(locked.current||pending.current)return;locked.current=true;setBusy(true);setError("");interacted.current=true;
    const context=`${view?.id??"start"}:${view?.version??0}:${view?.status??"new"}`;
    try {
      if(createRequest.current?.mode!==nextMode||createRequest.current.context!==context){
        const resumeId=view?.mode===nextMode&&(view.status==='paused'||view.needsUpgrade)?view.id:(await loadOverview()).resumable[nextMode]?.id;
        createRequest.current={mode:nextMode,clientRequestId:crypto.randomUUID(),context,...(resumeId?{resumeSessionId:resumeId}:{})};
      }
      const request=createRequest.current;
      if(request.resumeSessionId)await reconcileLightPending(await client.get(request.resumeSessionId),client);
      let session=await client.create({scope:stableScope,mode:nextMode,clientRequestId:request.clientRequestId,...(request.resumeSessionId?{resumeSessionId:request.resumeSessionId}:{})});
      if(active.current)acceptView(session);
      session=await reconcileLightPending(session,client);
      session=await currentExperience(session);
      if(active.current){
        pending.current=null;acceptView(session);rememberUrl(session.id);
      }
    }catch(reason){if(active.current){if(reason instanceof PendingSaveError)pending.current=reason.operation;setError(reason instanceof Error?reason.message:"开始失败，请重试");}}
    finally{locked.current=false;if(active.current)setBusy(false);}
  };
  const perform=useCallback(async(action:Action,retry=false)=>{
    if(locked.current||!view||(!retry&&pending.current))return;locked.current=true;setBusy(true);setError("");interacted.current=true;
    const operation=retry&&pending.current?pending.current:{id:view.id,event:{...action,version:view.version,clientEventId:crypto.randomUUID()} as LightEvent};
    pending.current=operation;
    const recoveryStored=savePending(operation);
    if(action.type==="reveal")autoAttempt.current=`${view.id}:${view.index}`;
    if(action.type!=="reveal")player.current?.stop();
    try {
      let session:LightView;
      try{session=await client.event(operation.id,operation.event);}
      catch(error){
        if(error instanceof LightStudyError&&error.code==="version_conflict"){
          const restored=await client.get(operation.id);
          clearPending(operation);pending.current=null;
          session=await reconcileLightPending(restored,client);
          if(active.current)acceptView({...session,notice:"另一窗口已更新，已恢复最新位置。"});
          return;
        }
        throw error;
      }
      clearPending(operation);pending.current=null;
      session=await reconcileLightPending(session,client);
      session=await currentExperience(session);
      if(active.current){acceptView(session);rememberUrl(session.id);if(session.status!=="active")void loadOverview().catch(()=>undefined);}
    }catch(reason){if(active.current){if(reason instanceof PendingSaveError)pending.current=reason.operation;setError((reason instanceof Error?reason.message:"记录暂未保存，当前选择已保留，请重试")+(recoveryStored?"":"；浏览器无法保留重试记录，请在刷新前重试。"));}}
    finally{locked.current=false;if(active.current)setBusy(false);}
  },[view,loadOverview,client,currentExperience,rememberUrl,acceptView]);

  const card=view?.card,shown=Boolean(view?.revealed);
  const hasPending=Boolean(pending.current);
  const actionDisabled=busy||hasPending;
  const currentText=card?.english,nextText=view?.nextCard?.english;
  useEffect(()=>{setClockKey(`${view?.id}:${view?.index}`);setSeconds(5);setTimerPaused(false);autoAttempt.current="";heading.current?.focus();},[view?.id,view?.index]);
  useEffect(()=>{
    if(!autoReveal||timerPaused||hidden||busy||hasPending||view?.status!=="active"||shown||!card||clockKey!==`${view.id}:${view.index}`)return;
    const timer=setInterval(()=>setSeconds(n=>Math.max(0,n-1)),1000);
    return()=>clearInterval(timer);
  },[autoReveal,timerPaused,hidden,busy,hasPending,view?.mode,view?.status,view?.id,view?.index,shown,card,clockKey]);
  useEffect(()=>{
    const key=`${view?.id}:${view?.index}`;
    if(seconds===0&&clockKey===key&&autoReveal&&!shown&&view?.status==="active"&&!hidden&&!timerPaused&&!busy&&!hasPending&&card&&autoAttempt.current!==key){
      autoAttempt.current=key;void perform({type:"reveal"});
    }
  },[seconds,clockKey,autoReveal,shown,view?.status,view?.id,view?.index,hidden,timerPaused,busy,hasPending,card,perform]);
  useEffect(()=>{
    const audio=player.current;
    if(!audio)return;
    const current=currentText?{text:currentText,voiceId:voice}:null;
    const next=nextText?{text:nextText,voiceId:voice}:null;
    audio.prime(view?.status==="active"?current:null,view?.status==="active"?next:null,autoPlay&&interacted.current&&!hidden&&!hasPending);
    if(view?.status==="active"&&current&&shown&&autoPlay&&interacted.current&&!hidden&&!hasPending)void audio.play(current);
    else audio.stop();
    return()=>audio.stop();
  },[view?.id,view?.index,view?.status,currentText,nextText,shown,voice,autoPlay,hidden,hasPending]); // 声音状态变化本身不重新触发播放。

  const count=mode==="review"?overview?.dueCount:overview?.newCount;
  const resumable=overview?.resumable[mode];
  const inSession=view?.status==="active";
  const v2=view?.experienceVersion==="light_study_v2";
  const ratingNames={remembered:"脱口而出",uncertain:"想了一会儿",forgot:"没想出来"};
  const sourceQuestion=scope.type==="question"?scope.id:scope.type==='collection'&&scope.id==='ielts'&&scope.questionId?scope.questionId:view?.questionId??null;
  const settings=<details className={styles.settings}><summary>播放与揭晓设置</summary><div className={styles.preferences}>
    <label><input type="checkbox" checked={autoPlay} onChange={e=>{const value=e.target.checked;setAutoPlay(value);void client.setAutoPlay?.(value).catch(reason=>{setAutoPlay(!value);setError(reason.message);});}} />自动播放示范声音</label>
    <label><input type="checkbox" checked={autoReveal} onChange={e=>{setAutoReveal(e.target.checked);setSeconds(5);try{localStorage.setItem(TIMER_KEY,e.target.checked?"1":"0");}catch{/* 本次生效。 */}}} />五秒自动揭晓</label>
    <label>示范声音<select value={voice} onChange={e=>{const id=e.target.value as VoicePresetId;setVoice(id);client.setVoice(id);}}>{VOICE_PRESETS.map(v=><option key={v.id} value={v.id}>{v.label}</option>)}</select></label>
  </div></details>;
  return <div className={`${styles.page} ${inSession?styles.focus:""}`} data-light-focus={inSession?"true":"false"}>
    {!inSession&&<PageHeader title="轻松学" description="先想一下，再听见答案。有空就学几个。" actions={<Link className="secondary-button" href="/">返回首页</Link>} />}
    {loading?<p role="status">正在读取已有材料…</p>:<>
      {inSession?<header className={styles.sessionBar}>
        <button className={styles.textButton} disabled={actionDisabled} onClick={()=>void perform({type:"pause"})}>保存并暂停</button>
        <h1>轻松学</h1>{settings}
      </header>:<div className={styles.toolbar}><span>{expressionScopeTitle(scope)}</span>{settings}</div>}
      {error&&<div className={styles.error} role="alert"><p>{error}</p>{pending.current?<button className="secondary-button" disabled={busy} onClick={()=>void perform(pending.current!.event,true)}>重试保存</button>:<button className="secondary-button" disabled={busy} onClick={()=>initialError?window.location.reload():setReadAttempt(n=>n+1)}>重新读取</button>}</div>}
      {view?.notice&&<p className={styles.notice} role="status">{view.notice}</p>}
      {inSession?<section className={styles.study} aria-label="当前表达">
        <div className={styles.progress}>
          <span>{v2?(view.phase==="consolidation"?"再想一次":view.mode==="learn"?"新表达":"到期复习"):(view.mode==="learn"?"认识一个表达":"回想一个表达")} · {view.phase==="consolidation"?view.index-(view.initialTotal??0)+1:v2?(view.initialIndex??0)+1:view.index+1} / {view.phase==="consolidation"?view.total-(view.initialTotal??0):view.initialTotal??view.total}</span>
          {view.phase==="consolidation"&&<span>组内巩固</span>}
        </div>
        {view.unavailable?<><h2 ref={heading} tabIndex={-1}>这项暂时跳过</h2><p>{view.unavailable}</p><div className={styles.actions}><button className={`primary-button ${styles.mainAction}`} disabled={actionDisabled} onClick={()=>void perform({type:"advance"})}>继续下一项</button></div></>:card?<>
          <div className={styles.cardContent}>
            <h2 ref={heading} tabIndex={-1} className={styles.meaning}>{card.chinese}</h2>
            {v2&&card.sentenceZh&&card.sentenceZh!==card.chinese&&<p className={styles.context}>{card.sentenceZh}</p>}
            {!shown?<div className={styles.prompt}>
              <p>这个意思，用英文怎么说？</p>
              <p className={styles.hint}>在心里想一下。不确定，随时揭晓。</p>
            </div>:<>
              <div className={styles.expression}>
                <p lang="en">{card.english}</p>
                <button type="button" className={styles.soundButton} onClick={()=>{interacted.current=true;void player.current?.play({text:card.english,voiceId:voice});}}><Icon name="audio" />{audioState.phase==="playing"?"重新播放":"播放示范"}</button>
                {audioState.phase==="playing"&&<button className={styles.textButton} onClick={()=>player.current?.stop()}>停止</button>}
              </div>
              {(audioState.message||audioState.provider)&&<p className={styles.audioStatus} role="status">{audioState.message}</p>}
              {['result_unknown','invalid_audio'].includes(audioState.errorCode??'')&&<button className={styles.textButton} onClick={()=>{if(window.confirm('重新合成这一条声音可能再次使用 MiMo 余额。确认继续？'))void player.current?.play({text:card.english,voiceId:voice,retryUnknown:true});}}>重新生成此声音</button>}
              {v2&&card.sentenceEn&&<div className={styles.example}><p lang="en"><ExampleText text={card.sentenceEn} target={card.english} /></p><button className={styles.textButton} onClick={()=>{interacted.current=true;void player.current?.play({text:card.sentenceEn,voiceId:voice});}}>听完整例句</button></div>}
              <details className={styles.detail} key={`${view.id}-${view.index}`}><summary>{v2?"说明与来源":"例句与来源"}</summary>
                {!v2&&<><p>{card.sentenceZh}</p><p lang="en">{card.sentenceEn}</p></>}
                <p>参考表达不只有一种，自然且符合这里的意思也可以。</p>
                {card.pattern&&<p>可复用句式：<span lang="en">{card.pattern}</span></p>}
                {card.reasonZh&&<p>{card.reasonZh}</p>}{card.originalEnglish&&<p>原回答：<span lang="en">{card.originalEnglish}</span></p>}
                <Link href={card.sourceHref}>{card.sourceTitle} · 查看来源</Link>
                {audioState.provider&&<p>示范声音：{audioState.provider==="mimo"?"MiMo":"设备声音"}</p>}
              </details>
            </>}
          </div>
          <div className={styles.actions}>
            {!shown?<>
              {autoReveal&&<div className={styles.timer}><span>{hidden?"已暂停":timerPaused?"倒计时暂停":`${seconds} 秒后揭晓`}</span><button className={styles.textButton} onClick={()=>setTimerPaused(p=>!p)}>{timerPaused?"继续计时":"暂停计时"}</button></div>}
              <button className={`primary-button ${styles.mainAction}`} disabled={actionDisabled} onClick={()=>void perform({type:"reveal"})}>{busy?"正在读取…":"揭晓表达"}</button>
            </>:!v2&&view.mode==="learn"?<button className={`primary-button ${styles.mainAction}`} disabled={actionDisabled} onClick={()=>void perform({type:"advance"})}>{busy?"正在保存…":"下一条"}<Icon name="arrow" /></button>:<>
              <p className={styles.ratingHint}>按揭晓前的回想选择。自然、意思一致的其他说法也可以。</p>
              <div className={styles.ratings} aria-label="这次回想情况">
                <button className="secondary-button" disabled={actionDisabled} onClick={()=>void perform({type:"rate",rating:"remembered"})}>脱口而出</button>
                <button className="secondary-button" disabled={actionDisabled} onClick={()=>void perform({type:"rate",rating:"uncertain"})}>想了一会儿</button>
                <button className="secondary-button" disabled={actionDisabled} onClick={()=>void perform({type:"rate",rating:"forgot"})}>没想出来</button>
              </div>
            </>}
          </div>
        </>:null}
      </section>:<section className={styles.study}>
        {hasPending?<><h2>正在确认这次记录</h2><p>原来的选择已保留，确认后继续。不会重复计入复习。</p></>:view?.status==="completed"?<>
          <h2>{view.historyOnly?'历史学习记录':'本批已结束'}</h2>
          <p>{v2?(view.summary?.length?'本组回想记录已保存，不用一次学完所有表达。':'这一组已结束。变化或暂不可用的项目已跳过，没有新增学习成绩。'):"这次记录的是接触或自评，未记为口语掌握。"}</p>
          {view.nextDueAt&&<p>最早下次复习：{new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'long',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(view.nextDueAt))}</p>}
          {!!view.summary?.length&&<><h3>本组最后一次回想</h3><ul className={styles.summary}>{view.summary.map(item=><li key={item.itemId}><span>{item.chinese}</span><span>{ratingNames[item.latestRating]}</span></li>)}</ul>
            <details className={styles.detail}><summary>回看本组表达</summary>{view.summary.map(item=><div key={item.itemId}><p>{item.chinese}</p>{item.english&&<><p lang="en">{item.english}</p><button className={styles.textButton} onClick={()=>void player.current?.play({text:item.english!,voiceId:voice})}>播放表达</button></>}<p>首见：{ratingNames[item.initialRating]} · 最后：{ratingNames[item.latestRating]}</p></div>)}</details></>}
          {sourceQuestion&&<Link className="secondary-button" href={`/questions/${encodeURIComponent(sourceQuestion)}`}>回到这道题</Link>}
          <Link className={styles.allLink} href="/">今天先到这里</Link>
        </>:view?.status==="paused"?<><h2>位置已保存</h2><p>下次从这里继续，不需要重新开始。</p></>:<><h2>从一小组开始</h2><p>每组五个表达，先回想，再揭晓。不用打字，随时可以停。</p></>}
        <div className={styles.modes} aria-label="选择学习方式"><button aria-pressed={mode==="learn"} disabled={actionDisabled} onClick={()=>{setMode("learn");createRequest.current=null;}}>学新表达 <span>{overview?.newCount??0}</span></button><button aria-pressed={mode==="review"} disabled={actionDisabled} onClick={()=>{setMode("review");createRequest.current=null;}}>复习到期表达 <span>{overview?.dueCount??0}</span></button></div>
        {overview?.unavailableCount?<p>部分材料正在处理或暂不可用，不会进入本批。</p>:null}
        {overview&&!overview.totalCount?<p>这个范围还没有可学表达。可以回题目查看已保存的回答；这里不会自动生成材料。</p>:null}
        {resumable||count?<button className={`primary-button ${styles.mainAction}`} disabled={actionDisabled||(!overview?.enabled&&!resumable)} onClick={()=>void begin(mode)}>{busy?"正在准备…":resumable?"继续上次位置":view?.status==="completed"?"再学一组":mode==="review"?"开始复习":"开始轻松学"}</button>:<p>{mode==="review"?"暂时没有到期表达，稍后再来，或学一点新的。":"这个范围的新表达已接触过，之后可以到期复习。"}</p>}
        {overview&&!overview.enabled&&!resumable&&<p>新批次暂未开放，历史记录仍保留。</p>}
        {scope.type!=="all"&&<Link href="/light-study" className={styles.allLink}>查看全部表达</Link>}
        <Link href={`/study?mode=${mode}`} className={styles.allLink}>返回选择范围</Link>
      </section>}
    </>}
  </div>;
}

function ExampleText({text,target}:{text:string;target:string}) {
  const index=text.toLocaleLowerCase("en").indexOf(target.toLocaleLowerCase("en"));
  return index<0?<>{text}</>:<>{text.slice(0,index)}<mark>{text.slice(index,index+target.length)}</mark>{text.slice(index+target.length)}</>;
}
