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
  const filterable=showSummary&&scope.type==='collection'&&scope.id==='ielts';
  const [sourceFilters,setSourceFilters]=useState({questionId:scope.type==='collection'?scope.questionId??'':'',topicId:scope.type==='collection'?scope.topicId??'':'',seasonId:scope.type==='collection'?scope.seasonId??'':''});
  const [availableSources,setAvailableSources]=useState<LightSource[]>([]);
  const filteredScope:LightScope=filterable?{...scope,questionId:sourceFilters.questionId||undefined,topicId:sourceFilters.topicId||undefined,seasonId:sourceFilters.seasonId||undefined}:scope;
  const scopeKey=scopeQuery(filteredScope);
  const load=useCallback(async()=>{const token=++generation.current;setLoading(true);setError('');try{
    const response=await fetch('/api/expressions?'+scopeKey+'&includeHidden=1',{cache:'no-store'}),data=await response.json();
    if(!response.ok)throw new Error(data.error||'暂时无法读取材料');if(token===generation.current){setItems(data.items);setSummary(data.summary??null);if(filterable)setAvailableSources(previous=>[...new Map([...previous,...(data.items as ExpressionItem[]).flatMap(item=>item.sources??[])].map(source=>[source.materialId,source])).values()]);}
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
  return <section className="expression-library" aria-label="当前学习表达">
    {filterable&&<div className={styles.sourceFilters} aria-label="雅思来源筛选"><label>题目<select className="field" value={sourceFilters.questionId} onChange={event=>setSourceFilters(previous=>({...previous,questionId:event.target.value}))}><option value="">所有题目</option>{questions.map(([id,title])=><option key={id} value={id}>{title}</option>)}</select></label><label>话题<select className="field" value={sourceFilters.topicId} onChange={event=>setSourceFilters(previous=>({...previous,topicId:event.target.value}))}><option value="">所有话题</option>{topics.map(([id,title])=><option key={id} value={id}>{title}</option>)}<option value="unmarked">未标注话题</option></select></label><label>题季<select className="field" value={sourceFilters.seasonId} onChange={event=>setSourceFilters(previous=>({...previous,seasonId:event.target.value}))}><option value="">所有题季</option>{seasons.map(([id,title])=><option key={id} value={id}>{title}</option>)}<option value="unmarked">未标注题季</option></select></label></div>}
    {showSummary&&summary&&<ExpressionSummary summary={summary} scope={filteredScope}/>}
    <div className="expression-filters"><label className="sr-only" htmlFor={searchId}>搜索当前中文或英文表达</label><input id={searchId} className="field" placeholder="搜索中文或英文表达" value={query} onChange={e=>setQuery(e.target.value)}/><select className="field" aria-label="表达范围" value={filter} onChange={e=>setFilter(e.target.value)}><option value="all">全部表达</option><option value="new">待学</option><option value="due">到期复习</option><option value="known">已掌握（自评）</option><option value="favorites">我的收藏</option><option value="hidden">暂不学习（可恢复）</option></select></div>
    {error&&<div role="alert" className="error-banner">{error}<button onClick={()=>void load()}>重新读取</button></div>}{notice&&<p role="status" className="quiet">{notice}</p>}
    {loading?<p role="status">正在读取已审核材料…</p>:shown.length===0?<div className={styles.empty}><p>{query||filter!=='all'?'没有符合当前筛选的表达，可调整搜索或切换范围。':'这里还没有学习表达。保存回答并完成材料审核后，相关表达会出现在这里。'}</p>{!items.length&&<Link className="secondary-button" href={scope.type==='collection'&&scope.id==='free_talk'?'/free-talk':'/questions'}>{scope.type==='collection'&&scope.id==='free_talk'?'开始对话':'选择一道题'}</Link>}</div>:<div className={styles.list}>{shown.map(item=><article className={'expression-row '+styles.row} key={item.itemId}>
      <div className={styles.rowHeading}><div><p className="quiet">{item.chinese}</p><h3 lang="en">{item.english}</h3><p className={styles.state}>{studyState(item)}</p></div><SpeakButton text={item.english} style="short-expression" label="播放英文表达"/></div>
      {!compact&&<div className={styles.rowContent}><p>{item.sentenceZh}</p><div className={styles.answerLine}><p lang="en">{item.sentenceEn}</p><SpeakButton text={item.sentenceEn} style={item.questionId?'ielts-answer':'daily-conversation'} label="播放英文句子"/></div></div>}
      <details><summary>原句、入选理由与个人备注</summary>{compact&&<><p>{item.sentenceZh}</p><p lang="en">{item.sentenceEn}</p></>}<p>{item.reasonZh}</p><p>{item.originalEnglish}</p><p>{item.preference.note||item.note?.user_remark||'暂无个人备注'}</p><div className={styles.sourceList}>{item.sources?.length?item.sources.map(source=><div key={source.materialId}><Link href={source.href}>{source.sourceType==='ielts_practice'?'雅思回答':'对话'}：{source.title}</Link>{source.sourceType==='ielts_practice'&&<p className={styles.state}>话题：{source.topicTitle||'未标注'} · 题季：{source.seasons?.length?source.seasons.map(season=>season.title).join('、'):'未标注'}</p>}</div>):<Link href={item.sourceHref}>查看原回答／对话</Link>}</div><button disabled={busy} onClick={()=>{const note=window.prompt('个人备注（不会修改审核材料）',item.preference.note||item.note?.user_remark||'');if(note!==null)void update(item,{note});}}>编辑备注</button></details>
      <div className="row-actions"><button disabled={busy} aria-pressed={!!item.preference.self_known} onClick={()=>void update(item,{selfKnown:!item.preference.self_known})}>{item.preference.self_known?'恢复推送':'已掌握（自评）'}</button><button disabled={busy} aria-pressed={!!item.preference.favorite} onClick={()=>void update(item,{favorite:!item.preference.favorite})}>{item.preference.favorite?'取消收藏':'收藏'}</button><button disabled={busy} onClick={()=>void update(item,{hidden:!item.preference.hidden})}>{item.preference.hidden?'恢复学习':'暂不学'}</button><button disabled={busy} onClick={()=>{const feedback=window.prompt('哪里不清楚或有问题？反馈会绑定这条材料与版本，并暂时隐藏。');if(feedback?.trim())void update(item,{feedback,hidden:true});}}>材料有问题</button></div>
    </article>)}</div>}
  </section>;
}
