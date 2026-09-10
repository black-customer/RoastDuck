'use client';
import Link from 'next/link';
import {useId} from 'react';
import type {ExpressionSummary as Summary} from '@/lib/app-services/expressions';
import type {LightScope} from '@/lib/light-study/contracts';
import {scopeQuery} from '@/lib/light-study/scope-links';
import styles from './ExpressionCollection.module.css';
export function ExpressionSummary({summary,scope}:{summary:Summary;scope:LightScope}){
  const progressId=useId(),query=scopeQuery(scope),processed=summary.eligibleStudied+summary.eligibleSelfKnownUnstudied;
  if(summary.total===0)return null;
  return <section className={styles.summary} aria-label="表达学习概况">
    <p className={styles.scopeSummary}>当前范围有 {summary.eligibleTotal} 个学习表达，每次学几个。</p>
    <div className={styles.studyActions}>
      {summary.new>0?<Link className={summary.due>0?'secondary-button':'primary-button'} href={`/light-study?${query}&mode=learn`}>学新表达（{summary.new}）</Link>:<button type="button" className="secondary-button" disabled>学新表达（0）</button>}
      {summary.due>0?<Link className="primary-button" href={`/light-study?${query}&mode=review`}>复习到期表达（{summary.due}）</Link>:<button type="button" className="secondary-button" disabled>复习到期表达（0）</button>}
      {summary.eligibleTotal>0&&<Link className={styles.quickLink} href={`/quick-review?${query}`}>快速回顾</Link>}
    </div>
    <details className={styles.summaryDetails}><summary>查看学习记录</summary>
      <dl className={styles.stats}><div><dt>累计学过</dt><dd>{summary.studied}</dd></div><div><dt>自评已会未学</dt><dd>{summary.selfKnownUnstudied}</dd></div><div><dt>待学</dt><dd>{summary.new}</dd></div><div><dt>到期</dt><dd>{summary.due}</dd></div></dl>
      {summary.eligibleTotal>0&&<div className={styles.progress}><label htmlFor={progressId}>当前材料已处理 {processed} / {summary.eligibleTotal} 个表达</label><progress id={progressId} max={summary.eligibleTotal} value={processed}/></div>}
      <p className={styles.explanation}>累计学过保留旧版本记录；当前材料只统计仍在学习范围的表达。已处理包含学过与自评已会，不代表客观掌握。{summary.hidden>0?`${summary.hidden} 个暂不学的表达不计入当前材料进度，历史记录仍保留。`:''}</p>
    </details>
  </section>;
}
