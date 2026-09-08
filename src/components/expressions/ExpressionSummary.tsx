'use client';
import Link from 'next/link';
import {useId} from 'react';
import type {ExpressionSummary as Summary} from '@/lib/app-services/expressions';
import type {LightScope} from '@/lib/light-study/contracts';
import {scopeQuery} from '@/lib/light-study/scope-links';
import styles from './ExpressionCollection.module.css';
export function ExpressionSummary({summary,scope}:{summary:Summary;scope:LightScope}){
  const progressId=useId(),query=scopeQuery(scope),processed=summary.eligibleStudied+summary.eligibleSelfKnownUnstudied;
  return <section className={styles.summary} aria-label="表达学习概况">
    <dl className={styles.stats}><div><dt>累计学过</dt><dd>{summary.studied}</dd></div><div><dt>自评已会未学</dt><dd>{summary.selfKnownUnstudied}</dd></div><div><dt>待学</dt><dd>{summary.new}</dd></div><div><dt>到期</dt><dd>{summary.due}</dd></div></dl>
    <div className={styles.progress}><label htmlFor={progressId}>本轮已处理 {processed} / {summary.eligibleTotal} 个表达</label><progress id={progressId} max={Math.max(1,summary.eligibleTotal)} value={processed}/></div>
    <p className={styles.explanation}>已处理包含学过与自评已会，不代表客观掌握。{summary.hidden>0?`${summary.hidden} 个暂不学的表达不计入本轮进度，历史记录仍保留。`:''}</p>
    <div className="row-actions">{(summary.due>0||summary.new>0)&&<Link className="primary-button" href={`/light-study?${query}&mode=${summary.due>0?'review':'learn'}`}>{summary.due>0?'复习到期表达':'开始轻松学'}</Link>}{summary.eligibleTotal>0&&<Link className="secondary-button" href={`/quick-review?${query}`}>快速回顾</Link>}</div>
  </section>;
}
