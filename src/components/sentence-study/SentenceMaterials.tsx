'use client';
import Link from 'next/link';
import {useState} from 'react';
import type {SentenceOverview} from '@/lib/sentence-study/contracts';
import {StartSentenceButton} from './StartSentenceButton';
import styles from './SentenceMaterials.module.css';

export function SentenceMaterials({overview,kind='ielts'}:{overview:SentenceOverview;kind:'ielts'|'free_talk'}){
  const [query,setQuery]=useState('');
  const sources=overview.sources.filter(source=>source.type===(kind==='ielts'?'question':'conversation')&&(source.totalCount>0||!!source.materialStatus));
  const shown=sources.filter(source=>`${source.title} ${source.textEn} ${source.topic}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <div className={styles.page}><header className={styles.header}><h1>我的学习材料</h1><p>从自己的回答和对话出发，逐句学会想表达的意思。</p></header><nav className={styles.tabs} aria-label="材料来源"><Link href="/expressions?scope=collection&id=ielts" aria-current={kind==='ielts'?'page':undefined}>雅思回答</Link><Link href="/expressions?scope=collection&id=free_talk" aria-current={kind==='free_talk'?'page':undefined}>对话复盘</Link></nav>
    <label className={styles.search}>查找材料<input value={query} onChange={event=>setQuery(event.target.value)} placeholder={kind==='ielts'?'搜索题目、中文或话题':'搜索对话标题'}/></label>
    <div className={styles.list}>{shown.map(source=><article key={source.id}><div><div className={styles.meta}>{source.part?`Part ${source.part} · ${source.topic}`:'Chloe 对话'}</div><h2>{source.title}</h2>{source.textEn!==source.title&&<p lang="en">{source.textEn}</p>}<p className={styles.counts}>{source.totalCount?`${source.totalCount} 句 · ${source.newCount} 句待学 · ${source.dueCount} 句到期`:source.materialStatus==='failed'?'材料处理未完成，原回答已保留。':'正在整理材料。'}</p></div><div className={styles.actions}>{source.newCount>0&&<StartSentenceButton scope={{type:source.type==='question'?'question':'conversation',id:source.id}} mode="learn" label="开始句子学习"/>}{source.dueCount>0&&<StartSentenceButton scope={{type:source.type==='question'?'question':'conversation',id:source.id}} mode="review" className="secondary-button" label="复习到期句子"/>}<Link href={source.href}>{source.totalCount?'查看材料':'查看处理进度'}</Link></div></article>)}</div>
    {!shown.length&&<div className={styles.empty}><h2>{query?'没有找到匹配的材料':kind==='ielts'?'从你想说的话开始':'从一段对话开始'}</h2><p>{query?'试试题目中的其他词，或清空搜索。':kind==='ielts'?'选择一道题，用中文、英文或混合写下想法。':'与 Chloe 聊完后，选择一段消息复盘。'}</p>{query?<button className="secondary-button" onClick={()=>setQuery('')}>清空搜索</button>:<Link className="primary-button" href={kind==='ielts'?'/study?mode=learn&choose=questions':'/free-talk'}>{kind==='ielts'?'选择一道题':'开始对话'}</Link>}</div>}
    <Link className="exit-button" href="/extensions">拓展功能与旧记录</Link>
  </div>;
}
