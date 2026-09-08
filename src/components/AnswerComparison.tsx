'use client';
import {useEffect,useState} from 'react';
import type {createPracticeComparison} from '@/lib/app-services/answer-comparison';
type View=Awaited<ReturnType<ReturnType<typeof createPracticeComparison>['get']>>;
export function AnswerComparison({attemptId}:{attemptId:string}){
  const [view,setView]=useState<View>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[refresh,setRefresh]=useState(0);
  useEffect(()=>{const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;
    const load=async()=>{try{const response=await fetch(`/api/speaking-practice/attempts/${attemptId}/comparison`,{signal:controller.signal}),body=await response.json();if(!response.ok)throw new Error(body.error);if(controller.signal.aborted)return;setView(body.comparison);if(body.comparison&&['queued','generating','not_started','waiting_materials'].includes(body.comparison.status))timer=setTimeout(()=>void load(),2500);}catch(reason){if(!controller.signal.aborted)setError(reason instanceof Error?reason.message:'对照读取失败');}};void load();return()=>{controller.abort();clearTimeout(timer);};
  },[attemptId,refresh]);
  async function retry(){if(busy)return;setBusy(true);try{const retryUnknown=view&&'errorCode' in view&&view.errorCode==='result_unknown';if(retryUnknown&&!window.confirm('上次对照结果未知，重试可能再次使用 API 余额，继续？'))return;const response=await fetch(`/api/speaking-practice/attempts/${attemptId}/comparison`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({retryUnknown:!!retryUnknown})});if(!response.ok)throw new Error('暂时无法恢复对照');setRefresh(n=>n+1);setError('');}catch(reason){setError(reason instanceof Error?reason.message:'对照未保存');}finally{setBusy(false);}}
  if(!view&&!error)return null;
  const labels={improved:'本次改善',repeated:'仍然出现',uncertain:'证据不足'};
  return <section className="page-panel" id="answer-comparison"><h2>这次与上次相比</h2><p>只依据真实原句判断。没有再次提到旧问题不等于修复，也不代表稳定掌握。</p>{error&&<p role="alert">{error}</p>}{view&&'result' in view&&view.result?<><p>{view.sameDay?'同日练习：不作为跨日掌握证据。':'这是不同日期的无提示回答，不等于自动认定掌握。'}</p>{view.result.comparisons.map(row=><article key={row.index}><h3>{labels[row.state]} · {view.payload.oldItems[row.index].intentZh}</h3><p>之前：<span lang="en">{view.payload.oldItems[row.index].evidence||'没有对应英文'}</span></p><p>本次：<span lang="en">{row.evidenceQuote||'没有可引用的相关原句'}</span></p><p>{row.reasonZh}</p></article>)}{view.result.newItemIndexes.map(index=><article key={index}><h3>新问题 · {view.payload.currentItems[index].intentZh}</h3><p lang="en">{view.payload.currentItems[index].evidence}</p></article>)}</>:<><p>对照尚未完成；本次回答和学习材料不受影响。</p><button disabled={busy} className="secondary-button" onClick={()=>void retry()}>继续／重试对照</button></>}</section>;
}
