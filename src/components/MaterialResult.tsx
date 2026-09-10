'use client';
import {useEffect,useState} from 'react';
import Link from 'next/link';
import type {MaterialRow,MaterialInput} from '@/lib/four-step/material-types';
import type {SpeakingAttemptAnalysis} from '@/lib/speaking-practice/schemas';
import {MaterialsSummary} from './MaterialsSummary';
import styles from './MaterialResult.module.css';
import {materialDiagnostic,type MaterialDiagnostic} from '@/lib/four-step/material-status';

type MaterialView={material:MaterialRow;analysis:SpeakingAttemptAnalysis|null;verified:boolean;diagnostic?:MaterialDiagnostic|null;transition?:{fromMaterialId:string;toMaterialId:string;message:string}|null};
function readableMessage(value:unknown,fallback:string){return typeof value==='string'&&/[\u3400-\u9fff]/u.test(value)?value:fallback;}
function failureMessage(code:string|null){
  if(code==='result_unknown')return '上次处理结果还未确认。请先重新读取进度；重新处理可能再次产生费用。';
  if(code==='request_pending')return '上次请求仍在处理，可以稍后回来或重新读取进度。';
  if(code&&/config|key|auth|credential/.test(code))return 'AI 服务配置暂时不可用。请在学习设置中检查服务状态，再继续处理。';
  if(code&&/review|coverage|validation|material_.*invalid/.test(code))return '材料还未通过审核，暂时不能进入学习。可以重新处理，也可以先返回查看原内容。';
  return '这次材料处理没有完成。原内容仍在，可以从这里继续处理。';
}
export function MaterialResult({id}:{id:string}){
  const [data,setData]=useState<MaterialView|null>(null),[error,setError]=useState(''),[errorCode,setErrorCode]=useState('');
  const [busy,setBusy]=useState(false),[reload,setReload]=useState(0),[notice,setNotice]=useState('');
  useEffect(()=>{
    const controller=new AbortController();let inFlight=false;
    const load=async()=>{
      if(inFlight)return;inFlight=true;
      try{
        const response=await fetch(`/api/materials/${id}`,{signal:controller.signal}),result=await response.json();
        if(!response.ok)throw Object.assign(new Error(readableMessage(result.error,'暂时无法读取材料，请稍后重新读取。')),{code:result.code});
        if(!controller.signal.aborted){setData(result);setError('');setErrorCode('');if(!['queued','generating','reviewing','processing'].includes(result.material?.status))clearInterval(timer);}
      }catch(reason){
        if(!controller.signal.aborted){setError(readableMessage(reason instanceof Error?reason.message:null,'暂时无法读取材料，请稍后重新读取。'));setErrorCode(reason&&typeof reason==='object'&&'code' in reason?String(reason.code??''):'');}
      }finally{inFlight=false;}
    };
    const timer=setInterval(()=>void load(),2500);void load();
    return()=>{controller.abort();clearInterval(timer);};
  },[id,reload]);
  async function retry(){
    if(busy)return;
    const retryUnknown=data?.diagnostic?.requiresConfirmation??/result_unknown|network_error|timeout/.test(data?.material.error_code??'');
    if(retryUnknown&&!window.confirm('上次请求结果未知，重新处理可能再次使用 API 余额，继续？'))return;
    setBusy(true);setNotice('');
    try{
      const response=await fetch(`/api/materials/${id}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({retryUnknown})}),result=await response.json();
      if(!response.ok)throw Object.assign(new Error(readableMessage(result.error,'恢复处理没有启动，请稍后重试。')),{code:result.code});
      setError('');setErrorCode('');setNotice(result.transition?.message??'已请求继续处理，进度会在这里更新。');setReload(value=>value+1);
    }catch(reason){setError(readableMessage(reason instanceof Error?reason.message:null,'恢复处理没有启动，请稍后重试。'));setErrorCode(reason&&typeof reason==='object'&&'code' in reason?String(reason.code??''):'');}
    finally{setBusy(false);}
  }
  let input:MaterialInput|null=null;
  if(data){try{input=JSON.parse(data.material.input_json) as MaterialInput;}catch{/* Preserve the saved source when its snapshot cannot be read. */}}
  const material=data?.material,unknown=material?.error_code==='result_unknown';
  const diagnostic=data?.diagnostic??(material?.error_code?materialDiagnostic(material.error_code):null);
  const failed=material?.status==='failed',unverified=material?.status==='ready'&&!data?.verified;
  const unavailable=!!material&&!['queued','generating','reviewing','failed','ready'].includes(material.status);
  const title=!material?'正在读取材料':unavailable?'这份材料暂不使用':unknown?'需要确认处理结果':failed||unverified?'材料暂未准备好':material.status==='reviewing'?'正在审核学习材料':'正在整理你的表达';
  return <div className="page-content">
    <Link className="exit-button" href={material?.source_type==='free_talk'?`/free-talk?conversation=${material.source_id}`:'/questions'}>返回来源</Link>
    {error&&<div className={styles.error} role="alert"><p>{error}</p>{errorCode&&<details><summary>查看错误详情</summary><code>{errorCode}</code></details>}<button type="button" className="secondary-button" onClick={()=>setReload(value=>value+1)}>重新读取</button></div>}
    {data?.transition&&<p role="status">{data.transition.message}</p>}
    {data?.verified&&data.analysis?<MaterialsSummary materialId={data.material.id} analysis={data.analysis} questionId={material?.question_id??undefined} sourceId={data.material.source_id} originalEnglish={input?.actualAnswer??''} originalChinese={input?.intendedMeaningZh??''} onStrengthen={()=>{}}/>:<section className={styles.statePanel} aria-live="polite">
      <h1>{title}</h1>
      {material&&<p>原回答和消息快照已保留，不用重新输入。</p>}
      <p>{!material?'稍等片刻，正在读取已保存的进度。':unavailable?'原内容和历史记录仍保留，请返回来源查看。':unverified?'这份材料尚未通过可学习检查。可以重新读取，或返回来源查看原内容。':failed||material.error_code?diagnostic?.message??failureMessage(material.error_code):'材料检查通过后，就可以开始句子学习。你也可以先离开，稍后从原回答或对话回来。'}</p>
      {notice&&<p role="status">{notice}</p>}
      {material&&!unavailable&&<div className={styles.actions}>
        {(failed||unknown||unverified)&&<button type="button" className="secondary-button" onClick={()=>setReload(value=>value+1)}>重新读取进度</button>}
        {!unverified&&diagnostic?.canRetry!==false&&<button type="button" className={failed&&!unknown?'primary-button':'secondary-button'} disabled={busy} onClick={()=>void retry()}>{busy?'正在请求恢复…':unknown?'确认后重新处理':diagnostic?.needsSettings?'检查设置后重试':'继续／恢复处理'}</button>}
        {diagnostic?.needsSettings&&<Link className="secondary-button" href="/settings">查看服务设置</Link>}
      </div>}
      {material?.error_code&&<details className={styles.details}><summary>查看处理详情</summary><p>阶段：{diagnostic?.stage}</p><p>错误代码：<code>{material.error_code}</code></p>{diagnostic&&Object.keys(diagnostic.details).length>0&&<pre>{JSON.stringify(diagnostic.details,null,2)}</pre>}</details>}
    </section>}
  </div>;
}
