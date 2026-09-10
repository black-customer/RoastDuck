'use client';
import Link from 'next/link';
import {useEffect,useRef,useState} from 'react';
import {useRouter} from 'next/navigation';
import type {SentenceCard,SentenceCreate,SentenceRating,SentenceSession} from '@/lib/sentence-study/contracts';
import {SentenceController} from '@/lib/sentence-study/client';
import {LightAudioPlayer,type LightAudioState} from '@/lib/light-study/audio';
import {createBrowserSpeechProvider} from '@/lib/tts';
import {getSpeechPreferences,subscribeSpeechPreferences,legacyPresetFor} from '@/lib/speech/preferences';
import {SpeechPreferences} from '@/components/SpeechPreferences';
import {HighlightText} from './HighlightText';
import {Icon} from '@/components/ui/Icon';
import {CoachingPanel} from '@/components/coaching/CoachingPanel';
import styles from './SentenceStudy.module.css';

const ratings:Array<{value:SentenceRating;label:string;hint:string}>=[{value:'remembered',label:'脱口而出',hint:'自然地想起来了'},{value:'uncertain',label:'想了一会儿',hint:'想起了，但需要时间'},{value:'forgot',label:'没想出来',hint:'这次先学会这个意思'}];
type State={view:SentenceSession|null;pending:number;saving:boolean;error:string|null;loading:boolean;conflict:boolean};
const initial:State={view:null,pending:0,saving:false,error:null,loading:true,conflict:false};
export const REEXPRESS_KEY='roastduck_sentence_reexpress_v1';

export function SentenceReading({card}:{card:SentenceCard}){
  return card.unavailable?<p className={styles.english} lang="en">{card.english}</p>:<HighlightText card={card} language="en" as="p" className={styles.english} initialHighlights={card.userHighlights}/>;
}

export function SentenceStudyPanel({sessionId,input,initialError,resumeOnLoad=false}:{sessionId?:string;input:SentenceCreate;initialError?:string;resumeOnLoad?:boolean}){
  const router=useRouter(),controller=useRef<SentenceController|null>(null),heading=useRef<HTMLHeadingElement>(null),audio=useRef<LightAudioPlayer|null>(null),previousDialog=useRef<HTMLDialogElement>(null);
  const [state,setState]=useState<State>(initial),[readAttempt,setReadAttempt]=useState(0),[settingsOpen,setSettingsOpen]=useState(false),[previousOpen,setPreviousOpen]=useState(false),[summaryOpen,setSummaryOpen]=useState(false);
  const [speechPrefs,setSpeechPrefs]=useState(getSpeechPreferences),[autoPlay,setAutoPlay]=useState(true),[reexpress,setReexpress]=useState(false),[localError,setLocalError]=useState(''),[audioState,setAudioState]=useState<LightAudioState>({phase:'idle',provider:null,message:''});
  const [coaching,setCoaching]=useState<{card:SentenceCard;mode:'sentence_guided'|'answer_guided'|'answer_independent'}|null>(null);
  const selectedVoice=speechPrefs.voice,selectedAccent=speechPrefs.accent,voicePreset=legacyPresetFor({voice:selectedVoice,accent:selectedAccent});
  const coachingRestored=useRef<string|null>(null);
  const active=useRef(true),initKey=JSON.stringify(input),lastReveal=useRef('');
  const view=state.view,card=view?.cards[view.index]??null,next=view?.cards[(view?.index??0)+1]??null;
  const viewId=view?.id,currentText=card?.english,nextText=next?.english,currentQuestion=card?.source.questionId,nextQuestion=next?.source.questionId;
  const previous=view?.assessments.at(-1),previousCard=view?.cards.find(item=>item.id===previous?.sentenceId)??null;
  useEffect(()=>{
    active.current=true;setLocalError(initialError??'');
    const manager=new SentenceController();controller.current=manager;
    const update=()=>{if(active.current)setState(manager.getSnapshot());};
    const unsubscribe=manager.subscribe(update);update();
    if(!initialError){
      if(sessionId)void manager.load(sessionId).then(()=>{const state=manager.getSnapshot();if(resumeOnLoad&&!state.error&&!state.pending&&state.view?.status==='paused')void manager.apply({type:'resume'});});
      else{
        const startInput=JSON.parse(initKey) as SentenceCreate,key=`roastduck_sentence_page_start:${initKey}`;
        try{const receipt=sessionStorage.getItem(key);if(receipt)startInput.clientRequestId=receipt;else sessionStorage.setItem(key,startInput.clientRequestId);}catch{/* Server still keeps the stable request receipt. */}
        void manager.start(startInput);
      }
    }
    return()=>{active.current=false;unsubscribe();manager.dispose();controller.current=null;};
  },[sessionId,initKey,initialError,readAttempt,resumeOnLoad]);
  useEffect(()=>{
    const player=new LightAudioPlayer(createBrowserSpeechProvider(),setAudioState);audio.current=player;setSpeechPrefs(getSpeechPreferences());const unsubscribeSpeech=subscribeSpeechPreferences(setSpeechPrefs);
    try{setReexpress(localStorage.getItem(REEXPRESS_KEY)==='1');}catch{}
    const request=new AbortController();void fetch('/api/settings',{signal:request.signal}).then(r=>r.ok?r.json():null).then(value=>{if(!request.signal.aborted)setAutoPlay(value?.settings?.autoPlay??true);}).catch(()=>{});
    const visibility=()=>{if(document.hidden)player.stop();};document.addEventListener('visibilitychange',visibility);
    return()=>{request.abort();unsubscribeSpeech();player.dispose();audio.current=null;document.removeEventListener('visibilitychange',visibility);};
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
        if(raw){const saved=JSON.parse(raw),card=view.cards.find(c=>c.id===saved.id&&c.version===saved.version&&!c.unavailable);
          if(card&&['sentence_guided','answer_guided','answer_independent'].includes(saved.mode))setCoaching({card,mode:saved.mode});
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
    const revealKey=`${view?.id}:${card?.id}:${view?.revealed}`;
    if(current&&view?.revealed&&view.status==='active'&&autoPlay&&!coaching&&!document.hidden&&lastReveal.current!==revealKey){lastReveal.current=revealKey;void player.play(current);}
    return()=>{player.stop();};
  },[card?.id,currentText,nextText,currentQuestion,nextQuestion,view?.revealed,view?.status,autoPlay,selectedVoice,selectedAccent,voicePreset,view?.id,coaching]);
  useEffect(()=>{heading.current?.focus({preventScroll:true});},[card?.id,view?.status]);
  useEffect(()=>{if(previousOpen)previousDialog.current?.showModal();else previousDialog.current?.close();},[previousOpen]);
  async function apply(action:Parameters<SentenceController['apply']>[0]){setLocalError('');try{await controller.current?.apply(action);}catch(reason){setLocalError(reason instanceof Error?reason.message:'操作未保存，请重试。');}}
  async function pause(){audio.current?.stop();await apply({type:'pause'});}
  async function rate(rating:SentenceRating){const graded=card;await apply({type:'rate',rating});if(graded&&reexpress&&!controller.current?.getSnapshot().error)setCoaching({card:graded,mode:'sentence_guided'});}
  function play(quick=false){if(card&&view?.revealed)void audio.current?.play({text:card.english,voiceId:legacyPresetFor(speechPrefs),voice:speechPrefs.voice,accent:speechPrefs.accent,style:card.source.questionId?'ielts-answer':'daily-conversation',playbackMode:quick?'quick':'natural'});}
  async function saveAutoPlay(value:boolean){setAutoPlay(value);try{const response=await fetch('/api/settings',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({autoPlay:value})});if(!response.ok)throw new Error();}catch{setLocalError('声音偏好暂未保存，本次选择仍然有效。');}}
  const blocked=state.conflict||!!state.error,source=view?.cards[0]?.source;
  const error=initialError||localError||state.error;
  return <div className={styles.shell} data-sentence-focus="true">
    <header className={styles.header}><div className={styles.headerInner}><button type="button" className={styles.back} onClick={()=>{if(view?.status==='active')void pause();else router.push('/');}}><span className={styles.reverseIcon}><Icon name="arrow"/></span><span>{view?.status==='active'?'暂停学习':'返回首页'}</span></button><div className={styles.progressLabel}>{view?`${view.mode==='review'?'句子复习':'句子学习'} · ${Math.min(view.index+1,view.cards.length)} / ${view.cards.length}`:'句子学习'}</div><button type="button" className={styles.settingsButton} aria-label="学习设置" aria-expanded={settingsOpen} onClick={()=>setSettingsOpen(value=>!value)}><Icon name="settings"/><span>设置</span></button></div></header>
    <div className={styles.content}>
      {settingsOpen&&<section className={styles.settings} aria-label="本次学习设置"><label><input type="checkbox" checked={autoPlay} onChange={event=>void saveAutoPlay(event.target.checked)}/>揭晓后自动播放自然声音</label><SpeechPreferences onChange={setSpeechPrefs} compact/><label><input type="checkbox" checked={reexpress} onChange={event=>{setReexpress(event.target.checked);try{localStorage.setItem(REEXPRESS_KEY,event.target.checked?'1':'0');}catch{setLocalError('此设置仅本次有效，浏览器未能保存偏好。');}}}/>再表达一次（可选）</label><p>开启后，可在自评后用自己的英文再表达一次。随时跳过。</p></section>}
      {error&&<div className={styles.error} role="alert"><p>{error}</p><button type="button" onClick={()=>{setLocalError('');if(controller.current&&state.view)void controller.current.retry();else setReadAttempt(value=>value+1);}}>重试保存／恢复</button></div>}
      {view?.notice&&<p className={styles.notice} role="status">{view.notice}</p>}
      {coaching&&<CoachingPanel materialId={coaching.card.materialId} sentenceId={coaching.mode==='sentence_guided'?coaching.card.id:undefined} questionId={coaching.card.source.questionId??undefined} mode={coaching.mode} onClose={()=>setCoaching(null)} onNext={()=>setCoaching(coaching.mode==='answer_guided'?{...coaching,mode:'answer_independent'}:null)}/>}
      {!coaching&&<>
      {state.loading&&!view?<section className={styles.loading} role="status"><span className={styles.loadingBar}/><h1>正在打开你的句子</h1><p>读取已保存的材料与位置。</p></section>:!view?<section className={styles.empty}><h1>暂时没有开始这次学习</h1><p>可以重试，或选择另一道题。原回答和学习记录仍然保留。</p><Link className="primary-button" href="/study?mode=learn">选择题目</Link></section>:view.status==='paused'?<section className={styles.empty}><h1 ref={heading} tabIndex={-1}>停在这里，下次继续</h1><p>{source?.title}</p><p>已走过 {view.index} / {view.cards.length} 句。{state.pending?'操作保留在本机，联网后继续同步。':'位置已保存。'}</p><div className={styles.row}><button className="primary-button" disabled={blocked} onClick={()=>void apply({type:'resume'})}>继续学习</button><Link className="secondary-button" href="/">返回首页</Link></div></section>:view.status==='completed'?<section className={styles.complete}><h1 ref={heading} tabIndex={-1}>{view.mode==='review'?'本次到期复习已完成':'本次句子学习已完成'}</h1><p>{source?.title}</p><p className={styles.completionCount}>{view.assessments.length}<span>{view.mode==='review'?'句完成本轮复习':'句已完成首轮回想'}</span></p><p role="status">{state.pending?'最后的记录已保存在本机，正在同步…':view.nextDueAt?`下次复习：${new Date(view.nextDueAt).toLocaleString('zh-CN',{month:'long',day:'numeric',hour:'2-digit',minute:'2-digit',timeZone:'Asia/Shanghai'})}`:'本次记录已保存。'}</p><div className={styles.row}><Link className="primary-button" href={`/study?mode=${view.mode}&choose=questions`}>选择下一道题</Link><Link className="secondary-button" href="/">今天先到这里</Link></div><div className={styles.secondaryRow}>{source&&<Link href={source.href}>回到{source.questionId?'这道题':'这段对话'}</Link>}<button onClick={()=>setSummaryOpen(value=>!value)} aria-expanded={summaryOpen}>回看本次句子</button>{previousCard&&<button onClick={()=>setPreviousOpen(true)}>修改上次自评</button>}</div>{summaryOpen&&<div className={styles.summary}>{view.cards.map(item=><article key={item.id}><HighlightText card={item} language="zh" initialHighlights={item.userHighlights}/><SentenceReading card={item}/><span>{ratings.find(r=>r.value===view.assessments.find(a=>a.sentenceId===item.id)?.rating)?.label??'未评分'}</span></article>)}</div>}</section>:card?<>
      <div className={styles.sourceRow}><span>{source?.title}</span>{previousCard&&<button type="button" onClick={()=>setPreviousOpen(true)}>查看上一句</button>}</div>
      <article className={styles.studyCard}><div className={styles.sentencePosition} aria-label={`第 ${view.index+1} 句`}>{view.index+1}<span>/ {view.cards.length}</span></div><HighlightText card={card} language="zh" as="h1" className={styles.chinese} initialHighlights={card.userHighlights} headingRef={heading}/>{card.contextZh&&<p className={styles.context}>{card.contextZh}</p>}
        {view.revealed?<div className={styles.reveal}><SentenceReading card={card}/><div className={styles.audioRow}><button type="button" onClick={()=>play()}><Icon name="audio"/>{audioState.phase==='loading'?'正在准备自然声音…':audioState.phase==='playing'?'重新播放':'听自然表达'}</button>{audioState.phase==='playing'&&<button type="button" onClick={()=>audio.current?.stop()}>停止</button>}<button type="button" onClick={()=>play(true)}>先听快捷声音</button></div>{audioState.message&&<p className={styles.audioStatus} role="status">{audioState.message}</p>}
          {(card.usages.length>0||card.notes.length>0)&&<div className={styles.teaching}>{card.usages.length>0&&<section><h2>值得学的用法</h2><dl>{card.usages.map(usage=><div key={usage.id}><dt lang="en">{usage.text}</dt><dd>{usage.meaningZh}</dd></div>)}</dl></section>}{card.notes.length>0&&<section><h2>这里留意一下</h2>{card.notes.map(note=><div key={note.id} className={styles.note}><p>{note.textZh}</p>{note.evidence&&<details><summary>看看我之前怎么说</summary><p lang="en">{note.evidence}</p></details>}</div>)}</section>}</div>}
          <details className={styles.source}><summary>说明与来源</summary><p>{card.meaningOrigin==='user_chinese'?'中文提示来自你提供的原意。':'中文提示根据英文整理；若不符合你的想法，可回到原回答补充中文。'}</p><Link href={card.source.href}>查看原回答与材料</Link></details>
        </div>:<p className={styles.promptHint}>先在心里说一遍。卡住也没关系，点开看看自然的说法。</p>}
      </article>
      <footer className={styles.actions}>{view.revealed?<><p>评价揭晓前的回想，自然等价的表达也可以。</p><div className={styles.ratings}>{ratings.map(rating=><button type="button" key={rating.value} disabled={blocked} onClick={()=>void rate(rating.value)}><strong>{rating.label}</strong><span>{rating.hint}</span></button>)}</div></>:<button type="button" className={styles.revealButton} disabled={blocked} onClick={()=>void apply({type:'reveal'})}>看自然表达<Icon name="arrow"/></button>}</footer>
    </>:null}
    </>}
    {view?.status==='completed'&&!coaching&&view.cards[0]&&<section className={styles.outputOffer}><h2>想完整表达自己的想法吗？</h2><p>可以看中文练一次，也可以直接试试不看提示的回答。都是可选的。</p><div className={styles.row}><button className="secondary-button" onClick={()=>setCoaching({card:view.cards[0],mode:'answer_guided'})}>看中文，完整表达一次</button><button className="secondary-button" onClick={()=>setCoaching({card:view.cards[0],mode:'answer_independent'})}>不看提示，独立回答</button></div></section>}
    {!coaching&&<dialog ref={previousDialog} className={styles.previousPanel} aria-label="上一句与自评" onClose={()=>setPreviousOpen(false)}>{previousCard&&previous&&<><div className={styles.previousHeader}><h2>上一句</h2><button type="button" onClick={()=>setPreviousOpen(false)}>返回当前句</button></div><p>{previousCard.chinese}</p><SentenceReading card={previousCard}/><p>上次选择：{ratings.find(r=>r.value===previous.rating)?.label}。只有下方重选会调整复习时间。</p><div className={styles.ratings}>{ratings.map(rating=><button key={rating.value} type="button" disabled={blocked} aria-pressed={previous.rating===rating.value} onClick={()=>void apply({type:'revise_rating',targetEventId:previous.eventId,rating:rating.value}).then(()=>setPreviousOpen(false))}>{rating.label}</button>)}</div></>}</dialog>}
    </div>
  </div>;
}
