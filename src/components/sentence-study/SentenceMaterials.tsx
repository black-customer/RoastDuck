'use client';
import Link from 'next/link';
import type {SentenceOverview,SentenceScope} from '@/lib/sentence-study/contracts';
import {SentenceLibrary} from '@/components/expressions/SentenceLibrary';
import styles from './SentenceMaterials.module.css';

export function SentenceMaterials({overview,kind='ielts',initialScope,initialQuery=''}:{overview:SentenceOverview;kind:'ielts'|'free_talk';initialScope?:SentenceScope;initialQuery?:string}){
  return <div className={styles.page}><header className={styles.header}><h1>我的学习材料</h1><p>从自己的回答和对话出发，把句子放回完整意思里理解。</p></header><nav className={styles.tabs} aria-label="材料来源"><Link href="/expressions?scope=collection&id=ielts" aria-current={kind==='ielts'?'page':undefined}>雅思回答</Link><Link href="/expressions?scope=collection&id=free_talk" aria-current={kind==='free_talk'?'page':undefined}>对话复盘</Link></nav>
    <SentenceLibrary key={JSON.stringify(initialScope??kind)} overview={overview} initialScope={initialScope??{type:'collection',id:kind}} initialQuery={initialQuery}/>
    <footer className={styles.footer}><Link href="/search">搜索全部句子与备注</Link><Link href="/extensions">拓展功能与旧记录</Link></footer>
  </div>;
}
