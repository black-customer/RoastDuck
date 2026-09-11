'use client';

import Link from 'next/link';
import {useEffect,useId,useRef,useState} from 'react';
import {useRouter} from 'next/navigation';
import type {SentenceCard,SentenceCreate,SentenceRating,SentenceSession} from '@/lib/sentence-study/contracts';
import {SentenceController} from '@/lib/sentence-study/client';
import {LightAudioPlayer,type LightAudioState} from '@/lib/light-study/audio';
import {createBrowserSpeechProvider} from '@/lib/tts';
import {getSpeechPreferences,subscribeSpeechPreferences,legacyPresetFor} from '@/lib/speech/preferences';
import {SpeechPreferences} from '@/components/SpeechPreferences';
import {Icon} from '@/components/ui/Icon';
import {CoachingPanel} from '@/components/coaching/CoachingPanel';
import {HighlightText} from './HighlightText';
import {GuidedReveal} from './GuidedReveal';
import {SentenceTeaching} from './SentenceTeaching';
import styles from './SentenceStudy.module.css';

const ratings:Array<{value:SentenceRating;label:string;hint:string}>=[
  {value:'remembered',label:'脱口而出',hint:'自己顺畅、自然地表达出来'},
  {value:'uncertain',label:'想出来了',hint:'花了时间，但自己想对了'},
  {value:'forgot',label:'遇到卡壳',hint:'至少一处需要答案或提示'},
];
type State={view:SentenceSession|null;pending:number;saving:boolean;error:string|null;loading:boolean;conflict:boolean};
type Coaching={card:SentenceCard;mode:'sentence_guided'|'answer_guided'|'answer_independent';initialDraft?:string};
const initial:State={view:null,pending:0,saving:false,error:null,loading:true,conflict:false};
export const REEXPRESS_KEY='roastduck_sentence_reexpress_v1';
export const SCRATCHPAD_KEY='roastduck_sentence_scratchpad_v1';

function keepComposerVisible(element:HTMLTextAreaElement){
  requestAnimationFrame(()=>{
    if(!element.isConnected||document.activeElement!==element)return;
    const shell=element.closest('[data-sentence-focus]'),rect=element.getBoundingClientRect();
    const top=(shell?.querySelector('header')?.getBoundingClientRect().bottom??0)+16;
    const bottom=Math.min(shell?.querySelector('footer')?.getBoundingClientRect().top??innerHeight,window.visualViewport?.height??innerHeight)-16;
    if(rect.top>=top&&rect.bottom<=bottom)return;
    if(bottom>top)window.scrollBy({top:rect.height<=bottom-top?(rect.top+rect.bottom-top-bottom)/2:rect.top-top,behavior:'instant'});
  });
}

export function SentenceReading({card}:{card:SentenceCard}){
  return card.unavailable?<p className={styles.english} lang="en">{card.english}</p>:<HighlightText card={card} language="en" as="p" className={styles.english} initialHighlights={card.userHighlights}/>;
}

export function SentenceStudyPanel({sessionId,input,initialError,resumeOnLoad=false}:{sessionId?:string;input:SentenceCreate;initialError?:string;resumeOnLoad?:boolean}){
  const router=useRouter(),scratchId=useId(),retryId=useId();
  const controller=useRef<SentenceController|null>(null),heading=useRef<HTMLHeadingElement>(null),audio=useRef<LightAudioPlayer|null>(null);
  const previousDialog=useRef<HTMLDialogElement>(null),previousTrigger=useRef<HTMLElement|null>(null),stageAction=useRef<HTMLButtonElement>(null);
  const [state,setState]=useState<State>(initial),[readAttempt,setReadAttempt]=useState(0),[settingsOpen,setSettingsOpen]=useState(false),[previousOpen,setPreviousOpen]=useState(false),[summaryOpen,setSummaryOpen]=useState(false);
  const [speechPrefs,setSpeechPrefs]=useState(getSpeechPreferences),[autoPlay,setAutoPlay]=useState(true),[reexpress,setReexpress]=useState(false),[scratchOpen,setScratchOpen]=useState(true);
  const [localError,setLocalError]=useState(''),[audioState,setAudioState]=useState<LightAudioState>({phase:'idle',provider:null,message:''}),[coaching,setCoaching]=useState<Coaching|null>(null);
  const [drafts,setDrafts]=useState<{key:string;draft:string;retryDraft:string}|null>(null),[actionBusy,setActionBusy]=useState(false);
  const [retainedAttempt,setRetainedAttempt]=useState<{chinese:string;draft:string;retryDraft:string}|null>(null),[retainedOpen,setRetainedOpen]=useState(false);
  const active=useRef(true),locked=useRef(false),coachingRestored=useRef<string|null>(null),lastReveal=useRef('');
  const initKey=JSON.stringify(input),view=state.view,card=view?.cards[view.index]??null,next=view?.cards[(view?.index??0)+1]??null;
  const stage=view?.stage??(view?.revealed?'teaching':'recall'),answerVisible=stage==='teaching'||stage==='rated'||stage==='retry_reveal';
  const practice=view?.practice??{revealCount:0,maxRevealCount:0,draft:'',retryDraft:'',retryAttempt:0};
  const draftKey=`${view?.id}:${card?.id}:${card?.version}:${practice.retryAttempt}`,localDraft=drafts?.key===draftKey?drafts:null;
  const draft=localDraft?.draft??practice.draft,retryDraft=localDraft?.retryDraft??practice.retryDraft;
  const currentAssessment=view?.assessments.findLast(item=>item.sentenceId===card?.id);
  const previous=view?.assessments.at(-1),previousCard=view?.cards.find(item=>item.id===previous?.sentenceId)??null;
  const source=view?.cards[0]?.source,blocked=state.conflict||!!state.error||state.loading||actionBusy;
  const viewId=view?.id,currentText=card?.english,nextText=next?.english,currentQuestion=card?.source.questionId,nextQuestion=next?.source.questionId;
  const selectedVoice=speechPrefs.voice,selectedAccent=speechPrefs.accent,voicePreset=legacyPresetFor({voice:selectedVoice,accent:selectedAccent});

  useEffect(()=>{
    active.current=true;setLocalError(initialError??'');
    const manager=new SentenceController();controller.current=manager;
    const update=()=>{if(active.current)setState(manager.getSnapshot());};
    const unsubscribe=manager.subscribe(update);update();
    if(!initialError){
      if(sessionId)void manager.load(sessionId).then(()=>{const result=manager.getSnapshot();if(resumeOnLoad&&!result.error&&!result.pending&&result.view?.status==='paused')void manager.apply({type:'resume'});});
      else{
        const startInput=JSON.parse(initKey) as SentenceCreate,key=`roastduck_sentence_page_start:${initKey}`;
        try{const receipt=sessionStorage.getItem(key);if(receipt)startInput.clientRequestId=receipt;else sessionStorage.setItem(key,startInput.clientRequestId);}catch{/* Server keeps the stable request receipt. */}
        void manager.start(startInput);
      }
    }
    return()=>{active.current=false;unsubscribe();manager.dispose();controller.current=null;};
  },[sessionId,initKey,initialError,readAttempt,resumeOnLoad]);

  useEffect(()=>{
    const player=new LightAudioPlayer(createBrowserSpeechProvider(),setAudioState);audio.current=player;setSpeechPrefs(getSpeechPreferences());
    const unsubscribe=subscribeSpeechPreferences(setSpeechPrefs);
    try{setReexpress(localStorage.getItem(REEXPRESS_KEY)==='1');setScratchOpen(localStorage.getItem(SCRATCHPAD_KEY)!=='0');}catch{}
    const request=new AbortController();
    void fetch('/api/settings',{signal:request.signal}).then(r=>r.ok?r.json():null).then(value=>{if(!request.signal.aborted)setAutoPlay(value?.settings?.autoPlay??true);}).catch(()=>{});
    const visibility=()=>{if(document.hidden){player.stop();void controller.current?.flushPractice().catch(()=>{});}};
    document.addEventListener('visibilitychange',visibility);
    return()=>{request.abort();unsubscribe();player.dispose();audio.current=null;document.removeEventListener('visibilitychange',visibility);};
  },[]);

  useEffect(()=>{
    if(!viewId)return;
    const url=new URL(window.location.href);url.searchParams.set('session',viewId);window.history.replaceState(null,'',url);
  },[viewId]);

  useEffect(()=>{
    if(!view||state.loading)return;
    const key=`roastduck_sentence_coaching:${view.id}`;
    try{
      if(coachingRestored.current!==view.id){
        coachingRestored.current=view.id;
        const raw=localStorage.getItem(key);
        if(raw){const saved=JSON.parse(raw),savedCard=view.cards.find(c=>c.id===saved.id&&c.version===saved.version&&!c.unavailable);
          if(savedCard&&['sentence_guided','answer_guided','answer_independent'].includes(saved.mode))setCoaching({card:savedCard,mode:saved.mode});
          else localStorage.removeItem(key);
        }
        return;
      }
      if(coaching&&!view.cards.some(c=>c.id===coaching.card.id&&c.version===coaching.card.version&&!c.unavailable)){localStorage.removeItem(key);setCoaching(null);return;}
      if(coaching)localStorage.setItem(key,JSON.stringify({id:coaching.card.id,version:coaching.card.version,mode:coaching.mode}));
      else localStorage.removeItem(key);
    }catch{setLocalError('练习位置暂未保存到浏览器。请保留输入，恢复本机存储后再继续。');}
  },[view,state.loading,coaching]);

  useEffect(()=>{
    const player=audio.current;if(!player)return;
    const current=currentText?{text:currentText,voiceId:voicePreset,voice:selectedVoice,accent:selectedAccent,style:currentQuestion?'ielts-answer' as const:'daily-conversation' as const,playbackMode:'natural' as const}:null;
    const upcoming=nextText?{text:nextText,voiceId:voicePreset,voice:selectedVoice,accent:selectedAccent,style:nextQuestion?'ielts-answer' as const:'daily-conversation' as const,playbackMode:'natural' as const}:null;
    player.stop();player.prime(current,upcoming,autoPlay&&!document.hidden&&!coaching&&view?.status==='active');
    const revealKey=`${view?.id}:${card?.id}:${practice.retryAttempt}`;
    if(current&&answerVisible&&view?.status==='active'&&autoPlay&&!coaching&&!document.hidden&&lastReveal.current!==revealKey){lastReveal.current=revealKey;void player.play(current);}
    return()=>{player.stop();};
  },[card?.id,currentText,nextText,currentQuestion,nextQuestion,answerVisible,practice.retryAttempt,view?.status,autoPlay,selectedVoice,selectedAccent,voicePreset,view?.id,coaching]);

  useEffect(()=>{heading.current?.focus({preventScroll:true});},[card?.id,view?.status]);
  useEffect(()=>{
    const resized=()=>{const element=document.activeElement;if(element instanceof HTMLTextAreaElement&&element.closest('[data-sentence-focus]'))keepComposerVisible(element);};
    window.visualViewport?.addEventListener('resize',resized);
    return()=>window.visualViewport?.removeEventListener('resize',resized);
  },[]);
  useEffect(()=>{
    if(previousOpen)previousDialog.current?.showModal();
    else{previousDialog.current?.close();previousTrigger.current?.focus({preventScroll:true});}
  },[previousOpen]);

  async function apply(action:Parameters<SentenceController['apply']>[0]){
    if(locked.current)return false;
    locked.current=true;setActionBusy(true);setLocalError('');
    try{const accepted=await controller.current?.apply(action);return accepted===true&&!controller.current?.getSnapshot().error;}
    catch(reason){setLocalError(reason instanceof Error?reason.message:'操作未保存，请重试。');return false;}
    finally{locked.current=false;if(active.current)setActionBusy(false);}
  }
  function updatePractice(patch:{revealCount?:number;draft?:string;retryDraft?:string}){
    if(patch.draft!==undefined||patch.retryDraft!==undefined)setDrafts({key:draftKey,draft:patch.draft??draft,retryDraft:patch.retryDraft??retryDraft});
    try{controller.current?.updatePractice(patch);}catch(reason){setLocalError(reason instanceof Error?reason.message:'本机暂未保存，请保留输入后重试。');}
  }
  function flushPractice(){void controller.current?.flushPractice().catch(reason=>setLocalError(reason instanceof Error?reason.message:'本次尝试尚未同步，输入仍保留。'));}
  async function pause(){audio.current?.stop();await apply({type:'pause'});}
  async function rate(rating:SentenceRating){
    if(await apply({type:'rate',rating})){if(reexpress){audio.current?.stop();await apply({type:'start_retry'});}else requestAnimationFrame(()=>stageAction.current?.focus({preventScroll:true}));}
  }
  async function transition(type:'enter_teaching'|'start_retry'|'reveal_retry'|'advance'){
    if(type==='start_retry'||type==='advance')audio.current?.stop();
    if(await apply({type})){if(type==='advance')setDrafts(null);else requestAnimationFrame(()=>stageAction.current?.focus({preventScroll:true}));}
  }
  function play(quick=false){if(card&&answerVisible&&view?.status==='active')void audio.current?.play({text:card.english,voiceId:legacyPresetFor(speechPrefs),voice:speechPrefs.voice,accent:speechPrefs.accent,style:card.source.questionId?'ielts-answer':'daily-conversation',playbackMode:quick?'quick':'natural'});}
  async function saveAutoPlay(value:boolean){setAutoPlay(value);try{const response=await fetch('/api/settings',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({autoPlay:value})});if(!response.ok)throw new Error();}catch{setLocalError('声音偏好暂未保存，本次选择仍然有效。');}}
  function savePreference(key:string,value:boolean){try{localStorage.setItem(key,value?'1':'0');}catch{setLocalError('此设置仅本次有效，浏览器未能保存偏好。');}}
  function showPrevious(){audio.current?.stop();previousTrigger.current=document.activeElement as HTMLElement;setPreviousOpen(true);}
  function openCoach(mode:Coaching['mode'],target:SentenceCard,initialDraft?:string){audio.current?.stop();setCoaching({card:target,mode,initialDraft});}
  async function nextCoach(){
    if(!coaching)return;
    if(coaching.mode==='answer_guided'){setCoaching({...coaching,mode:'answer_independent',initialDraft:undefined});return;}
    if(coaching.mode==='sentence_guided'&&card?.id===coaching.card.id&&currentAssessment&&view?.status==='active'){
      if(!await apply({type:'advance'}))return;
      setDrafts(null);
    }
    setCoaching(null);
  }
  async function recover(){
    setLocalError('');
    if(!controller.current||!state.view){setReadAttempt(value=>value+1);return;}
    const conflicted=state.conflict;
    if(conflicted&&localDraft&&(localDraft.draft||localDraft.retryDraft))setRetainedAttempt({chinese:card?.chinese??'',draft:localDraft.draft,retryDraft:localDraft.retryDraft});
    await controller.current.retry();
    const restored=controller.current.getSnapshot();
    if(restored.error)return;
    if(conflicted){setDrafts(null);return;}
    if(localDraft&&restored.view?.cards[restored.view.index]?.id===card?.id){
      try{controller.current.updatePractice({draft:localDraft.draft,retryDraft:localDraft.retryDraft});await controller.current.flushPractice();}
      catch(reason){setLocalError(reason instanceof Error?reason.message:'输入仍在当前页面，尚未保存。');}
    }
  }
  const error=initialError||localError||state.error;
  const nextLabel=view&&view.index===view.cards.length-1?'完成本题':'下一句';

  return <div className={styles.shell} data-sentence-focus="true">
    <header className={styles.header}><div className={styles.headerInner}>
      <button type="button" className={styles.back} disabled={actionBusy} onClick={()=>{if(view?.status==='active')void pause();else router.push('/');}}><span className={styles.reverseIcon}><Icon name="arrow"/></span><span>{view?.status==='active'?'暂停学习':'返回首页'}</span></button>
      <div className={styles.progressLabel}>{view?`${view.mode==='review'?'句子复习':'句子学习'} · ${Math.min(view.index+1,view.cards.length)} / ${view.cards.length}`:'句子学习'}</div>
      <button type="button" className={styles.settingsButton} aria-label="学习设置" aria-expanded={settingsOpen} onClick={()=>setSettingsOpen(value=>!value)}><Icon name="settings"/><span>设置</span></button>
    </div></header>
    <div className={styles.content}>
      {settingsOpen&&<section className={styles.settings} aria-label="本次学习设置">
        <label><input type="checkbox" checked={autoPlay} onChange={event=>void saveAutoPlay(event.target.checked)}/>进入讲解后自动播放自然声音</label>
        <SpeechPreferences onChange={setSpeechPrefs} compact/>
        <label><input type="checkbox" checked={reexpress} onChange={event=>{setReexpress(event.target.checked);savePreference(REEXPRESS_KEY,event.target.checked);}}/>自评后自动进入本地再练</label>
        <p>只隐藏答案、保留输入，不自动请 AI 反馈。随时可以下一句。</p>
      </section>}
      {error&&<div className={styles.error} role="alert"><p>{error}</p><button type="button" onClick={()=>void recover()}>重试保存／恢复</button></div>}
      {view?.notice&&<p className={styles.notice} role="status">{view.notice}</p>}
      {retainedAttempt&&!coaching&&stage!=='retry'&&<details className={styles.retainedAttempt} onToggle={event=>setRetainedOpen(event.currentTarget.open)}>
        <summary>本次未提交的尝试</summary>
        {retainedOpen&&<><p>原句：{retainedAttempt.chinese}</p><p>这些文字没有套用到当前句，也没有因恢复操作发送给老师。可以复制保留。</p>{retainedAttempt.draft&&<p className={styles.retainedText}>{retainedAttempt.draft}</p>}{retainedAttempt.retryDraft&&<p className={styles.retainedText}>{retainedAttempt.retryDraft}</p>}</>}
      </details>}
      {coaching&&<CoachingPanel materialId={coaching.card.materialId} sentenceId={coaching.mode==='sentence_guided'?coaching.card.id:undefined} questionId={coaching.card.source.questionId??undefined} mode={coaching.mode} initialDraft={coaching.initialDraft} onClose={()=>setCoaching(null)} onNext={()=>void nextCoach()}/>}
      {!coaching&&<>
        {state.loading&&!view?<section className={styles.loading} role="status"><span className={styles.loadingBar}/><h1>正在打开你的句子</h1><p>读取已保存的材料与位置。</p></section>
        :!view?<section className={styles.empty}><h1>暂时没有开始这次学习</h1><p>可以重试，或选择另一道题。原回答和学习记录仍然保留。</p><Link className="primary-button" href="/study?mode=learn">选择题目</Link></section>
        :view.status==='paused'?<section className={styles.empty}><h1 ref={heading} tabIndex={-1}>停在这里，下次继续</h1><p>{source?.title}</p><p>已走过 {view.index} / {view.cards.length} 句。{state.pending?'操作保留在本机，联网后继续同步。':'位置已保存。'}</p><div className={styles.row}><button className="primary-button" disabled={blocked} onClick={()=>void apply({type:'resume'})}>继续学习</button><Link className="secondary-button" href="/">返回首页</Link></div></section>
        :view.status==='completed'?<section className={styles.complete}>
          <h1 ref={heading} tabIndex={-1}>{view.mode==='review'?'本次到期复习已完成':'本次句子学习已完成'}</h1><p>{source?.title}</p>
          <p className={styles.completionCount}>{view.assessments.length}<span>{view.mode==='review'?'句完成本轮复习':'句已完成首轮回想'}</span></p>
          <p role="status">{state.pending?'最后的记录已保存在本机，正在同步…':view.nextDueAt?`下次复习：${new Date(view.nextDueAt).toLocaleString('zh-CN',{month:'long',day:'numeric',hour:'2-digit',minute:'2-digit',timeZone:'Asia/Shanghai'})}`:'本次记录已保存。'}</p>
          <div className={styles.row}><Link className="primary-button" href={`/study?mode=${view.mode}&choose=questions`}>选择下一道题</Link><Link className="secondary-button" href="/">今天先到这里</Link></div>
          <div className={styles.secondaryRow}>{source&&<Link href={source.href}>回到{source.questionId?'这道题':'这段对话'}</Link>}<button onClick={()=>setSummaryOpen(value=>!value)} aria-expanded={summaryOpen}>回看本次句子</button>{previousCard&&<button onClick={showPrevious}>修改上次自评</button>}</div>
          {summaryOpen&&<div className={styles.summary}>{view.cards.map(item=><article key={item.id}><HighlightText card={item} language="zh" initialHighlights={item.userHighlights}/><SentenceReading card={item}/><span>{ratings.find(r=>r.value===view.assessments.find(a=>a.sentenceId===item.id)?.rating)?.label??'未评分'}</span><details><summary>这句怎么说</summary><SentenceTeaching card={item}/></details></article>)}</div>}
        </section>
        :card?<>
          <div className={styles.sourceRow}><span>{source?.title}</span>{previousCard&&previousCard.id!==card.id&&<button type="button" onClick={showPrevious}>查看上一句</button>}</div>
          <article className={styles.studyCard} data-stage={stage}>
            <div className={styles.sentencePosition} aria-label={`第 ${view.index+1} 句`}>{view.index+1}<span>/ {view.cards.length}</span></div>
            <HighlightText card={card} language="zh" as="h1" className={styles.chinese} initialHighlights={card.userHighlights} headingRef={heading}/>
            {card.contextZh&&<p className={styles.context}>{card.contextZh}</p>}
            {stage==='recall'&&<>
              <GuidedReveal english={card.english} count={practice.revealCount} disabled={blocked} onChange={revealCount=>updatePractice({revealCount})} onCommit={flushPractice}/>
              <section className={styles.scratchpad} aria-label="表达草稿">
                <button type="button" className={styles.scratchToggle} aria-expanded={scratchOpen} aria-controls={scratchId} onClick={()=>{setScratchOpen(!scratchOpen);savePreference(SCRATCHPAD_KEY,!scratchOpen);}}>写下你的尝试（可留空）<span>{scratchOpen?'收起':'展开'}</span></button>
                {scratchOpen&&<><label className={styles.srOnly} htmlFor={scratchId}>写下你的尝试（可留空）</label><textarea id={scratchId} value={draft} rows={3} maxLength={12000} onFocus={event=>keepComposerVisible(event.currentTarget)} onChange={event=>updatePractice({draft:event.target.value})} onBlur={flushPractice} readOnly={state.conflict} placeholder="想到多少，先留下多少。不必整句写完。"/><p>可以打字，或用 Win + H／输入法听写。这里不会发送给 AI。</p></>}
              </section>
            </>}
            {stage==='retry'&&<section className={styles.scratchpad} aria-label="本地再练">
              <p className={styles.retryHint}>再用自己的话说一次。无需和参考答案一模一样，也可以随时继续。</p>
              <label htmlFor={retryId}>再练一次的表达（可留空）</label><textarea id={retryId} value={retryDraft} rows={4} maxLength={12000} onFocus={event=>keepComposerVisible(event.currentTarget)} onChange={event=>updatePractice({retryDraft:event.target.value})} onBlur={flushPractice} readOnly={state.conflict} placeholder="可以只写刚才卡住的部分，也可以重新说完整句。"/>
              <p>可以打字或使用输入法听写。不请求麦克风，不自动发送给 AI。</p>
            </section>}
            {answerVisible&&<div className={styles.reveal}>
              {stage==='retry_reveal'&&<section className={styles.attemptCompare} aria-label="本次再练表达"><h2>你刚才的表达</h2><p lang="en">{retryDraft||'这次没有留下文字，也可以直接对照。'}</p></section>}
              <SentenceReading card={card}/>
              <div className={styles.audioRow}><button type="button" onClick={()=>play()}><Icon name="audio"/>{audioState.phase==='loading'?'正在准备自然声音…':audioState.phase==='playing'?'重新播放':'听自然表达'}</button>{audioState.phase==='playing'&&<button type="button" onClick={()=>audio.current?.stop()}>停止</button>}<button type="button" onClick={()=>play(true)}>先听快捷声音</button></div>
              {audioState.message&&<p className={styles.audioStatus} role="status">{audioState.message}</p>}
              {draft&&stage!=='retry_reveal'&&<details className={styles.originalDraft}><summary>看看我刚才的尝试</summary><p lang="en">{draft}</p></details>}
              <SentenceTeaching card={card}/>
              <details className={styles.source}><summary>说明与来源</summary><p>{card.meaningOrigin==='user_chinese'?'中文提示来自你提供的原意。':'中文提示根据英文整理；若不符合你的想法，可回到原回答补充中文。'}</p><Link href={card.source.href}>查看原回答与材料</Link></details>
              {stage==='retry_reveal'&&<section className={styles.coachOffer}><button type="button" className="secondary-button" disabled={blocked} onClick={()=>openCoach('sentence_guided',card,retryDraft)}>请老师看看</button><p>将使用文本 API 获取反馈；点击后可编辑，确认发送才请求 AI。</p></section>}
            </div>}
          </article>
          <footer className={styles.actions}>
            {stage==='recall'?<button ref={stageAction} type="button" className={styles.revealButton} disabled={blocked} onClick={()=>void transition('enter_teaching')}>看自然表达与讲解<Icon name="arrow"/></button>
            :stage==='teaching'&&!currentAssessment?<><p>评价刚才自己回想的表现；自然等价的表达也可以。</p><div className={styles.ratings}>{ratings.map((rating,index)=><button ref={index===0?stageAction:undefined} type="button" key={rating.value} disabled={blocked} onClick={()=>void rate(rating.value)}><strong>{rating.label}</strong><span>{rating.hint}</span></button>)}</div></>
            :stage==='retry'?<div className={styles.continueActions}><button ref={stageAction} type="button" className="primary-button" disabled={blocked} onClick={()=>void transition('reveal_retry')}>揭晓并对照</button><button type="button" className="secondary-button" disabled={blocked} onClick={()=>void transition('advance')}>{nextLabel}</button></div>
            :<>
              <div className={styles.ratedStatus}><span>本次自评：{ratings.find(r=>r.value===currentAssessment?.rating)?.label??'已记录'}</span><button type="button" disabled={blocked} onClick={showPrevious}>修改本次自评</button></div>
              <div className={styles.continueActions}><button ref={stageAction} type="button" className="primary-button" disabled={blocked} onClick={()=>void transition('advance')}>{nextLabel}<Icon name="arrow"/></button><button type="button" className="secondary-button" disabled={blocked} onClick={()=>void transition('start_retry')}>{stage==='retry_reveal'?'重新遮住，再练一遍':'再练一遍'}</button></div>
            </>}
          </footer>
        </>:null}
        {view?.status==='completed'&&view.cards[0]&&<section className={styles.outputOffer}><h2>想完整表达自己的想法吗？</h2><p>可以看中文练一次，也可以直接试试不看提示的回答。都是可选的。</p><div className={styles.row}><button className="secondary-button" onClick={()=>openCoach('answer_guided',view.cards[0])}>看中文，完整表达一次</button><button className="secondary-button" onClick={()=>openCoach('answer_independent',view.cards[0])}>不看提示，独立回答</button></div></section>}
      </>}
      {!coaching&&<dialog ref={previousDialog} className={styles.previousPanel} aria-label="句子与自评" onClose={()=>setPreviousOpen(false)}>{previousOpen&&previousCard&&previous&&<>
        <div className={styles.previousHeader}><h2>{previousCard.id===card?.id?'本句自评':'上一句'}</h2><button type="button" onClick={()=>setPreviousOpen(false)}>返回当前句</button></div>
        <p>{previousCard.chinese}</p><SentenceReading card={previousCard}/><p>上次选择：{ratings.find(r=>r.value===previous.rating)?.label}。只有下方重选会调整复习时间。</p>
        <div className={styles.ratings}>{ratings.map(rating=><button key={rating.value} type="button" disabled={blocked} aria-pressed={previous.rating===rating.value} onClick={()=>void apply({type:'revise_rating',targetEventId:previous.eventId,rating:rating.value}).then(saved=>{if(saved)setPreviousOpen(false);})}>{rating.label}</button>)}</div>
      </>}</dialog>}
    </div>
  </div>;
}
