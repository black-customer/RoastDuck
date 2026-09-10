'use client';
import Link from 'next/link';
import {useEffect,useId,useState} from 'react';
import type {LightScope} from '@/lib/light-study/contracts';
import {scopeQuery,expressionScopeTitle} from '@/lib/light-study/scope-links';
import type {ExpressionItem} from '@/components/ExpressionLibrary';
import {SpeakButton} from '@/components/SpeakButton';
import styles from './ExpressionCollection.module.css';

export function QuickReviewRow({item}:{item:ExpressionItem}){
  const [revealed,setRevealed]=useState(false),answerId=useId();
  return <article className={styles.row} aria-label={item.chinese}>
    <div className={styles.rowHeading}><div><h2>{item.chinese}</h2><p className={styles.state}>{item.preference.self_known?'已掌握（自评）':item.progress?'已学过':'尚未学习'}</p></div><button className={`secondary-button ${styles.revealButton}`} aria-expanded={revealed} aria-controls={answerId} onClick={()=>setRevealed(value=>!value)}>{revealed?'收起英文':'揭晓英文'}</button></div>
    <div className={styles.rowContent}><p>{item.sentenceZh}</p></div>
    <div id={answerId} className={revealed?styles.revealed:undefined}>{revealed&&<><div className={styles.answerLine}><p lang="en">{item.english}</p><SpeakButton text={item.english} style="short-expression" label="播放英文表达"/></div><div className={styles.answerLine}><p lang="en">{item.sentenceEn}</p><SpeakButton text={item.sentenceEn} style={item.questionId?'ielts-answer':'daily-conversation'} label="播放英文句子"/></div></>}</div>
  </article>;
}
export function QuickReview({scope}:{scope:LightScope}){
  const [items,setItems]=useState<ExpressionItem[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState(''),[retry,setRetry]=useState(0),query=scopeQuery(scope);
  useEffect(()=>{
    const controller=new AbortController();setLoading(true);setError('');
    void fetch(`/api/expressions?${query}`,{cache:'no-store',signal:controller.signal}).then(async response=>{const data=await response.json();if(!response.ok)throw new Error(data.error||'暂时无法读取表达');if(!controller.signal.aborted)setItems(data.items);}).catch(reason=>{if(!controller.signal.aborted)setError(reason instanceof Error?reason.message:'暂时无法读取表达');}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return()=>controller.abort();
  },[query,retry]);
  return <div className={`page-content ${styles.page}`}><Link className={styles.back} href={`/expressions?extension=1&${query}`}>返回{expressionScopeTitle(scope)}</Link><header className={styles.header}><h1>快速回顾</h1><p>{expressionScopeTitle(scope)} · 先看中文，按需揭晓英文和播放。这里只读浏览，不记录学习、自评或复习进度。</p></header>
    {error?<div className="error-banner" role="alert">{error}<button onClick={()=>setRetry(value=>value+1)}>重新读取</button></div>:loading?<p role="status">正在读取表达…</p>:items.length?<div className={styles.list}>{items.map(item=><QuickReviewRow key={item.itemId} item={item}/>)}</div>:<div className={styles.empty}><p>这个范围暂时没有可回顾的表达；暂不学的项目可在我的表达中恢复。</p><Link className="secondary-button" href={`/expressions?extension=1&${query}`}>查看我的表达</Link></div>}
  </div>;
}
