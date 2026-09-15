'use client';

import Link from 'next/link';
import {useEffect,useRef,useState} from 'react';
import {useRouter} from 'next/navigation';
import {SentenceController,type SentenceAction,type SentenceClientState} from '@/lib/sentence-study/client';
import {emptySentencePractice,sentencePracticeKey,type SentenceCard,type SentenceCreate,type SentenceRating} from '@/lib/sentence-study/contracts';
import {LightAudioPlayer,type LightAudioState} from '@/lib/light-study/audio';
import {createBrowserSpeechProvider} from '@/lib/tts';
import {getSpeechPreferences,legacyPresetFor,subscribeSpeechPreferences} from '@/lib/speech/preferences';
import {BrandMark,Icon} from '@/components/ui/Icon';
import {SpeechPreferences} from '@/components/SpeechPreferences';
import {CoachingPanel,type CoachingPanelProps} from '@/components/coaching/CoachingPanel';
import {GuidedReveal} from './GuidedReveal';
import {HighlightText} from './HighlightText';
import {SentenceTeaching} from './SentenceTeaching';
import {RelatedPracticePanel} from '@/components/coaching/RelatedPracticePanel';
import styles from './ContextWorkspace.module.css';

type Props={sessionId?:string;input:SentenceCreate;initialError?:string;resumeOnLoad?:boolean};
type Drawer='teaching'|'grade'|'draft'|'settings'|null;
type Coach={mode:CoachingPanelProps['mode'];card:SentenceCard;initialDraft?:string};
const initial:SentenceClientState={view:null,pending:0,saving:false,error:null,loading:true,conflict:false};
const ratings:Array<{value:SentenceRating;label:string;hint:string}>=[
  {value:'remembered',label:'脱口而出',hint:'自己顺畅、自然地表达出来'},
  {value:'uncertain',label:'想出来了',hint:'花了时间，但自己想对了'},
  {value:'forgot',label:'遇到卡壳',hint:'至少一个意思需要提示帮助'},
];

/** One continuous context. The controller owns evidence and scheduling; navigation never implies a grade. */
export function ContextWorkspace({sessionId,input,initialError,resumeOnLoad=false}:Props){
  const router=useRouter(),manager=useRef<SentenceController|null>(null),player=useRef<LightAudioPlayer|null>(null);
  const mounted=useRef(true),playingCard=useRef<{card:SentenceCard;recorded:boolean}|null>(null),restored=useRef(''),revealPlayed=useRef('');
  const drawerRef=useRef<HTMLElement|null>(null),drawerReturnFocus=useRef<HTMLElement|null>(null);
  const [state,setState]=useState(initial),[reload,setReload]=useState(0),[drawer,setDrawer]=useState<Drawer>(null);
  const [speech,setSpeech]=useState(getSpeechPreferences),[autoPlay,setAutoPlay]=useState(true),[sound,setSound]=useState<LightAudioState>({phase:'idle',provider:null,message:''});
  const [localError,setLocalError]=useState(''),[summary,setSummary]=useState(false),[coach,setCoach]=useState<Coach|null>(null),[related,setRelated]=useState(false);
  const [editingRating,setEditingRating]=useState(false),[localRating,setLocalRating]=useState<{key:string;attempt:number;rating:SentenceRating}|null>(null);
  const initKey=JSON.stringify(input),view=state.view,card=view?.cards.find(c=>c.id===view.focusId)??view?.cards[view.index]??null;
  const practice=card&&view?view.practiceByUnit?.[sentencePracticeKey(card)]??{...(view.practice??emptySentencePractice()),stage:view.stage??'recall'}:null;
  const stage=practice?.stage??'recall',visible=['teaching','rated','retry_reveal'].includes(stage),source=view?.cards[0]?.source;
  const blocked=state.loading||state.conflict||!!state.error;
  const assessment=view?.assessments.findLast(a=>a.sentenceId===card?.id);
  const currentRating=localRating&&card&&localRating.key===sentencePracticeKey(card)&&localRating.attempt===practice?.retryAttempt?localRating.rating:assessment?.rating;
  const currentIndex=view?.cards.findIndex(c=>c.id===card?.id)??0;
  const next=view?.cards.slice(currentIndex+1).find(c=>!c.unavailable)??null;
  const isTarget=Boolean(card&&view?.targetIds?.includes(card.id));
  const unconfirmed=state.pending>0||state.saving||state.conflict||!!state.error;

  useEffect(()=>{
    mounted.current=true;const c=new SentenceController();manager.current=c;const unsubscribe=c.subscribe(()=>{if(mounted.current)setState(c.getSnapshot())});
    if(initialError)setState({...initial,loading:false,error:initialError});
    else if(sessionId)void c.load(sessionId).then(()=>{const s=c.getSnapshot();if(resumeOnLoad&&!s.error&&s.view?.status==='paused')void c.apply({type:'resume'});});
    else void c.start({...JSON.parse(initKey),experienceVersion:'context-workspace-v1'} as SentenceCreate);
    return()=>{mounted.current=false;unsubscribe();c.dispose();manager.current=null;};
  },[sessionId,initKey,initialError,resumeOnLoad,reload]);

  useEffect(()=>{
    const p=new LightAudioPlayer(createBrowserSpeechProvider(),value=>{
      if(!mounted.current)return;setSound(value);
      const current=playingCard.current,live=manager.current?.getSnapshot().view;
      // Quick speech may first announce its preparation; wait for the actual voice-start state.
      if(value.phase==='playing'&&(value.provider==='mimo'||!!value.voice)&&current&&!current.recorded&&live?.status==='active'&&(live.focusId??live.cards[live.index]?.id)===current.card.id){
        current.recorded=true;const controller=manager.current;
        void (async()=>{await controller?.flushPractice();const latest=controller?.getSnapshot().view;if(playingCard.current!==current||latest?.status!=='active'||latest.focusId!==current.card.id)return;await controller?.apply({type:'exposure',source:'audio',sentenceId:current.card.id,unitVersion:current.card.version})})().catch(()=>{});
      }
    });player.current=p;setSpeech(getSpeechPreferences());const unsub=subscribeSpeechPreferences(setSpeech);
    const stop=()=>{playingCard.current=null;p.stop();};window.addEventListener('roastduck:stop-all-audio',stop);
    const controller=new AbortController();void fetch('/api/settings',{signal:controller.signal}).then(r=>r.ok?r.json():null).then(data=>{if(!controller.signal.aborted)setAutoPlay(data?.settings?.autoPlay??true)}).catch(()=>{});
    const hide=()=>{if(document.hidden){p.stop();void manager.current?.flushPractice().catch(()=>{})}};document.addEventListener('visibilitychange',hide);
    return()=>{controller.abort();unsub();p.dispose();player.current=null;window.removeEventListener('roastduck:stop-all-audio',stop);document.removeEventListener('visibilitychange',hide)};
  },[]);

  useEffect(()=>{if(view?.id){const u=new URL(window.location.href);u.searchParams.set('session',view.id);window.history.replaceState(null,'',u);}},[view?.id]);
  useEffect(()=>{
    if(!view||!card)return;const key=view.id+':'+sentencePracticeKey(card);
    if(restored.current!==key){restored.current=key;setEditingRating(false);}
    const expanded=practice?.expanded;setDrawer(['teaching','grade','draft','settings'].includes(expanded??'')?expanded as Drawer:null);
  },[view,card,practice?.expanded]);
  useEffect(()=>{
    if(!drawer||coach||related||summary)return;
    const panel=drawerRef.current;if(!panel)return;
    // Focus moves only when the panel opens; acknowledgements and typing never steal it.
    if(!panel.contains(document.activeElement)){drawerReturnFocus.current=document.activeElement as HTMLElement|null;panel.querySelector<HTMLElement>('textarea,input,button')?.focus({preventScroll:true});}
  },[drawer,coach,related,summary]);

  useEffect(()=>{
    const p=player.current;if(!p)return;p.stop();
    const make=(c:SentenceCard|null)=>c&&!c.unavailable?{text:c.english,voice:speech.voice,accent:speech.accent,voiceId:legacyPresetFor(speech),style:c.source.questionId?'ielts-answer' as const:'daily-conversation' as const,playbackMode:'natural' as const}:null;
    const current=make(card),upcoming=make(next);p.prime(current,upcoming,autoPlay&&!document.hidden&&!coach&&!related&&!summary&&view?.status==='active');
    const key=`${view?.id}:${card?.id}:${card?.version}:${practice?.retryAttempt}`;
    if(visible&&card&&current&&autoPlay&&!coach&&!related&&!summary&&view?.status==='active'&&revealPlayed.current!==key){revealPlayed.current=key;playingCard.current={card,recorded:false};void p.play(current);}
    return()=>p.stop();
  // Text and identity delimit playback ownership, not unrelated server acknowledgements.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[card?.id,card?.version,card?.english,card?.unavailable,next?.id,next?.english,visible,practice?.retryAttempt,speech.voice,speech.accent,autoPlay,coach,related,summary,view?.status,view?.id]);

  async function apply(action:SentenceAction){setLocalError('');try{return await manager.current?.apply(action)??false}catch(e){setLocalError(e instanceof Error?e.message:'尚未保存，请重试');return false}}
  async function focus(c:SentenceCard){if(c.unavailable||blocked||!view)return false;playingCard.current=null;player.current?.stop();if(view.status==='paused'&&!await apply({type:'resume'}))return false;return apply({type:'focus',sentenceId:c.id,unitVersion:c.version});}
  async function persistDrawer(value:Drawer,target=card){
    const controller=manager.current;if(!target||!controller||blocked)return false;
    await controller.flushPractice();const latest=controller.getSnapshot(),v=latest.view,c=v?.cards[v.index],p=v?.practice;
    if(!v||!c||!p||latest.error||latest.conflict||c.id!==target.id||c.version!==target.version)return false;
    const accepted=await apply({type:'checkpoint',revealCount:p.revealCount,maxRevealCount:p.maxRevealCount,draft:p.draft,retryDraft:p.retryDraft,expanded:value,sentenceId:c.id,unitVersion:c.version});
    if(!accepted||controller.getSnapshot().view?.focusId!==target.id)return false;
    setDrawer(value);if(!value){drawerReturnFocus.current?.focus({preventScroll:true});drawerReturnFocus.current=null;}
    return true;
  }
  async function teach(c=card){if(!c||blocked)return;if(c.id!==card?.id&&!await focus(c))return;if(manager.current?.getSnapshot().view?.focusId!==c.id)return;if(await apply({type:'enter_teaching',sentenceId:c.id,unitVersion:c.version}))await persistDrawer('teaching',c);}
  function update(patch:{revealCount?:number;draft?:string;retryDraft?:string}){try{manager.current?.updatePractice(patch)}catch(e){setLocalError(e instanceof Error?e.message:'本机保存失败，请保留输入')}}
  function flush(){void manager.current?.flushPractice().catch(e=>setLocalError(e instanceof Error?e.message:'输入尚未同步'))}
  async function retry(){const target=card;if(!target)return;playingCard.current=null;player.current?.stop();if(await persistDrawer(null,target))await apply({type:'start_retry',sentenceId:target.id,unitVersion:target.version});}
  async function grade(rating:SentenceRating){
    if(!card||blocked)return;let accepted=false;
    if(assessment&&isTarget){if(!editingRating||view?.lastRatingEventId!==assessment.eventId)return;accepted=await apply({type:'revise_rating',rating,targetEventId:assessment.eventId});}
    else accepted=await apply({type:'rate',rating,sentenceId:card.id,unitVersion:card.version});
    if(accepted){setEditingRating(false);setLocalRating(isTarget?null:{key:sentencePracticeKey(card),attempt:practice?.retryAttempt??0,rating});}
  }
  async function openGrade(){const target=card;if(!target||blocked)return;if(!visible&&!await apply({type:stage==='retry'?'reveal_retry':'enter_teaching',sentenceId:target.id,unitVersion:target.version}))return;await persistDrawer('grade',target);}
  async function leave(to?:string){player.current?.stop();if(view?.status==='active'&&!await apply({type:'pause'}))return;if(to)router.push(to);else{setDrawer(null);setSummary(true)}}
  function play(quick=false){if(!card||card.unavailable||!visible||blocked)return;playingCard.current={card,recorded:false};void player.current?.play({text:card.english,voice:speech.voice,accent:speech.accent,voiceId:legacyPresetFor(speech),style:card.source.questionId?'ielts-answer':'daily-conversation',playbackMode:quick?'quick':'natural'});}
  async function openCoach(mode:Coach['mode']){const target=card;if(!target||blocked)return;playingCard.current=null;player.current?.stop();if(view?.status==='active'&&!await persistDrawer(null,target))return;await manager.current?.flushPractice();setCoach({mode,card:target,initialDraft:mode==='sentence_guided'?practice?.retryDraft:undefined});setDrawer(null)}
  async function setAutoplay(value:boolean){setAutoPlay(value);try{const r=await fetch('/api/settings',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({autoPlay:value})});if(!r.ok)throw new Error('自动播放设置尚未保存')}catch(e){setLocalError(e instanceof Error?e.message:'设置未保存')}}

  const header=<header className={styles.header}><Link href="/" className={styles.brand} onClick={e=>{e.preventDefault();void leave('/')}}><BrandMark/><span>鱼块学英语</span></Link><span className={styles.headerContext}>{view?.mode==='review'?'在语境里复习':'把自己的意思说出来'}</span><button className={styles.quiet} onClick={()=>void persistDrawer(drawer==='settings'?null:'settings')}><Icon name="settings"/>设置</button></header>;
  if(coach)return <div data-sentence-focus="true" className={styles.shell}>{header}<div className={styles.coaching}><CoachingPanel materialId={coach.card.materialId} sentenceId={coach.mode==='sentence_guided'?coach.card.id:undefined} questionId={coach.card.source.questionId??undefined} mode={coach.mode} initialDraft={coach.initialDraft} sourceSessionId={view?.id} rootPracticeId={view?.id} onClose={()=>setCoach(null)} onNext={()=>{if(coach.mode==='answer_guided')setCoach({...coach,mode:'answer_independent',initialDraft:undefined});else setCoach(null)}}/></div></div>;
  if(related&&card)return <div data-sentence-focus="true" className={styles.shell}>{header}<div className={styles.coaching}><RelatedPracticePanel materialId={card.materialId} sourceSentenceIds={[card.id]} sourceSessionId={view?.id} onClose={()=>setRelated(false)}/></div></div>;
  const failure=state.error||localError;
  return <div data-sentence-focus="true" className={styles.shell}>{header}<div className={`${styles.main} ${drawer?styles.withDrawer:''}`}>
    {state.loading?<section className={styles.empty} role="status"><h1>正在打开这份回答…</h1><p>恢复原来的位置与草稿。</p></section>:null}
    {failure?<div className={styles.error} role="alert"><p>{failure}</p><button onClick={()=>{setLocalError('');if(manager.current?.getSnapshot().view)void manager.current.retry();else setReload(n=>n+1)}}>重试确认</button><Link href="/study?mode=learn&choose=questions">返回选题</Link></div>:null}
    {view?.notice?<p className={styles.notice} role="status">{view.notice}</p>:null}
    {unconfirmed?<p className={styles.notice} role="status">{state.error||state.conflict?'部分操作仍待确认；本机记录已保留，可重试恢复。':`正在保存${state.pending?` ${state.pending} 项操作`:''}，服务端尚未确认。`}</p>:null}
    {!state.loading&&view&&!view.cards.length?<section className={styles.empty}><h1>这份材料暂时没有可学内容</h1><p>可能已撤销或正在更新，原学习记录仍然保留。</p><Link className="primary-button" href={`/study?mode=${view.mode}&choose=questions`}>换一道题</Link></section>:null}
    {view&&card&&(summary||view.status==='paused'||view.status==='completed')?<section className={styles.summary}>
      <h1>{unconfirmed?'先停在这里，保存仍待确认':summary?'今天先到这里，也很好。':view.status==='completed'?'本次练习记录已保留':'上次停在这里'}</h1><p className={styles.lead}>{source?.title}</p>
      <dl><div><dt>完整回答</dt><dd>{view.cards.length} 句，原顺序保留</dd></div><div><dt>这次正式自评</dt><dd>{view.assessments.length} 句{unconfirmed?'，保存待确认':''}；接触和再练不冒充掌握</dd></div><div><dt>下次复习</dt><dd>{unconfirmed?'保存确认后显示最新安排':view.nextDueAt?new Date(view.nextDueAt).toLocaleString('zh-CN'):'未自评的首次接触约24小时后再回想'}</dd></div></dl>
      <div className={styles.actions}><button className="primary-button" onClick={async()=>{if(await apply({type:'resume'}))setSummary(false)}}>继续这份回答</button><Link className="secondary-button" href={`/study?mode=${view.mode}&choose=questions`}>换一道题</Link><Link className="secondary-button" href="/">返回首页</Link></div>
      <div className={styles.actions}><button onClick={()=>openCoach('answer_guided')}>把整题串起来说</button><button onClick={()=>setRelated(true)}>换个相关问题试试</button>{source?.questionId&&<Link href={`/answer-history/${encodeURIComponent(source.questionId)}`}>我的回答录音</Link>}</div>
      {view.lastRatingEventId&&<details><summary>修改最近一次自评</summary><div className={styles.ratings}>{ratings.map(r=><button key={r.value} onClick={()=>void apply({type:'revise_rating',rating:r.value,targetEventId:view.lastRatingEventId!})}>{r.label}</button>)}</div></details>}
      <details><summary>回到回答中的某一句</summary>{view.cards.filter(c=>!c.unavailable).map(c=><div key={c.id} className={styles.summarySentence}><p>{c.chinese}</p><button disabled={blocked} onClick={async()=>{if(await focus(c))setSummary(false)}}>回到第 {c.ordinal+1} 句</button></div>)}</details>
    </section>:null}
    {view&&card&&!summary&&view.status==='active'?<>
      <div className={styles.workHead}><div><h1>{source?.title||'我的完整回答'}</h1><p>完整回答 · {view.cards.length} 句 <span>本次待回想 {view.targetIds?.filter(id=>!view.assessments.some(item=>item.sentenceId===id)).length??0} 句</span></p></div><div className={styles.actions}><button onClick={()=>void leave(`/study?mode=${view.mode}&choose=questions`)}><Icon name="arrow"/>暂停并换题</button><button className={styles.quiet} onClick={()=>void leave()}>今天先到这里</button></div></div>
      <div className={styles.aligned}><div className={styles.columnHead}><span>我想表达的意思</span><span>自然英文 · 需要时再揭晓</span></div>
        {view.cards.map((c,i)=>{
          const active=c.id===card.id,p=view.practiceByUnit?.[sentencePracticeKey(c)]??{...emptySentencePractice(),stage:'recall' as const};
          const shown=['teaching','rated','retry_reveal'].includes(p.stage),target=view.targetIds?.includes(c.id);
          return <section key={sentencePracticeKey(c)} id={`sentence-${c.id}`} data-sentence-id={c.id} data-stage={p.stage} data-target={!!target} className={`${styles.sentence} ${active?styles.current:''}`} aria-label={`第 ${i+1} 句`}>
            <div className={styles.meaning}><button className={styles.choose} aria-pressed={active} disabled={blocked||!!c.unavailable} onClick={()=>void focus(c)}>{i+1} / {view.cards.length}{!target?' · 上下文 / 回看':''}{c.preference?.hidden?' · 暂不学':''}</button>{c.unavailable?<p>{c.unavailable}</p>:<HighlightText card={c} language="zh" as="p" className={styles.chinese} initialHighlights={c.userHighlights}/>}</div>
            <div className={styles.expression}>{c.unavailable?<p className={styles.muted}>这句暂不作为示范。</p>:active?<>
              {stage==='retry'?<div className={styles.retry}><label htmlFor="context-retry">再用自己的话说一次（可留空）</label><textarea id="context-retry" rows={3} value={practice?.retryDraft??''} disabled={blocked} onChange={e=>update({retryDraft:e.target.value})} onBlur={flush} placeholder="可以打字或用输入法听写，不必逐字复述。"/><button className="primary-button" disabled={blocked} onClick={()=>void apply({type:'reveal_retry'})}>揭晓并对照</button><p>本地再练，不调用 AI，也不重复结算。</p></div>:<>
                {shown?<HighlightText card={c} language="en" as="p" className={styles.english} initialHighlights={c.userHighlights}/>:<GuidedReveal english={c.english} count={practice?.revealCount??0} disabled={blocked} compact onChange={count=>update({revealCount:count})} onCommit={flush}/>}
                {stage==='retry_reveal'&&practice?.retryDraft?<div className={styles.attempt}><span>我这次的尝试</span><p lang="en">{practice.retryDraft}</p><button onClick={()=>openCoach('sentence_guided')}>请老师看看（使用文本 API）</button></div>:null}
                <div className={styles.lineActions}>{!shown&&<button disabled={blocked} onClick={()=>void teach(c)}>看自然表达与讲解</button>}{shown&&<><button onClick={()=>play()} aria-label="播放本句自然声音"><Icon name="audio"/>听自然表达</button><button onClick={()=>void persistDrawer('teaching')}>这句怎么说</button><button disabled={blocked} onClick={()=>void retry()}>再练一遍</button></>}</div>
              </>}
            </>:<button className={styles.preview} onClick={()=>void focus(c)} disabled={blocked} aria-label={`在第 ${i+1} 句回想`}>{shown?<span lang="en">{c.english}</span>:<span className={styles.frostPreview} aria-hidden="true"/>}<span className={styles.previewHint}>点击在这里回想</span></button>}</div>
          </section>;
        })}
      </div>
      {sound.message&&sound.phase!=='idle'?<div className={styles.audioStatus} role="status"><span>{sound.message}</span>{sound.phase==='playing'?<button onClick={()=>player.current?.stop()}>停止</button>:['loading','error','blocked'].includes(sound.phase)?<button onClick={()=>play(true)}>先听快捷声音</button>:null}</div>:null}
      <footer className={styles.workbar}><span>可以求助、继续或停下。自然等价表达也可以。</span><div><button onClick={()=>void persistDrawer('draft')} disabled={blocked}>写下我的尝试</button><button onClick={()=>void openGrade()} disabled={blocked}>记录本句回想</button><button className="primary-button" onClick={()=>openCoach('answer_guided')}>试着完整说一遍</button></div></footer>
    </>:null}
  </div>{drawer&&card&&!coach&&!summary&&view?.status==='active'?<aside ref={drawerRef} className={styles.drawer} aria-label={drawer==='teaching'?'这句怎么说':drawer==='grade'?'记录本句回想':drawer==='settings'?'学习设置':'本句草稿'} onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();void persistDrawer(null)}}}><button className={styles.close} aria-label="关闭辅助面板" onClick={()=>void persistDrawer(null)}>×</button>
    {drawer==='teaching'?<><p className={styles.muted}>{card.chinese}</p><p className={styles.english} lang="en">{card.english}</p><button onClick={()=>play()}><Icon name="audio"/>听本句自然声音</button><SentenceTeaching card={card}/><div className={styles.actions}><button onClick={()=>void retry()}>藏起来，再试一句</button><button onClick={()=>openCoach('sentence_guided')}>问老师</button></div></>:null}
    {drawer==='grade'?<><h2>刚才怎样想起来的？</h2><p>评价揭晓前的回想。自然等价的表达，也可以。</p><div className={styles.ratings}>{ratings.map(r=><button key={r.value} disabled={blocked||!!assessment&&isTarget&&!editingRating} aria-pressed={currentRating===r.value} onClick={()=>void grade(r.value)}><strong>{r.label}</strong><span>{r.hint}</span></button>)}</div>{currentRating?<p className={styles.notice}>{unconfirmed?'本次操作已在本机保留，正在确认保存。':isTarget?'本次自评已记录，仍然留在原处。':'这次是上下文回看，未改变复习安排。'}</p>:null}<div className={styles.actions}><button onClick={()=>void retry()}>再练一遍</button><button className="primary-button" onClick={async()=>{if(!await persistDrawer(null))return;if(next){if(await focus(next))document.getElementById('sentence-'+next.id)?.scrollIntoView({behavior:'smooth',block:'center'})}else await leave()}}>继续往下看</button></div>{assessment&&view?.lastRatingEventId===assessment.eventId?<button className={styles.quiet} disabled={blocked} onClick={()=>setEditingRating(true)}>{editingRating?'选择正确的档位以更正':'修改本次自评'}</button>:null}</>:null}
    {drawer==='draft'?<><h2>写下正在组织的表达</h2><p>可留空，不会自动发给 AI。</p><textarea aria-label="我的本句尝试" rows={6} value={(stage==='retry'?practice?.retryDraft:practice?.draft)??''} disabled={blocked} onChange={e=>update(stage==='retry'?{retryDraft:e.target.value}:{draft:e.target.value})} onBlur={flush}/><button onClick={()=>void persistDrawer(null)}>保存并继续</button></>:null}
    {drawer==='settings'?<><h2>按自己的节奏学习</h2><label className={styles.check}><input type="checkbox" checked={autoPlay} onChange={e=>void setAutoplay(e.target.checked)}/>进入讲解后自动播放</label><SpeechPreferences compact/><Link href="/settings">全部声音与数据设置</Link></>:null}
  </aside>:null}</div>;
}
