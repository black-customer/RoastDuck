'use client';
import Link from 'next/link';
import {useCallback,useEffect,useRef,useState} from 'react';
import type {LightCard,LightScope} from '@/lib/light-study/contracts';
import type {ExpressionPreference} from '@/lib/app-services/expressions';
import {SpeakButton} from './SpeakButton';
type Item=LightCard&{preference:ExpressionPreference;note?:{user_remark:string}|null};
const all:LightScope={type:'all'};
export function ExpressionLibrary({scope=all,compact=false}:{scope?:LightScope;compact?:boolean}){
  const [items,setItems]=useState<Item[]>([]),[query,setQuery]=useState(''),[filter,setFilter]=useState('all'),[loading,setLoading]=useState(true),[error,setError]=useState(''),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
  const generation=useRef(0);
  const load=useCallback(async()=>{const token=++generation.current;setLoading(true);try{
    const params=new URLSearchParams({includeHidden:'1'});if(scope.type!=='all'){params.set('scope',scope.type);params.set('id',scope.id);}
    const response=await fetch('/api/expressions?'+params,{cache:'no-store'}),data=await response.json();if(!response.ok)throw new Error(data.error);if(token===generation.current)setItems(data.items);
  }catch(reason){if(token===generation.current)setError(reason instanceof Error?reason.message:'暂时无法读取材料');}finally{if(token===generation.current)setLoading(false);}},[scope]);
  const invalidate=useCallback(()=>{generation.current++;},[]);
  useEffect(()=>{void load();return invalidate;},[load,invalidate]);
  async function update(item:Item,patch:{hidden?:boolean;favorite?:boolean;note?:string;feedback?:string}){
    if(busy)return;setBusy(true);setError('');setNotice('');try{const response=await fetch('/api/expressions',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({itemId:item.itemId,materialId:item.materialId,version:item.preference.version,clientEventId:crypto.randomUUID(),...patch})});const data=await response.json();if(!response.ok)throw new Error(data.error);await load();setNotice(patch.feedback?'问题已记录，暂不学习此表达；不会自动付费重新生成。':patch.hidden?'已暂不学习，进度保留，可以恢复。':'已保存');}catch(reason){setError(reason instanceof Error?reason.message:'操作未保存，请重试');}finally{setBusy(false);}
  }
  const shown=items.filter(item=>(filter==='hidden'?!!item.preference.hidden:filter==='favorites'?!!item.preference.favorite&&!item.preference.hidden:!item.preference.hidden)&&`${item.english} ${item.chinese} ${item.sentenceEn} ${item.preference.note}`.toLowerCase().includes(query.trim().toLowerCase()));
  return <section className="expression-library" aria-label="当前学习表达"><div className="expression-filters"><label className="sr-only" htmlFor="current-expression-search">搜索当前中文或英文表达</label><input id="current-expression-search" className="field" placeholder="搜索中文或英文表达" value={query} onChange={e=>setQuery(e.target.value)}/><select className="field" aria-label="表达范围" value={filter} onChange={e=>setFilter(e.target.value)}><option value="all">正在学习</option><option value="favorites">我的收藏</option><option value="hidden">暂不学习（可恢复）</option></select></div>
    {error&&<div role="alert" className="error-banner">{error}<button onClick={()=>void load()}>重新读取</button></div>}{notice&&<p role="status" className="quiet">{notice}</p>}{loading?<p role="status">正在读取已审核材料…</p>:shown.length===0?<p className="empty-state">这个范围没有表达。隐藏不等于学会；普通查询不会自动加入收藏。</p>:<div className="expression-list">{shown.map(item=><article className="page-panel expression-row" key={item.itemId}><div className="expression-row-heading"><div><p className="quiet">{item.chinese}</p><h3 lang="en">{item.english}</h3></div><SpeakButton text={item.english}/></div>
      {!compact&&<><p>{item.sentenceZh}</p><p lang="en">{item.sentenceEn}</p></>}
      <details><summary>原句、入选理由与个人备注</summary><p>{item.sentenceZh}</p><p lang="en">{item.sentenceEn}</p><p>{item.reasonZh}</p><p lang="en">{item.originalEnglish}</p><p>{item.preference.note||item.note?.user_remark||'暂无个人备注'}</p><Link href={item.sourceHref}>查看原回答／对话</Link><button disabled={busy} onClick={()=>{const note=window.prompt('个人备注（不会修改审核材料）',item.preference.note||item.note?.user_remark||'');if(note!==null)void update(item,{note});}}>编辑备注</button></details>
      <div className="row-actions"><button disabled={busy} aria-pressed={!!item.preference.favorite} onClick={()=>void update(item,{favorite:!item.preference.favorite})}>{item.preference.favorite?'取消收藏':'收藏'}</button><button disabled={busy} onClick={()=>void update(item,{hidden:!item.preference.hidden})}>{item.preference.hidden?'恢复学习':'暂不学'}</button><button disabled={busy} onClick={()=>{const feedback=window.prompt('哪里不清楚或有问题？反馈会绑定这条材料与版本，并暂时隐藏。');if(feedback?.trim())void update(item,{feedback,hidden:true});}}>材料有问题</button></div></article>)}</div>}
  </section>;
}
