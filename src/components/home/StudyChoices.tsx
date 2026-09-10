'use client';
import Link from 'next/link';
import {useState} from 'react';
import type {SentenceMode,SentenceOverview} from '@/lib/sentence-study/contracts';
import {StartSentenceButton} from '@/components/sentence-study/StartSentenceButton';
import styles from './StudyChoices.module.css';

export function StudyChoices({mode,overview,chooseQuestions=false}:{mode:SentenceMode;overview:SentenceOverview;chooseQuestions?:boolean}){
  const [search,setSearch]=useState(''),[part,setPart]=useState(''),[topic,setTopic]=useState(''),[season,setSeason]=useState(''),[limit,setLimit]=useState(24);
  const review=mode==='review',count=review?overview.dueCount:overview.newCount;
  const questions=overview.sources.filter(source=>source.type==='question'&&(!review||source.dueCount>0));
  const topics=[...new Map(questions.map(q=>[q.topicId??'unmarked',q.topic])).entries()];
  const seasons=[...new Map(questions.flatMap(q=>q.seasons.map(s=>[s.id,s.name] as const))).entries()];
  const filtered=questions.filter(q=>(!part||String(q.part)===part)&&(!topic||(q.topicId??'unmarked')===topic)&&(!season||q.seasons.some(s=>s.id===season))&&`${q.title} ${q.textEn}`.toLowerCase().includes(search.trim().toLowerCase()));
  return <div className={styles.page}><Link className={styles.back} href={chooseQuestions?`/study?mode=${mode}`:'/'}>返回{chooseQuestions?'选择方式':'首页'}</Link><h1>{chooseQuestions?(review?'选一道题复习':'想学会哪一道题？'):review?'今天怎么复习？':'从一道题开始'}</h1>
    {chooseQuestions?<>
      <label className={styles.search}>搜索题目<input value={search} onChange={e=>{setSearch(e.target.value);setLimit(24);}} placeholder="输入题目中的中文或英文" /></label>
      <details className={styles.filters}><summary>按 Part、话题或题季筛选</summary><div>
        <label>Part<select value={part} onChange={e=>setPart(e.target.value)}><option value="">全部 Part</option>{[1,2,3].map(n=><option key={n}>{n}</option>)}</select></label>
        <label>话题<select value={topic} onChange={e=>setTopic(e.target.value)}><option value="">全部话题</option>{topics.map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label>
        <label>题季<select value={season} onChange={e=>setSeason(e.target.value)}><option value="">全部题季</option>{seasons.map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label>
      </div></details>
      {!filtered.length&&<p role="status">{questions.length?'这个筛选范围暂时没有匹配的题目。':review?'没有题目需要到期复习。对话材料可以通过自动安排进入。':'还没有题目，可以从题库查看资料。'}</p>}
      <div className={styles.list}>{filtered.slice(0,limit).map(q=>{
        const available=review?q.dueCount:q.newCount;
        const label=available?`${review?'复习':'学习'}：${q.title}`:q.totalCount?'查看已有材料':q.materialStatus==='failed'?'查看原因并恢复':q.materialStatus==='ready'?'查看本次反馈':q.materialStatus?'查看处理进度':'开始回答';
        const content=<><span className={styles.meta}>Part {q.part} · {q.topic}</span><strong lang="en">{q.textEn}</strong>{q.title!==q.textEn&&<span>{q.title}</span>}<span className={styles.action}>{available?`${available} 句${review?'到期':'待学'} · 开始${review?'复习':'学习'}`:label}</span></>;
        return <div key={q.id} data-question-id={q.id}>{available?<StartSentenceButton className={styles.question} scope={{type:'question',id:q.id}} mode={mode} label={label}>{content}</StartSentenceButton>:<Link className={styles.question} href={q.totalCount||q.materialStatus?`/questions/${encodeURIComponent(q.id)}`:`/questions/${encodeURIComponent(q.id)}/practice`}>{content}</Link>}</div>;
      })}</div>
      {filtered.length>limit&&<button className="secondary-button" onClick={()=>setLimit(n=>n+24)}>查看更多题目</button>}
    </>:!overview.totalCount?<section className={styles.empty}><h2>{review?'还没有需要复习的句子':'先准备第一份材料'}</h2><p>选一道题，写下你想表达的意思。中文、英文或混合都可以。</p><Link className="primary-button" href="/study?mode=learn&choose=questions">选择一道题</Link>{overview.unavailableCount>0&&<p>部分已有材料还在处理或待确认，可以回到原回答查看。</p>}</section>:!count&&!overview.resumable[mode]?<section className={styles.empty}><h2>{review?'今天暂时无需复习':'这些句子都已经学过一遍'}</h2><p>{review?'到期句子会自动出现在这里。今天可以先休息，或学习新的题目。':'你可以准备另一道题，复习会按每句的回想情况安排。'}</p>{!review&&<Link className="primary-button" href="/study?mode=learn&choose=questions">选择一道新题目</Link>}<Link className={styles.back} href="/">返回首页</Link></section>:<div className={styles.choices}>
      <Link className={styles.choice} href={`/study?mode=${mode}&choose=questions`}><strong>{review?'按题目复习':'自己选题'}</strong><span>{review?'只显示有到期句子的题目':'选一个你想聊的话题'}</span></Link>
      <StartSentenceButton className={styles.choice} scope={{type:'all'}} mode={mode} selection={review?'due':'random'} label={review?'帮我安排':'帮我选一道'}><strong>{review?'帮我安排':'帮我选一道'}</strong><span>{review?'先复习最早到期的一份材料':'从有新句子的题目里选一道'}</span></StartSentenceButton>
    </div>}
  </div>;
}
