'use client';
import Link from 'next/link';
import {useEffect,useState} from 'react';
import type {AttemptView} from '@/lib/speaking-practice/service';
import {MaterialsSummary} from './MaterialsSummary';
import {FourStepMasteryStudio} from './FourStepMasteryStudio';
import {AnswerComparison} from './AnswerComparison';
export function SpeakingAttemptResult({attempt:initialAttempt}:{attempt:AttemptView;allowLightStudy?:boolean}){
  const [attempt,setAttempt]=useState(initialAttempt),[error,setError]=useState(''),[busy,setBusy]=useState(false),[strengthen,setStrengthen]=useState(false);
  useEffect(()=>{if(attempt.status!=='processing')return;const controller=new AbortController();let inFlight=false;
    const timer=setInterval(()=>{if(inFlight)return;inFlight=true;void fetch(`/api/speaking-practice/attempts/${attempt.id}`,{signal:controller.signal}).then(async response=>{if(!response.ok)throw new Error('读取暂时中断，原回答已保存');const data=await response.json();if(!controller.signal.aborted)setAttempt(data.attempt);}).catch(reason=>{if(!controller.signal.aborted)setError(reason.message);}).finally(()=>{inFlight=false;});},1800);
    return()=>{controller.abort();clearInterval(timer);};
  },[attempt.id,attempt.status]);
  async function retry(){if(busy)return;setBusy(true);setError('');try{const response=await fetch(`/api/speaking-practice/attempts/${attempt.id}/retry`,{method:'POST'}),body=await response.json();if(!response.ok)throw new Error(body.error);setAttempt(body.attempt);}catch(reason){setError(reason instanceof Error?reason.message:'恢复失败');}finally{setBusy(false);}}
  if(strengthen)return <FourStepMasteryStudio attempt={attempt} onClose={()=>setStrengthen(false)}/>;
  return <div className="page-content"><Link className="exit-button" href={`/questions/${attempt.questionId}`}>← 返回题目与历史回答</Link>{error&&<p className="error-banner" role="alert">{error}</p>}
    {attempt.status==='completed'&&attempt.materialId?<MaterialsSummary analysis={attempt.analysis} materialId={attempt.materialId} questionId={attempt.questionId} sourceId={attempt.id} originalEnglish={attempt.answerText} originalChinese={attempt.intendedMeaningZh} onStrengthen={()=>setStrengthen(true)}/>:<section className="page-panel"><h1>{attempt.status==='processing'?'正在处理这次回答':'材料处理未完成'}</h1><p>原回答已保存。你可以离开，之后从本次回答继续。</p><p role="status">{attempt.processingStage||attempt.materialError||'正在对照英文与中文原意，整理并检查材料。'}</p><details><summary>查看已保存的英文回答与中文意图</summary><p lang="en">{attempt.answerText}</p><p>{attempt.intendedMeaningZh}</p></details><button className="secondary-button" disabled={busy} onClick={()=>void retry()}>{busy?'正在恢复…':'继续／恢复材料处理'}</button><p className="quiet">只处理未完成阶段；在线分析使用你的 API，历史材料不重新批量生成。</p></section>}
    <AnswerComparison attemptId={attempt.id}/>
  </div>;
}
