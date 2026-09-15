'use client';
import Link from 'next/link';
import {useEffect,useState} from 'react';
import type {AttemptView} from '@/lib/speaking-practice/service';
import {AnswerComparison} from './AnswerComparison';
import {ChineseAlignment} from './ChineseAlignment';
import {SpeakButton} from './SpeakButton';
import {NaturalVersionPlayer} from './NaturalVersionPlayer';
import styles from './sentence-study/SentenceMaterials.module.css';
interface ResultLesson {referenceText:string;sentences:Array<{id:string;chinese:string;english:string}>;needsAttention?:Array<{intentZh:string;reasonZh:string}>}
export function SpeakingAttemptResult({attempt:initialAttempt}:{attempt:AttemptView;allowLightStudy?:boolean}){
  const [attempt,setAttempt]=useState(initialAttempt),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  useEffect(()=>{if(attempt.status!=='processing')return;const controller=new AbortController();let inFlight=false;
    const timer=setInterval(()=>{if(inFlight)return;inFlight=true;void fetch(`/api/speaking-practice/attempts/${attempt.id}`,{signal:controller.signal}).then(async response=>{if(!response.ok)throw new Error('读取暂时中断，原回答已保存');const data=await response.json();if(!controller.signal.aborted)setAttempt(data.attempt);}).catch(reason=>{if(!controller.signal.aborted)setError(reason.message);}).finally(()=>{inFlight=false;});},1800);
    return()=>{controller.abort();clearInterval(timer);};
  },[attempt.id,attempt.status]);
  async function retry(){if(busy)return;const retryUnknown=attempt.materialDiagnostic?.requiresConfirmation??false;if(retryUnknown&&!window.confirm('上次结果尚未确认，重新请求可能再次计费，继续？'))return;setBusy(true);setError('');try{const response=await fetch(`/api/speaking-practice/attempts/${attempt.id}/retry`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({retryUnknown})}),body=await response.json();if(!response.ok)throw new Error(body.error);setAttempt(body.attempt);}catch(reason){setError(reason instanceof Error?reason.message:'恢复失败');}finally{setBusy(false);}}
  return <div className={`page-content material-result ${styles.page} ${styles.result}`}><nav className={styles.resultNav} aria-label="回答导航"><Link className="exit-button" href={`/questions/${encodeURIComponent(attempt.questionId)}`}>返回题目</Link><Link href={`/answer-history/${encodeURIComponent(attempt.questionId)}`}>回答与原声历史</Link></nav>{error&&<p className="error-banner" role="alert">{error}</p>}
    {attempt.materialTransition&&<p className="quiet" role="status">{attempt.materialTransition.message}</p>}
    {attempt.status==='completed'&&attempt.materialId?<CompletedAnswer key={attempt.materialId} attempt={attempt} materialId={attempt.materialId}/>:<section className={`page-panel ${styles.resultSection}`}><h1>{attempt.status==='processing'?'正在处理这次回答':'材料处理未完成'}</h1><p>原回答已保存。你可以离开，之后从本次回答继续。</p><p role="status">{attempt.materialError||attempt.processingStage||'正在对照英文与中文原意，整理并检查材料。'}</p><details><summary>查看已保存的原回答与中文意图</summary><p>{attempt.answerText}</p><p>{attempt.intendedMeaningZh}</p></details>{attempt.materialDiagnostic?.canRetry!==false&&<button className="secondary-button" disabled={busy} onClick={()=>void retry()}>{busy?'正在恢复…':attempt.materialDiagnostic?.needsSettings?'检查设置后重试':'继续／恢复材料处理'}</button>}{attempt.materialDiagnostic?.needsSettings&&<Link className="secondary-button" href="/settings">查看服务设置</Link>}{attempt.materialDiagnostic&&<details><summary>查看安全诊断信息</summary><pre>{JSON.stringify(attempt.materialDiagnostic.details,null,2)}</pre></details>}<p className="quiet">只处理未完成阶段；在线分析使用你的 API，历史材料不重新批量生成。</p></section>}
    <AnswerComparison attemptId={attempt.id}/>
  </div>;
}

function CompletedAnswer({attempt,materialId}:{attempt:AttemptView;materialId:string}){
  const [lesson,setLesson]=useState<ResultLesson|null|undefined>(),[error,setError]=useState(''),[reload,setReload]=useState(0),[sentencesOpen,setSentencesOpen]=useState(false);
  useEffect(()=>{const controller=new AbortController();setError('');void fetch(`/api/sentence-study/materials/${encodeURIComponent(materialId)}`,{signal:controller.signal,cache:'no-store'}).then(async response=>{const body=await response.json();if(!response.ok)throw new Error(body.error??'自然回答暂时无法读取。');return body.lesson as ResultLesson|null;}).then(value=>{if(!controller.signal.aborted)setLesson(value);}).catch(reason=>{if(!controller.signal.aborted)setError(reason instanceof Error?reason.message:'自然回答暂时无法读取。');});return()=>controller.abort();},[materialId,reload]);
  const analysis=attempt.analysis;
  const bases=analysis.learningMaterials.map(row=>{
    const basis=row.learningBasis??analysis.gaps.find(gap=>gap.key===row.gapId)?.learningBasis;if(basis)return basis;
    const unit=analysis.evidence?.diagnosis.units.find(unit=>unit.gaps.some(gap=>gap.id===row.gapId));
    const selected=analysis.evidence?.selection.units.find(item=>item.unitId===unit?.id)?.status;
    return selected==='repair'?'confirmed_error':selected==='missing'?'preparation':undefined;
  });
  const preparedCount=bases.filter(basis=>basis==='preparation').length,repairCount=bases.filter(basis=>basis==='confirmed_error').length;
  const sourceAttention=analysis.needsAttention??analysis.evidence?.selection.units.filter(unit=>unit.status==='uncertain').map(item=>({intentZh:analysis.evidence?.diagnosis.units.find(unit=>unit.id===item.unitId)?.intentZh??'待确认的意思',reasonZh:item.reasonZh}))??[];
  const attention=[...sourceAttention,...lesson?.needsAttention??[]].filter((item,index,all)=>all.findIndex(other=>other.intentZh===item.intentZh&&other.reasonZh===item.reasonZh)===index);
  const questionHref=`/questions/${encodeURIComponent(attempt.questionId)}`,studyHref=`/sentence-study?scope=material&id=${encodeURIComponent(materialId)}&mode=learn`;
  return <>
    <section className={`page-panel ${styles.resultSection}`}><h1>把这道题连起来说</h1><p>原回答和这版材料都已保存。先看完整意思，再按需要揭晓、看讲解或重说。</p>{analysis.corrections[0]&&<p className={styles.resultFeedback}>{analysis.corrections[0].reasonZh}</p>}
      {lesson?.sentences.length?<div className={styles.resultActions}><Link className="primary-button" href={studyHref}>开始整题学习</Link><span>{lesson.sentences.length} 句当前材料</span></div>:<p role="status">{lesson===undefined?'正在读取已审核的自然回答…':'清楚的句子仍在整理或等待原意确认，原回答保留。'}</p>}
      {error&&<div className={styles.resultError} role="alert"><p>{error}</p><button type="button" className="secondary-button" onClick={()=>setReload(value=>value+1)}>重新读取自然回答</button></div>}
    </section>
    {lesson?.referenceText&&<section className={`page-panel ${styles.resultSection}`}><div className={styles.naturalHeading}><h2>{attention.length?'已确认的自然表达':'你的自然回答'}</h2>{!attention.length&&<SpeakButton text={lesson.referenceText} style="ielts-answer" label="播放自然回答全文" playbackMode="natural"/>}</div>{attention.length>0&&<p className={styles.resultFeedback}>以下是已确认的部分，另有细节待补充；暂不当作完整回答。</p>}<p className={`material-natural-text ${styles.naturalText}`} lang="en">{lesson.referenceText}</p><details open={sentencesOpen} onToggle={event=>setSentencesOpen(event.currentTarget.open)}><summary>逐句试听</summary>{sentencesOpen&&(attention.length?lesson.sentences.map((sentence,index)=><div className={styles.listenSentence} key={sentence.id}><p lang="en">{sentence.english}</p><SpeakButton text={sentence.english} style="ielts-answer" label={`试听第 ${index+1} 句`} playbackMode="natural"/></div>):<NaturalVersionPlayer naturalVersion={lesson.referenceText} style="ielts-answer"/>)}</details></section>}
    <section className={`page-panel ${styles.resultSection}`}><h2>想再说一次？</h2><p>可以保留新的原声，回听不同日期、不同提示条件下的回答。</p><div className={styles.resultActions}><Link className="secondary-button" href={`${questionHref}/practice?kind=independent&source=${encodeURIComponent(attempt.id)}`}>不看提示，重新回答</Link><Link href={`/answer-history/${encodeURIComponent(attempt.questionId)}`}>比较历次原声</Link></div></section>
    {attention.length>0&&<details className={`page-panel ${styles.resultSection}`}><summary>有 {attention.length} 处意思待确认</summary><p>明确的部分可以先学，下面这些意思还需要补充。</p><ul>{attention.map((item,index)=><li key={index}><p>{item.intentZh}</p><p className={styles.resultFeedback}>{item.reasonZh}</p></li>)}</ul></details>}
    <details className={`page-panel ${styles.resultSection}`}><summary>我的原回答与补充原意</summary><p className={styles.originalText}>{attempt.answerText||'本次未提供原回答文本。'}</p>{attempt.intendedMeaningZh&&<><h3>补充的中文原意</h3><p className={styles.originalText}>{attempt.intendedMeaningZh}</p></>}<Link href={`${questionHref}/practice?kind=edit&source=${encodeURIComponent(attempt.id)}`}>编辑为新版本</Link></details>
    <details className={`page-panel ${styles.resultSection}`}><summary>回答说明与纠错依据</summary><p>准备表达 {preparedCount} 项，修复表达 {repairCount} 项。准备表达不代表曾经犯错；确认的问题保留原句依据。</p>{analysis.evidence?.diagnosis.units.map(unit=><article key={unit.id}><h3>{unit.intentZh}</h3><p>{analysis.evidence?.selection.units.find(item=>item.unitId===unit.id)?.reasonZh}</p></article>)}{analysis.corrections.map((correction,index)=><article key={index}><p lang="en">原表达：{correction.original}</p><p lang="en">参考表达：{correction.corrected}</p><p>{correction.reasonZh}</p></article>)}</details>
    <ChineseAlignment key={attempt.id} questionId={attempt.questionId} sourceId={attempt.id} originalEnglish={attempt.answerText} originalChinese={attempt.intendedMeaningZh} analysis={analysis}/>
    <details className={`page-panel ${styles.resultSection}`}><summary>拓展功能与旧学习记录</summary><p>需要时可主动进入四步强化；整题学习和句子复习的记录分别保留。</p><Link href={`/extensions?material=${encodeURIComponent(materialId)}`}>进入拓展功能</Link></details>
  </>;
}
