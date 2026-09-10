'use client';
import Link from 'next/link';
import {useCallback,useEffect,useId,useRef,useState} from 'react';
import type {LightCard,LightScope,LightSource} from '@/lib/light-study/contracts';
import type {ProgressRow} from '@/lib/light-study/core-catalogue';
import type {ExpressionPreference,ExpressionSummary as Summary} from '@/lib/app-services/expressions';
import {scopeQuery} from '@/lib/light-study/scope-links';
import {SpeakButton} from './SpeakButton';
import {ExpressionSummary} from './expressions/ExpressionSummary';
import styles from './expressions/ExpressionCollection.module.css';
export type ExpressionItem=LightCard&{preference:ExpressionPreference;progress:ProgressRow|null;note?:{user_remark:string}|null};
const all:LightScope={type:'all'};
function studyState(item:ExpressionItem){
  if(item.preference.hidden)return item.progress?'已学过 · 暂不学':'未学 · 暂不学';
  if(item.preference.self_known)return item.progress?'已学过 · 已掌握（自评）':'自评已会，尚未学习';
  if(!item.progress)return '待学';
  return Date.parse(item.progress.due_at)<=Date.now()?'已学过 · 到期复习':'已学过 · 等待下次复习';
}
export function ExpressionLibrary({scope=all,compact=false,showSummary=false}:{scope?:LightScope;compact?:boolean;showSummary?:boolean}){
  const [items,setItems]=useState<ExpressionItem[]>([]),[summary,setSummary]=useState<Summary|null>(null),[query,setQuery]=useState(''),[filter,setFilter]=useState('all'),[loading,setLoading]=useState(true),[error,setError]=useState(''),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
  const generation=useRef(0),searchId=useId(),busyLock=useRef(false);
  const resolvedScope=useRef('');
  const filterable=showSummary&&scope.type==='collection'&&scope.id==='ielts';
  const [sourceFilters,setSourceFilters]=useState({questionId:scope.type==='collection'?scope.questionId??'':'',topicId:scope.type==='collection'?scope.topicId??'':'',seasonId:scope.type==='collection'?scope.seasonId??'':''});
  const [availableSources,setAvailableSources]=useState<LightSource[]>([]);
  const filteredScope:LightScope=filterable?{...scope,questionId:sourceFilters.questionId||undefined,topicId:sourceFilters.topicId||undefined,seasonId:sourceFilters.seasonId||undefined}:scope;
  const scopeKey=scopeQuery(filteredScope);
  const load=useCallback(async()=>{const token=++generation.current;setLoading(true);setError('');if(resolvedScope.current!==scopeKey){setItems([]);setSummary(null);}try{
    const response=await fetch('/api/expressions?'+scopeKey+'&includeHidden=1',{cache:'no-store'}),data=await response.json();
    if(!response.ok)throw new Error(data.error||'暂时无法读取材料');if(token===generation.current){resolvedScope.current=scopeKey;setItems(data.items);setSummary(data.summary??null);if(filterable)setAvailableSources(previous=>[...new Map([...previous,...(data.items as ExpressionItem[]).flatMap(item=>item.sources??[])].map(source=>[source.materialId,source])).values()]);}
  }catch(reason){if(token===generation.current)setError(reason instanceof Error?reason.message:'暂时无法读取材料');}finally{if(token===generation.current)setLoading(false);}},[scopeKey,filterable]);
  const invalidate=useCallback(()=>{generation.current++;},[]);
  useEffect(()=>{void load();return invalidate;},[load,invalidate]);
  async function update(item:ExpressionItem,patch:{hidden?:boolean;favorite?:boolean;selfKnown?:boolean;note?:string;feedback?:string}){
    if(busyLock.current)return;busyLock.current=true;setBusy(true);setError('');setNotice('');
    try{
      const response=await fetch('/api/expressions',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({itemId:item.itemId,materialId:item.materialId,version:item.preference.version,clientEventId:crypto.randomUUID(),...patch})});
      const data=await response.json();if(!response.ok)throw new Error(data.error||'操作未保存，请重试');await load();
      setNotice(patch.feedback?'问题已记录，暂不学习此表达；不会自动重新生成。':patch.selfKnown===true?'已设为已掌握（自评），停止推送；可以随时恢复。':patch.selfKnown===false?(item.preference.hidden?'已取消自评已掌握；此项仍设为暂不学，恢复学习后才会推送。':'已恢复推送，原学习记录和复习日期保留。'):patch.hidden===true?'已暂不学，进度保留，可以恢复。':patch.hidden===false?(item.preference.self_known?'已恢复显示；已掌握（自评）的停推设置仍保留。':'已恢复学习，原记录保留。'):'已保存');
    }catch(reason){setError(reason instanceof Error?reason.message:'操作未保存，请重试');}finally{busyLock.current=false;setBusy(false);}
  }
  const shown=items.filter(item=>{
    const p=item.preference,due=!!item.progress&&Date.parse(item.progress.due_at)<=Date.now();
    const inFilter=filter==='hidden'?!!p.hidden:!p.hidden&&(filter==='favorites'?!!p.favorite:filter==='known'?!!p.self_known:filter==='new'?!p.self_known&&!item.progress:filter==='due'?!p.self_known&&due:true);
    return inFilter&&(item.english+' '+item.chinese+' '+item.sentenceEn+' '+p.note).toLowerCase().includes(query.trim().toLowerCase());
  });
  const questions=[...new Map(availableSources.filter(source=>source.questionId).map(source=>[source.questionId!,source.questionTitle||source.title])).entries()];
  const topics=[...new Map(availableSources.filter(source=>source.topicId).map(source=>[source.topicId!,source.topicTitle||'未标注'])).entries()];
  const seasons=[...new Map(availableSources.flatMap(source=>source.seasons??[]).map(season=>[season.id,season.title])).entries()];
  const hasSourceFilters=Object.values(sourceFilters).some(Boolean);
  const hasFilters=query.trim()!==''||filter!=='all'||hasSourceFilters;
  const hasLibrary=items.length>0||availableSources.length>0||hasFilters||loading||Boolean(error);
  const sourceDescription=[
    sourceFilters.questionId&&questions.find(([id])=>id===sourceFilters.questionId)?.[1],
    sourceFilters.topicId&&(sourceFilters.topicId==='unmarked'?'未标注话题':topics.find(([id])=>id===sourceFilters.topicId)?.[1]),
    sourceFilters.seasonId&&(sourceFilters.seasonId==='unmarked'?'未标注题季':seasons.find(([id])=>id===sourceFilters.seasonId)?.[1]),
  ].filter(Boolean).join(' · ');
  function clearFilters(){setQuery('');setFilter('all');setSourceFilters({questionId:'',topicId:'',seasonId:''});}

  return <section className={styles.library} aria-label="当前学习表达">
    {showSummary&&summary&&!loading&&<ExpressionSummary summary={summary} scope={filteredScope}/>}
    {hasLibrary&&<div className={styles.browseTools}>
      <div className={styles.searchRow}><label className="sr-only" htmlFor={searchId}>搜索当前中文或英文表达</label><input id={searchId} className="field" placeholder="搜索中文或英文表达" value={query} onChange={event=>setQuery(event.target.value)}/></div>
      <details className={styles.filters}>
        <summary>筛选表达{hasFilters?' · 已筛选':''}</summary>
        {filterable&&<div className={styles.sourceFilters} aria-label="雅思来源筛选">
          <label>题目<select className="field" value={sourceFilters.questionId} onChange={event=>setSourceFilters(previous=>({...previous,questionId:event.target.value}))}><option value="">所有题目</option>{questions.map(([id,title])=><option key={id} value={id}>{title}</option>)}</select></label>
          <label>话题<select className="field" value={sourceFilters.topicId} onChange={event=>setSourceFilters(previous=>({...previous,topicId:event.target.value}))}><option value="">所有话题</option>{topics.map(([id,title])=><option key={id} value={id}>{title}</option>)}<option value="unmarked">未标注话题</option></select></label>
          <label>题季<select className="field" value={sourceFilters.seasonId} onChange={event=>setSourceFilters(previous=>({...previous,seasonId:event.target.value}))}><option value="">所有题季</option>{seasons.map(([id,title])=><option key={id} value={id}>{title}</option>)}<option value="unmarked">未标注题季</option></select></label>
        </div>}
        <label className={styles.stateFilter}>列表显示<select className="field" aria-label="表达范围" value={filter} onChange={event=>setFilter(event.target.value)}><option value="all">全部表达</option><option value="new">待学</option><option value="due">到期复习</option><option value="known">已掌握（自评）</option><option value="favorites">我的收藏</option><option value="hidden">暂不学习（可恢复）</option></select></label>
        {hasFilters&&<button type="button" className="secondary-button" onClick={clearFilters}>清除筛选</button>}
      </details>
      {sourceDescription&&<p className={styles.activeScope}>学习范围：{sourceDescription}</p>}
      {query.trim()&&showSummary&&<p className={styles.explanation}>搜索仅筛选下方列表；学新和复习使用当前来源范围。</p>}
    </div>}
    {error&&<div role="alert" className="error-banner">{error}<button type="button" onClick={()=>void load()}>重新读取</button></div>}
    {notice&&<p role="status" className={styles.notice}>{notice}</p>}
    {loading&&!items.length?<p role="status">正在读取已审核材料…</p>:error&&!items.length?null:shown.length===0?<div className={styles.empty}>
      <h2>{hasFilters?'这个范围暂时没有表达':scope.type==='collection'&&scope.id==='free_talk'?'从一段对话开始':'从你想说的话开始'}</h2>
      <p>{hasFilters?'调整搜索或筛选，就可以查看其他表达。':scope.type==='collection'&&scope.id==='free_talk'?'聊完后选择消息复盘，通过审核的表达会整理在这里。':'选择一道题，用中文、英文或混合写下想法。材料审核后，想学的表达会整理在这里。'}</p>
      {hasFilters?<button type="button" className="secondary-button" onClick={clearFilters}>清除筛选</button>:<Link className="primary-button" href={scope.type==='collection'&&scope.id==='free_talk'?'/free-talk':'/questions'}>{scope.type==='collection'&&scope.id==='free_talk'?'开始对话':'选择一道题'}</Link>}
    </div>:<div className={styles.list}>{shown.map(item=><article className={styles.row} data-testid="expression-row" key={item.itemId}>
      <div className={styles.rowHeading}>
        <div><p className="quiet">{item.chinese}</p><h3 lang="en">{item.english}</h3><p className={styles.state}>{studyState(item)}</p></div>
        <div className={styles.rowQuickActions}><SpeakButton text={item.english} style="short-expression" label="播放英文表达"/><button type="button" disabled={busy} aria-pressed={!!item.preference.favorite} onClick={()=>void update(item,{favorite:!item.preference.favorite})}>{item.preference.favorite?'已收藏':'收藏'}</button></div>
      </div>
      {!compact&&<div className={styles.rowContent}><p>{item.sentenceZh}</p><div className={styles.answerLine}><p lang="en">{item.sentenceEn}</p><SpeakButton text={item.sentenceEn} style={item.questionId?'ielts-answer':'daily-conversation'} label="播放英文句子"/></div></div>}
      <details><summary>说明、来源与管理</summary>
        {compact&&<><p>{item.sentenceZh}</p><p lang="en">{item.sentenceEn}</p></>}
        <p>{item.reasonZh}</p><p lang="en">{item.originalEnglish}</p>
        <div className={styles.sourceList}>{item.sources?.length?item.sources.map(source=><div key={source.materialId}><Link href={source.href}>{source.sourceType==='ielts_practice'?'雅思回答':'对话'}：{source.title}</Link>{source.sourceType==='ielts_practice'&&<p className={styles.state}>话题：{source.topicTitle||'未标注'} · 题季：{source.seasons?.length?source.seasons.map(season=>season.title).join('、'):'未标注'}</p>}</div>):<Link href={item.sourceHref}>查看原回答／对话</Link>}</div>
        <p>{item.preference.note||item.note?.user_remark||'暂无个人备注'}</p>
        <div className={styles.managementActions}>
          <button type="button" disabled={busy} onClick={()=>{const note=window.prompt('个人备注（不会修改审核材料）',item.preference.note||item.note?.user_remark||'');if(note!==null)void update(item,{note});}}>编辑备注</button>
          <button type="button" disabled={busy} aria-pressed={!!item.preference.self_known} onClick={()=>void update(item,{selfKnown:!item.preference.self_known})}>{item.preference.self_known?'恢复推送':'已掌握（自评）'}</button>
          <button type="button" disabled={busy} onClick={()=>void update(item,{hidden:!item.preference.hidden})}>{item.preference.hidden?'恢复学习':'暂不学'}</button>
          <button type="button" disabled={busy} onClick={()=>{const feedback=window.prompt('哪里不清楚或有问题？反馈会绑定这条材料与版本，并暂时隐藏。');if(feedback?.trim())void update(item,{feedback,hidden:true});}}>材料有问题</button>
        </div>
      </details>
    </article>)}</div>}
  </section>;
}
