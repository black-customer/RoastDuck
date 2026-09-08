'use client';
import {useEffect,useState} from 'react';
import Link from 'next/link';
import type {MaterialRow,MaterialInput} from '@/lib/four-step/material-types';
import type {SpeakingAttemptAnalysis} from '@/lib/speaking-practice/schemas';
import {MaterialsSummary} from './MaterialsSummary';
import {FourStepMasteryStudio} from './FourStepMasteryStudio';
export function MaterialResult({id}:{id:string}){
  const [data,setData]=useState<{material:MaterialRow;analysis:SpeakingAttemptAnalysis|null;verified:boolean}|null>(null),[error,setError]=useState(''),[strengthen,setStrengthen]=useState(false),[busy,setBusy]=useState(false);
  useEffect(()=>{const controller=new AbortController();let inFlight=false;const load=async()=>{if(inFlight)return;inFlight=true;try{const response=await fetch(`/api/materials/${id}`,{signal:controller.signal}),result=await response.json();if(!response.ok)throw new Error(result.error);if(!controller.signal.aborted)setData(result);}catch(reason){if(!controller.signal.aborted)setError(reason instanceof Error?reason.message:'读取失败');}finally{inFlight=false;}};void load();const timer=setInterval(()=>void load(),2500);return()=>{controller.abort();clearInterval(timer);};},[id]);
  async function retry(){if(busy)return;setBusy(true);try{const retryUnknown=data?.material.error_code==='result_unknown';if(retryUnknown&&!window.confirm('上次请求结果未知，重新处理可能再次使用 API 余额，继续？'))return;const response=await fetch(`/api/materials/${id}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({retryUnknown})});if(!response.ok)throw new Error('重试未启动');setError('');}catch(reason){setError(reason instanceof Error?reason.message:'重试失败');}finally{setBusy(false);}}
  if(strengthen)return <FourStepMasteryStudio materialId={id} onClose={()=>setStrengthen(false)}/>;
  const input=data?JSON.parse(data.material.input_json) as MaterialInput:null;
  return <div className="page-content"><Link className="exit-button" href={data?.material.source_type==='free_talk'?`/free-talk?conversation=${data.material.source_id}`:'/questions'}>← 返回来源</Link>{error&&<p role="alert">{error}</p>}{data?.verified&&data.analysis?<MaterialsSummary materialId={id} analysis={data.analysis} questionId={data.material.question_id??undefined} sourceId={data.material.source_id} originalEnglish={input?.actualAnswer??''} originalChinese={input?.intendedMeaningZh??''} onStrengthen={()=>setStrengthen(true)}/>:<section className="page-panel"><h1>材料{data?.material.status==='failed'?'暂未处理完成':'正在处理'}</h1><p>真实消息快照已保存，检查通过后可直接轻松学。</p><p>{data?.material.error_code}</p><button className="secondary-button" disabled={busy} onClick={()=>void retry()}>继续／恢复处理</button></section>}</div>;
}
