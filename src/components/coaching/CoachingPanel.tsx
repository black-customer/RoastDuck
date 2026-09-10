'use client';
import {useEffect,useId,useRef,useState} from 'react';
import type {CoachingContext,CoachingMode,CoachingSubmit,CoachingView} from '@/lib/coaching/contracts';
import styles from './CoachingPanel.module.css';

export interface CoachingPanelProps {materialId:string;sentenceId?:string;questionId?:string;mode:CoachingMode;onNext?:()=>void;onClose?:()=>void}
type Receipt=Pick<CoachingSubmit,'context'|'clientMessageId'|'text'|'correctionHint'>;
type Failure={message:string;code?:string};
const titles:Record<CoachingMode,string>={sentence_guided:'再表达一次',answer_guided:'把整道题串起来说',answer_independent:'不看提示，独立回答'};
export function CoachingPanel(props:CoachingPanelProps){return <CoachingSession key={[props.materialId,props.sentenceId??'',props.mode].join(':')} {...props}/>;}
function CoachingSession({materialId,sentenceId,questionId,mode,onNext,onClose}:CoachingPanelProps){
  const key=['roastduck-coaching-v1',materialId,sentenceId??'',mode].join(':'),inputId=useId();
  const [context,setContext]=useState<CoachingContext|null>(null),[view,setView]=useState<CoachingView|null>(null),[draft,setDraft]=useState('');
  const [receipt,setReceipt]=useState<Receipt|null>(null),[busy,setBusy]=useState(false),[loading,setLoading]=useState(true),[error,setError]=useState<Failure|null>(null),[correction,setCorrection]=useState(false);
  const [reviewBusy,setReviewBusy]=useState(false),[reviewError,setReviewError]=useState<Failure|null>(null);
  const alive=useRef(true),input=useRef<HTMLTextAreaElement>(null),messages=useRef<HTMLDivElement>(null);
  useEffect(()=>{alive.current=true;try{
    const stored=localStorage.getItem(key),record=stored?JSON.parse(stored) as {practiceId:string;draft?:string;receipt?:Receipt}:null;
    const current={materialId,sentenceId,questionId,mode,practiceId:record?.practiceId??crypto.randomUUID()};
    setContext(current);setDraft(record?.draft??'');setReceipt(record?.receipt??null);
    if(!stored)localStorage.setItem(key,JSON.stringify({practiceId:current.practiceId,draft:''}));
  }catch{setError({message:'浏览器暂时不能保存练习草稿。请保留文字，恢复本机存储后再提交。'});setLoading(false);}
  return ()=>{alive.current=false;};},[key,materialId,sentenceId,questionId,mode]);
  function persist(text:string,nextReceipt:Receipt|null){
    if(!context)throw new Error('练习还没有准备好');
    localStorage.setItem(key,JSON.stringify({practiceId:context.practiceId,draft:text,receipt:nextReceipt}));
  }
  async function read(c:CoachingContext,signal?:AbortSignal){
    const params=new URLSearchParams(Object.entries(c).filter(([,v])=>v!==undefined) as [string,string][]),response=await fetch('/api/coaching?'+params,{signal,cache:'no-store'});
    const body=await response.json();if(!response.ok)throw new Error(body.error??'练习暂时未能读取');
    if(!alive.current||signal?.aborted)return;
    const result=body as CoachingView;setView(result);
    const pending=result.messages.find(m=>m.role==='user'&&['failed','pending'].includes(m.status));
    if(pending){setReceipt({context:c,clientMessageId:pending.clientMessageId,text:pending.text,correctionHint:pending.correctionHint??false});setError({message:'你的表达已经保存，老师回复还未完成。可以恢复回复，也可以跳过。',code:pending.errorCode});}
    else{
      const stored=localStorage.getItem(key),record=stored?JSON.parse(stored) as {receipt?:Receipt;draft?:string}:null;
      if(record?.receipt&&result.messages.some(m=>m.role==='user'&&m.clientMessageId===record.receipt!.clientMessageId&&['completed','skipped'].includes(m.status))){
        localStorage.setItem(key,JSON.stringify({practiceId:c.practiceId,draft:''}));setReceipt(null);setDraft('');setError(null);
      }
    }
  }
  useEffect(()=>{if(!context)return;const controller=new AbortController();setLoading(true);
    void read(context,controller.signal).catch(reason=>{if(!controller.signal.aborted&&alive.current)setError({message:reason instanceof Error?reason.message:'无法恢复练习'});}).finally(()=>{if(!controller.signal.aborted&&alive.current)setLoading(false);});
    return ()=>controller.abort();
    // Context changes only when this keyed practice is initialised.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[context]);
  useEffect(()=>{messages.current?.scrollTo({top:messages.current.scrollHeight,behavior:'auto'});},[view?.messages.length,busy]);
  function changeDraft(text:string){setDraft(text);try{persist(text,receipt);}catch{setError({message:'草稿尚未保存，请保留文字并检查浏览器存储。'});}}
  async function send(retry=false,retryUnknown=false){
    if(busy||!context)return;
    const task=retry?receipt:{context,clientMessageId:crypto.randomUUID(),text:draft.trim(),correctionHint:correction};
    if(!task?.text)return;
    try{persist(draft,task);}catch{setError({message:'草稿尚未保存，本次没有发送。请先恢复浏览器存储。'});return;}
    setReceipt(task);setBusy(true);setError(null);
    try{
      const response=await fetch('/api/coaching/messages',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...task,retryFailed:retry,retryUnknown})});
      const body=await response.json();if(!response.ok){
        if(response.status===400&&alive.current){setReceipt(null);persist(draft,null);}
        const failure=new Error(body.error??'回复暂时未完成') as Error&{code?:string};failure.code=body.code;throw failure;}
      if(!alive.current)return;
      setView(body);setDraft('');setReceipt(null);setCorrection(false);
      try{persist('',null);}catch{setError({message:'表达和回复已保存在服务器；浏览器草稿清理失败，刷新可恢复。'});}
      input.current?.focus();
    }catch(reason){if(!alive.current)return;const e=reason as Error&{code?:string};setError({message:e.message||'网络中断，输入仍保留。请恢复回复，不要重复新建回答。',code:e.code});
      // Pure read can recover a response whose POST acknowledgement was lost.
      await read(context).catch(()=>undefined);
    }finally{if(alive.current)setBusy(false);}
  }
  async function next(){
    if(busy)return;
    if(receipt&&context){setBusy(true);try{
      const response=await fetch('/api/coaching',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({action:'skip',context,clientMessageId:receipt.clientMessageId})});
      if(!response.ok)throw new Error((await response.json()).error??'跳过暂未保存，请稍后重试');
    }catch(e){setError({message:e instanceof Error?e.message:'暂时无法继续'});setBusy(false);return;}}
    try{localStorage.removeItem(key);}catch{/* Completed server history remains authoritative. */}
    onNext?.();setBusy(false);
  }
  function tryAgain(){setCorrection(true);setDraft('');try{persist('',null);}catch{/* Next send still gates on persistence. */}input.current?.focus();}
  async function retryReviews(retryUnknown=false){
    if(!context||reviewBusy)return;setReviewBusy(true);setReviewError(null);
    try{const response=await fetch('/api/coaching',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({action:'retry_reviews',context,retryUnknown})});
      const body=await response.json();if(!alive.current)return;
      if(!response.ok){setReviewError({message:body.error??'问题核对暂时未完成',code:body.code});return;}
      setView(body);
    }catch{if(alive.current)setReviewError({message:'问题核对未完成，原输出和反馈均已保存。'});}finally{if(alive.current)setReviewBusy(false);}
  }
  const latestFeedback=view?.messages.findLast(m=>m.feedback)?.feedback;
  function freshIndependent(){if(busy||receipt||!context)return;const next={...context,practiceId:crypto.randomUUID()};try{localStorage.setItem(key,JSON.stringify({practiceId:next.practiceId,draft:''}));setView(null);setDraft('');setCorrection(false);setError(null);setContext(next);}catch{setError({message:'新练习尚未保存，原练习仍保留。请恢复浏览器存储后再试。'});}}
  return <section className={styles.panel} aria-labelledby={`${inputId}-title`}>
    <header className={styles.header}><div><h2 id={`${inputId}-title`}>{titles[mode]}</h2><p>和 Chloe 练习 · 可以修正，也可以随时继续</p></div>{onClose?<button type="button" className={styles.close} onClick={onClose} aria-label="关闭表达练习"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button>:null}</header>
    {loading?<p className={styles.status} role="status">正在恢复本次练习…</p>:null}
    {mode==='answer_independent'&&view?.messages.length&&!receipt?<button type="button" className="secondary-button" disabled={busy} onClick={freshIndependent}>重新开始一次无提示回答</button>:null}
    {view?<div className={styles.task}><p lang="en">{view.questionEn}</p>{mode!=='answer_independent'&&view.chinese?<p className={styles.cue}>{view.chinese}</p>:<p className={styles.hint}>只看题目，用自己的话回答。提交后再看反馈。</p>}</div>:null}
    <div className={styles.messages} ref={messages} role="log" aria-label="与 Chloe 的练习记录" aria-live="polite">
      {view?.messages.map(message=><article className={message.role==='user'?styles.user:styles.teacher} key={message.id}><span className={styles.speaker}>{message.role==='user'?'你的表达':'Chloe'}</span><p>{message.text}</p>
        {message.feedback?.messages[0]?.translationZh?<p className={styles.translation}>{message.feedback.messages[0].translationZh}</p>:null}
        {message.feedback?.findings.length?<details><summary>查看这次反馈的依据</summary>{message.feedback.findings.map((finding,index)=><div className={styles.finding} key={index}><p><q>{finding.sourceQuote}</q> → {finding.correction}</p><p>{finding.kind==='style_suggestion'?'表达建议：':finding.kind==='uncertain'?'待确认：':'需要注意：'}{finding.explanationZh}</p></div>)}</details>:null}
        {message.role==='user'&&message.status==='skipped'?<small>已跳过反馈，原话保留</small>:null}</article>)}
      {busy?<p className={styles.status} role="status">正在保存表达并准备反馈…</p>:null}
    </div>
    {error?<div className={styles.error} role="alert"><p>{error.message}</p>{receipt?<button type="button" disabled={busy} onClick={()=>void send(true,false)}>恢复回复</button>:context?<button type="button" onClick={()=>void read(context).catch(e=>setError({message:String(e)}))}>重新读取</button>:null}{receipt&&error.code==='result_unknown'?<button type="button" disabled={busy} onClick={()=>void send(true,true)}>确认重新请求（可能再次计费）</button>:null}</div>:null}
    <div className={styles.composer}>
      {latestFeedback&&!receipt?<div className={styles.feedbackActions}><span>{latestFeedback.extent==='local_correction'?'这是对本次局部修正的反馈':latestFeedback.verdict==='natural'?'本次表达自然，仍可以尝试自己的说法':'可以改一句，也可以继续学习'}</span><button type="button" onClick={tryAgain}>再试一次</button></div>:null}
      <label htmlFor={inputId}>{correction?'想修正哪一句？':'你的英文表达'}</label>
      <textarea id={inputId} ref={input} value={draft} onChange={e=>changeDraft(e.target.value)} rows={mode==='sentence_guided'?3:5} disabled={busy||!!receipt||!context} placeholder={correction?'可以说“刚才那句话我想改成……”':'直接表达；也可以用中文补充说明。'} maxLength={12000}/>
      <p className={styles.hint}>可以打字，或使用 Win + H／输入法听写。这里不会申请麦克风权限。</p>
      <div className={styles.actions}><button type="button" className="primary-button" disabled={busy||loading||!!receipt||!draft.trim()||!view} onClick={()=>void send()}>发送给 Chloe</button>{onNext?<button type="button" className="secondary-button" disabled={busy} onClick={()=>void next()}>{mode==='sentence_guided'?'下一句':mode==='answer_guided'?'不看提示，再回答一次':'结束本次练习'}</button>:null}{mode==='answer_guided'&&onClose?<button type="button" className="secondary-button" onClick={onClose}>今天先到这里</button>:null}</div>
      {view?.pendingMemoryJobs?<details className={styles.reviewStatus}><summary>学习记忆正在核对，不影响继续练习</summary><p className={styles.hint}>确认的问题会加入学习记忆，原回答和反馈已保留。</p><button type="button" disabled={reviewBusy} onClick={()=>void retryReviews()}>{reviewBusy?'核对中…':'恢复问题核对'}</button></details>:null}
      {reviewError?<div className={styles.hint} role="status"><p>{reviewError.message}</p>{reviewError.code==='result_unknown'?<button type="button" disabled={reviewBusy} onClick={()=>void retryReviews(true)}>确认重新核对（可能再次计费）</button>:null}</div>:null}
      <a href="/companion-memories" className={styles.memoryLink}>查看或撤销 Chloe 的学习记忆</a>
    </div>
  </section>;
}
