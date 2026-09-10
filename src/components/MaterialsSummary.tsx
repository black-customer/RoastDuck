'use client';
import Link from 'next/link';
import {useEffect,useState} from 'react';
import type {SpeakingAttemptAnalysis} from '@/lib/speaking-practice/schemas';
import {SpeakButton} from './SpeakButton';
import {NaturalVersionPlayer} from './NaturalVersionPlayer';
import {ChineseAlignment} from './ChineseAlignment';
interface MaterialLesson {referenceText:string;sentences:Array<{id:string;chinese:string;english:string}>;needsAttention?:Array<{intentZh:string;reasonZh:string}>}
export function MaterialsSummary({analysis,materialId,questionId,sourceId,originalEnglish,originalChinese,initialLesson}:{analysis:SpeakingAttemptAnalysis;materialId:string;questionId?:string;sourceId:string;originalEnglish:string;originalChinese:string;onStrengthen:()=>void;initialLesson?:MaterialLesson|null}){
  const rows=analysis.learningMaterials;
  const [sentencesOpen,setSentencesOpen]=useState(false);
  const [lesson,setLesson]=useState<MaterialLesson|null|undefined>(initialLesson),[readError,setReadError]=useState(''),[readAttempt,setReadAttempt]=useState(0);
  useEffect(()=>{if(initialLesson!==undefined){setLesson(initialLesson);return;}const controller=new AbortController();setReadError('');void fetch(`/api/sentence-study/materials/${encodeURIComponent(materialId)}`,{signal:controller.signal}).then(async r=>{if(!r.ok)throw new Error('暂时无法读取句子版本');return r.json();}).then(body=>{if(!controller.signal.aborted)setLesson(body.lesson);}).catch(e=>{if(!controller.signal.aborted)setReadError(e.message);});return()=>controller.abort();},[materialId,initialLesson,readAttempt]);
  const naturalVersion=lesson?.referenceText??'';
  const learningBases=rows.map(row=>{
    const basis=row.learningBasis??analysis.gaps.find(gap=>gap.key===row.gapId)?.learningBasis;
    if(basis)return basis;
    const unit=analysis.evidence?.diagnosis.units.find(unit=>unit.gaps.some(gap=>gap.id===row.gapId));
    const status=analysis.evidence?.selection.units.find(review=>review.unitId===unit?.id)?.status;
    return status==='repair'?'confirmed_error':status==='missing'?'preparation':undefined;
  });
  const preparedCount=learningBases.filter(basis=>basis==='preparation').length,repairCount=learningBases.filter(basis=>basis==='confirmed_error').length;
  const unclassifiedCount=rows.length-preparedCount-repairCount;
  const sourceAttention=analysis.needsAttention??analysis.evidence?.selection.units.filter(unit=>unit.status==='uncertain').map(review=>({
    intentZh:analysis.evidence?.diagnosis.units.find(unit=>unit.id===review.unitId)?.intentZh??'尚未确认的意思',reasonZh:review.reasonZh,
  }))??[];
  const needsAttention=[...sourceAttention,...lesson?.needsAttention??[]].filter((item,index,all)=>all.findIndex(other=>other.intentZh===item.intentZh&&other.reasonZh===item.reasonZh)===index);
  return <div className="material-result"><section className="page-panel material-summary"><h1>把你想说的话，一句句学会表达</h1><p>先回想完整意思，再看自然英文。可以随时暂停，复习会按你的回想情况安排。</p>
    {analysis.corrections[0]&&<p className="material-feedback">{analysis.corrections[0].reasonZh}</p>}
    {lesson?.sentences.length?<><p>{lesson.sentences.length} 句可逐句学习</p><Link className="primary-button" href={`/sentence-study?scope=material&id=${encodeURIComponent(materialId)}&mode=learn`}>开始句子学习</Link></>:<p role="status">{lesson===undefined?'正在读取已审核的句子版本…':'明确的句子还在整理或等待原意确认，原回答已保留。'}</p>}
    {readError&&<p role="alert">{readError} <button className="secondary-button" onClick={()=>setReadAttempt(n=>n+1)}>重新读取</button></p>}
    <div className="row-actions">{questionId&&<><Link className="secondary-button" href={`/questions/${questionId}/practice?kind=independent&source=${encodeURIComponent(sourceId)}`}>不看提示，重新回答</Link><Link href={`/questions/${questionId}/practice?kind=edit&source=${encodeURIComponent(sourceId)}`}>编辑为新版本</Link></>}</div></section>
    {naturalVersion&&<section className="page-panel material-natural"><div className="material-natural-heading"><h2>你的自然表达</h2><SpeakButton text={naturalVersion} style={questionId?'ielts-answer':'daily-conversation'} label="播放自然表达全文" playbackMode="natural"/></div><p lang="en" className="material-natural-text">{naturalVersion}</p><details open={sentencesOpen} onToggle={event=>setSentencesOpen(event.currentTarget.open)}><summary>逐句试听</summary>{sentencesOpen&&<NaturalVersionPlayer naturalVersion={naturalVersion} style={questionId?'ielts-answer':'daily-conversation'}/>}</details></section>}
    {needsAttention.length>0&&<details className="page-panel"><summary>有 {needsAttention.length} 处意思待确认</summary><p>明确的部分可以先学；下面这些意思需要你的补充。</p><ul>{needsAttention.map((item,index)=><li key={index}><p>{item.intentZh}</p><p className="material-feedback">{item.reasonZh}</p></li>)}</ul></details>}
    <details className="page-panel"><summary>我的原回答（中文、英文或混合）与补充原意</summary><p>{originalEnglish||'本次未提供原回答文本。'}</p>{originalChinese&&<><h3>补充的中文原意</h3><p>{originalChinese}</p></>}</details>
    <details className="page-panel"><summary>完整问题账本与纠错依据</summary><p>准备表达 {preparedCount} 项，修复表达 {repairCount} 项。{unclassifiedCount>0&&`另有 ${unclassifiedCount} 项未标注类型。`}准备项不代表你曾经犯错。</p>{analysis.evidence?.diagnosis.units.map(unit=><article key={unit.id}><h3>{unit.intentZh}</h3><p>{analysis.evidence?.selection.units.find(s=>s.unitId===unit.id)?.reasonZh}</p></article>)}{analysis.corrections.map((c,i)=><article key={i}><p lang="en">原表达：{c.original}</p><p lang="en">参考表达：{c.corrected}</p><p>{c.reasonZh}</p></article>)}</details>
    {questionId&&<ChineseAlignment key={sourceId} questionId={questionId} sourceId={sourceId} originalEnglish={originalEnglish} originalChinese={originalChinese} analysis={analysis}/>}
    <Link className="exit-button" href={`/extensions?material=${encodeURIComponent(materialId)}`}>拓展功能与原学习记录</Link>
  </div>;
}
