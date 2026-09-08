'use client';
import Link from 'next/link';
import {useEffect,useState} from 'react';
import type {ExpressionSummary} from '@/lib/app-services/expressions';
import styles from './HomeDashboard.module.css';
const collections=[{id:'ielts',title:'我的雅思表达'},{id:'free_talk',title:'我的对话表达'}] as const;
export function HomeExpressionCollections(){
  const [summaries,setSummaries]=useState<Partial<Record<'ielts'|'free_talk',ExpressionSummary>>>({});
  useEffect(()=>{
    const controller=new AbortController();
    void Promise.allSettled(collections.map(async collection=>{
      const response=await fetch(`/api/expressions?scope=collection&id=${collection.id}&summaryOnly=1`,{cache:'no-store',signal:controller.signal});
      if(!response.ok)return;const data=await response.json();
      if(!controller.signal.aborted)setSummaries(previous=>({...previous,[collection.id]:data.summary}));
    }));
    return()=>controller.abort();
  },[]);
  return <section className={styles.collections} aria-labelledby="personal-expressions-title"><h2 id="personal-expressions-title">我的表达</h2><p>回答和对话各自整理，同一表达共享记录。</p>
    {collections.map(collection=><div className={styles.collectionRow} key={collection.id}><div><Link className={styles.collectionTitle} href={`/expressions?scope=collection&id=${collection.id}`}>{collection.title}</Link>{summaries[collection.id]&&<p>学过 {summaries[collection.id]!.studied} · 待学 {summaries[collection.id]!.new} · 到期 {summaries[collection.id]!.due}</p>}</div><Link className={styles.textLink} href={`/quick-review?scope=collection&id=${collection.id}`}>快速回顾<span className="sr-only">{collection.title}</span></Link></div>)}
  </section>;
}
