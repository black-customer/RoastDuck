"use client";
import Link from 'next/link';
import {useRef,useState} from 'react';
import type {HomeOverview} from '@/lib/home/overview';
import {StartLightButton} from './StartLightButton';
import styles from './HomeDashboard.module.css';

export function HomeDashboard({overview,allowLightStudy=true}:{overview:HomeOverview|null;allowLightStudy?:boolean}){
  const [selected,setSelected]=useState<string|null>(null);
  const calendar=useRef<HTMLDivElement>(null);
  if(!overview)return <section className={styles.empty}><h1>学习记录暂时没有加载出来</h1><p>原记录没有被重置。</p><button className="secondary-button" onClick={()=>window.location.reload()}>重新读取</button></section>;
  const {activity,light,resumeByMode}=overview;
  const selectedDay=activity.days.find(day=>day.date===selected);
  return <div className={styles.home}>
    <section className={styles.history} aria-label="学习记录">
      <div className={styles.heading}><h1>我的学习记录</h1><span>最近十二周</span></div>
      <div ref={calendar} className={styles.heatmap} aria-label="每日学习记录">
        {activity.days.map((day,index)=><button key={day.date} className={styles.day} data-date={day.date} data-level={day.level} data-today={day.isToday} disabled={day.isFuture}
          tabIndex={(selected?selected===day.date:day.isToday)?0:-1}
          aria-label={`${day.date}，${day.isFuture?'尚未到来':`学习了 ${day.count} 个表达`}`} aria-pressed={selected===day.date}
          title={`${day.date} · ${day.count} 个表达`} onFocus={()=>setSelected(day.date)} onClick={()=>setSelected(day.date)}
          onKeyDown={event=>{const offset=({ArrowLeft:-7,ArrowRight:7,ArrowUp:-1,ArrowDown:1} as Record<string,number>)[event.key];if(offset===undefined)return;event.preventDefault();const target=activity.days[Math.max(0,Math.min(activity.days.findIndex(d=>d.isToday),index+offset))];calendar.current?.querySelector<HTMLButtonElement>(`button[data-date="${target.date}"]`)?.focus();}} />)}
      </div>
      <div className={styles.legend}><span aria-live="polite">{selectedDay?`${selectedDay.date} · 学习 ${selectedDay.count} 个表达`:'每一个色块，都是一次积累。'}</span><span>少 <i data-level="0"/><i data-level="1"/><i data-level="2"/><i data-level="3"/> 多</span></div>
      <dl className={styles.stats}><div><dt>本周学习</dt><dd>{activity.weekDays}<small> 天</small></dd></div><div><dt>累计学过</dt><dd>{overview.studiedCount}<small> 个表达</small></dd></div><div><dt>连续学习</dt><dd>{activity.streakDays}<small> 天</small></dd></div></dl>
      {activity.dailyIncomplete&&<p className={styles.historyNote}>部分早期记录没有逐日日期，已保留在累计学习中。</p>}
    </section>
    <div className={styles.homeActions} aria-label="学习与复习">
      {(['learn','review'] as const).map(mode=>{
        const resume=resumeByMode[mode],title=mode==='learn'?'学习':'复习';
        const description=resume?`继续上次 · ${Math.min(resume.index+1,resume.total)} / ${resume.total}`:mode==='learn'?'认识新的表达':light.dueCount?`${light.dueCount} 个表达到期`:'今天暂时没有到期表达';
        const content=<><strong>{title}</strong><span>{description}</span></>;
        return resume?<StartLightButton key={mode} className={styles.homeAction} scope={resume.scope} mode={mode} resumeSessionId={resume.id} label={title}>{content}</StartLightButton>:
          <Link key={mode} className={styles.homeAction} href={`/study?mode=${mode}`} aria-label={title}>{content}</Link>;
      })}
    </div>
    {!allowLightStudy&&!resumeByMode.learn&&!resumeByMode.review&&<p className={styles.historyNote}>新学习暂未开放，已有资料和记录保留在菜单中。</p>}
  </div>;
}
