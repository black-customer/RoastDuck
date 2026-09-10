'use client';
import Link from 'next/link';
import {useState} from 'react';
import type {LightMode,LightOverview} from '@/lib/light-study/contracts';
import type {StudyQuestionOption} from '@/lib/home/study-options';
import {StartLightButton} from './StartLightButton';
import styles from './StudyChoices.module.css';

export function StudyChoices({mode,overview,questions}:{mode:LightMode;overview:LightOverview;questions?:StudyQuestionOption[]}){
  const [search,setSearch]=useState(''),[part,setPart]=useState(''),[topic,setTopic]=useState(''),[season,setSeason]=useState(''),[limit,setLimit]=useState(24);
  const review=mode==='review',count=review?overview.dueCount:overview.newCount;
  const title=questions?(review?'选一道题复习':'选一道题学习'):review?'今天怎么复习？':'今天怎么学？';
  const topics=[...new Map(questions?.map(q=>[q.topicId??'unmarked',q.topic])??[]).entries()];
  const seasons=[...new Map(questions?.flatMap(q=>q.seasons.map(s=>[s.id,s.name] as const))??[]).entries()];
  const filtered=questions?.filter(q=>(!part||String(q.part)===part)&&(!topic||(q.topicId??'unmarked')===topic)&&(!season||q.seasons.some(s=>s.id===season))&&`${q.text} ${q.textZh}`.toLowerCase().includes(search.trim().toLowerCase()));
  return <div className={styles.page}><Link className={styles.back} href={questions?`/study?mode=${mode}`:'/'}>返回{questions?'选择方式':'首页'}</Link><h1>{title}</h1>
    {questions?<>
      <label className={styles.search}>搜索题目<input value={search} onChange={e=>{setSearch(e.target.value);setLimit(24);}} placeholder="输入题目中的中文或英文" /></label>
      <details className={styles.filters}><summary>按 Part、话题或题季筛选</summary><div>
        <label>Part<select value={part} onChange={e=>setPart(e.target.value)}><option value="">全部 Part</option>{[1,2,3].map(n=><option key={n}>{n}</option>)}</select></label>
        <label>话题<select value={topic} onChange={e=>setTopic(e.target.value)}><option value="">全部话题</option>{topics.map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label>
        <label>题季<select value={season} onChange={e=>setSeason(e.target.value)}><option value="">全部题季</option>{seasons.map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label>
      </div></details>
      {!filtered?.length&&<p role="status">{questions.length?'这个筛选范围暂时没有匹配的题目。':review?'没有题目需要到期复习。对话表达可以使用“帮我安排一组”。':'还没有题目，可以从题库查看资料。'}</p>}
      <div className={styles.list}>{filtered?.slice(0,limit).map(q=>{
        const available=review?q.dueCount:q.newCount;
        const label=available?`${review?'复习':'学习'}：${q.textZh||q.text}`:q.totalCount?'查看已有材料':q.materialStatus==='failed'?'查看原因并恢复':q.materialStatus==='ready'?'查看本次反馈':q.materialStatus?'查看处理进度':'开始回答';
        const content=<><span className={styles.meta}>Part {q.part} · {q.topic}</span><strong lang="en">{q.text}</strong>{q.textZh&&<span>{q.textZh}</span>}<span className={styles.action}>{available?`${available} 个${review?'到期':'新'}表达 · 开始${review?'复习':'学习'}`:label}</span></>;
        return <div key={q.id} data-question-id={q.id}>{available?<StartLightButton className={styles.question} scope={{type:'question',id:q.id}} mode={mode} label={label}>{content}</StartLightButton>:<Link className={styles.question} href={q.totalCount||q.materialStatus?`/questions/${encodeURIComponent(q.id)}`:`/questions/${encodeURIComponent(q.id)}/practice`}>{content}</Link>}</div>;
      })}</div>
      {(filtered?.length??0)>limit&&<button className="secondary-button" onClick={()=>setLimit(n=>n+24)}>查看更多题目</button>}
    </>:!overview.totalCount?<section className={styles.empty}><h2>{review?'还没有需要复习的表达':'先准备第一份材料'}</h2><p>回答一道题，我们会把你想表达的意思整理成学习材料。</p><Link className="primary-button" href="/study?mode=learn&choose=questions">选择一道题</Link>{overview.unavailableCount>0&&<p>部分已有材料还在处理或待确认，可从菜单进入题库查看。</p>}</section>:!count&&!overview.resumable[mode]?<section className={styles.empty}><h2>{review?'今天暂时无需复习':'暂时没有新表达'}</h2><p>{review?'复习已经安排好，到期后会出现在这里。':'现有表达已经接触过。你可以准备另一道题，或等待到期复习。'}</p>{!review&&<Link className="primary-button" href="/study?mode=learn&choose=questions">选择一道新题目</Link>}<Link className={styles.back} href="/">今天先到这里</Link></section>:<div className={styles.choices}>
      <Link className={styles.choice} href={`/study?mode=${mode}&choose=questions`}><strong>{review?'按题目复习':'按题目学'}</strong><span>自己选择想准备的题目</span></Link>
      <StartLightButton className={styles.choice} scope={{type:'all'}} mode={mode} label={review?'帮我安排一组':'帮我选一组'}><strong>{review?'帮我安排一组':'帮我选一组'}</strong><span>{review?'从到期表达里安排五项':'直接学几个，不用自己挑选'}</span></StartLightButton>
    </div>}
  </div>;
}
