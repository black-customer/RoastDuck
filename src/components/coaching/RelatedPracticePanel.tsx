'use client';

import {useEffect,useRef,useState} from 'react';
import type {ContextPracticeTask,ContextPracticeCreate,RelatedQuestionCandidate} from '@/lib/context-practice/contracts';
import {CoachingPanel} from './CoachingPanel';
import styles from './RelatedPracticePanel.module.css';

interface Props {materialId:string;sourceSentenceIds?:string[];sourceSessionId?:string;onClose:()=>void}
interface Overview {tasks:ContextPracticeTask[];candidates:RelatedQuestionCandidate[];generationAvailable:boolean}
export function RelatedPracticePanel({materialId,sourceSentenceIds,sourceSessionId,onClose}:Props){
  const [overview,setOverview]=useState<Overview|null>(null),[task,setTask]=useState<ContextPracticeTask|null>(null),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const request=useRef<ContextPracticeCreate|null>(null),alive=useRef(true),key='roastduck_related_request:'+materialId;
  async function load(){setLoading(true);try{const r=await fetch('/api/context-practice?'+new URLSearchParams({materialId}),{cache:'no-store'}),data=await r.json();if(!r.ok)throw new Error(data.error??'相关题目暂未读取');if(alive.current)setOverview(data);}catch(e){if(alive.current)setError(e instanceof Error?e.message:'相关题目读取失败')}finally{if(alive.current)setLoading(false)}}
  useEffect(()=>{alive.current=true;try{const raw=localStorage.getItem(key);if(raw)request.current=JSON.parse(raw)}catch{/* Server retains previously created task receipts. */}void load();return()=>{alive.current=false};
  // The source material pins task history; source target changes do not recreate stored tasks.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[materialId]);
  async function create(origin:'bank'|'teacher_generated',questionId?:string){
    if(busy)return;setBusy(true);setError('');
    try{
      if(!request.current){request.current={clientRequestId:crypto.randomUUID(),materialId,origin,questionId,sourceSentenceIds};localStorage.setItem(key,JSON.stringify(request.current));}
      const r=await fetch('/api/context-practice',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'create',...request.current})}),data=await r.json();if(!r.ok)throw new Error(data.error??'问题还没准备完成');
      if(alive.current){setTask(data.task);request.current=null;localStorage.removeItem(key);}
    }catch(e){if(alive.current){setError(e instanceof Error?e.message:'本次请求未确认，原请求编号已保留');void load();}}finally{if(alive.current)setBusy(false)}
  }
  async function resume(value:ContextPracticeTask,retryUnknown=false){
    if(value.status==='ready'||value.status==='completed'){setTask(value);return}if(busy)return;
    setBusy(true);setError('');try{const r=await fetch('/api/context-practice',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'retry',taskId:value.id,retryUnknown})}),data=await r.json();if(!r.ok)throw new Error(data.error??'尚未完成问题准备');setTask(data.task);request.current=null;localStorage.removeItem(key);}catch(e){setError(e instanceof Error?e.message:'暂未完成');void load();}finally{setBusy(false)}
  }
  if(task)return <section className={styles.panel}><header><div><h1>换个问题，用自己的话说</h1><p>{task.origin==='teacher_generated'?'老师的追问，不是题库原题':'同话题题库练习'} · 不要求复述旧答案</p></div><button onClick={()=>setTask(null)}>换一道／返回选择</button></header><CoachingPanel key={task.id} materialId={materialId} questionId={task.questionId??undefined} audioQuestionId={task.questionId??task.sourceQuestionId??undefined} mode="answer_independent" relatedTaskId={task.id} rootPracticeId={sourceSessionId??task.id} sourceSessionId={sourceSessionId} onClose={onClose} onNext={onClose}/></section>;
  return <section className={styles.panel}><header><div><h1>换个相关问题试试</h1><p>可选练习。用自己的观点回答，没用到旧表达不等于答错。</p></div><button onClick={onClose}>今天先到这里</button></header>
    {error?<div className={styles.error} role="alert"><p>{error}</p><button onClick={()=>void load()}>重新读取</button>{request.current?<button disabled={busy} onClick={()=>void create(request.current!.origin,request.current!.questionId)}>确认原请求</button>:null}</div>:null}
    {loading?<p role="status">正在读取同话题题目…</p>:null}
    {overview?<><div className={styles.candidates}>{overview.candidates.map(q=><article key={q.questionId}><div><span>{q.topic}</span><h2 lang="en">{q.promptEn}</h2>{q.promptZh?<p>{q.promptZh}</p>:null}</div><button className="primary-button" disabled={busy} onClick={()=>void create('bank',q.questionId)}>试着回答</button></article>)}</div>
      {!overview.candidates.length?<p className={styles.notice}>暂时没有已登记为同话题的其他题目，不会硬配一题当作迁移验证。</p>:null}
      <section className={styles.generate}><h2>也可以请老师追问一句</h2><p>围绕当前表达准备一个新问题。此操作使用文本 API，不会提前给出答案。</p>{overview.generationAvailable?<button className="secondary-button" disabled={busy} onClick={()=>void create('teacher_generated')}>{busy?'正在准备…':'请老师出一个相关问题'}</button>:<a href="/settings">配置文本服务后再使用</a>}</section>
      {overview.tasks.length?<details><summary>继续已有的相关练习</summary>{overview.tasks.map(t=><article className={styles.history} key={t.id}><div><p>{t.promptEn||'尚未完成的新问题'}</p><span>{t.origin==='teacher_generated'?'老师追问':'题库练习'} · {new Date(t.createdAt).toLocaleString('zh-CN')}</span></div><button disabled={busy} onClick={()=>void resume(t)}>继续</button>{t.errorCode==='result_unknown'?<button disabled={busy} onClick={()=>{if(window.confirm('上一请求结果未知。重新请求可能再次使用文本余额，是否继续？'))void resume(t,true)}}>确认重新请求</button>:null}</article>)}</details>:null}
    </>:null}
  </section>;
}
