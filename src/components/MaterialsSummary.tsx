'use client';
import Link from 'next/link';
import {useMemo,useState} from 'react';
import type {SpeakingAttemptAnalysis} from '@/lib/speaking-practice/schemas';
import {ExpressionLibrary} from './ExpressionLibrary';
import {SpeakButton} from './SpeakButton';
import {NaturalVersionPlayer} from './NaturalVersionPlayer';
export function MaterialsSummary({analysis,materialId,questionId,sourceId,originalEnglish,originalChinese,onStrengthen}:{analysis:SpeakingAttemptAnalysis;materialId:string;questionId?:string;sourceId:string;originalEnglish:string;originalChinese:string;onStrengthen:()=>void}){
  const scope=useMemo(()=>({type:'material' as const,id:materialId}),[materialId]),rows=analysis.learningMaterials;
  const [sentencesOpen,setSentencesOpen]=useState(false);
  const learningBases=rows.map(row=>{
    const basis=row.learningBasis??analysis.gaps.find(gap=>gap.key===row.gapId)?.learningBasis;
    if(basis)return basis;
    const unit=analysis.evidence?.diagnosis.units.find(unit=>unit.gaps.some(gap=>gap.id===row.gapId));
    const status=analysis.evidence?.selection.units.find(review=>review.unitId===unit?.id)?.status;
    return status==='repair'?'confirmed_error':status==='missing'?'preparation':undefined;
  });
  const preparedCount=learningBases.filter(basis=>basis==='preparation').length,repairCount=learningBases.filter(basis=>basis==='confirmed_error').length;
  const unclassifiedCount=rows.length-preparedCount-repairCount;
  const needsAttention=analysis.needsAttention??analysis.evidence?.selection.units.filter(unit=>unit.status==='uncertain').map(review=>({
    intentZh:analysis.evidence?.diagnosis.units.find(unit=>unit.id===review.unitId)?.intentZh??'尚未确认的意思',reasonZh:review.reasonZh,
  }))??[];
  return <div className="material-result"><section className="page-panel material-summary"><h1>{rows.length?`${rows.length} 个可学习的表达`:'本次没有确认的学习表达'}</h1><p>{rows.length?'从你想说的意思开始。每次学几个，不必一次学完整份材料。':'没有确认需要制卡的表达，不代表完整口语能力已经通过检验。'}</p>
    {rows.length>0&&<p>准备表达 {preparedCount} 项，修复表达 {repairCount} 项。{unclassifiedCount>0&&`另有 ${unclassifiedCount} 项未标注准备或修复类型。`}</p>}
    {preparedCount>0&&<p className="material-feedback">准备表达来自你明确想说、但还未展示英文表达能力的意思，不计作已犯错误。</p>}
    {analysis.corrections[0]&&<p className="material-feedback">{analysis.corrections[0].reasonZh}</p>}
    {needsAttention.length>0&&<div><h2>有 {needsAttention.length} 处意思待确认</h2><p>{rows.length?'这些部分暂未制卡；已确认的表达可以先学。':'这些部分暂未制卡，可以先补充或澄清原意。'}</p><ul>{needsAttention.map((item,index)=><li key={index}><p>{item.intentZh}</p><p className="material-feedback">{item.reasonZh}</p></li>)}</ul></div>}
    {rows.length>0&&<Link className="primary-button" href={`/light-study?scope=material&id=${encodeURIComponent(materialId)}&mode=learn`}>轻松学本次表达</Link>}
    <div className="row-actions">{rows.length>0&&<><Link className="secondary-button" href={`/quick-review?scope=material&id=${encodeURIComponent(materialId)}`}>快速回顾本次表达</Link><button type="button" className="secondary-button" onClick={onStrengthen}>可选：四步强化</button></>}{questionId&&<><Link className="secondary-button" href={`/questions/${questionId}/practice?kind=independent&source=${encodeURIComponent(sourceId)}`}>不看提示，重新回答</Link><Link href={`/questions/${questionId}/practice?kind=edit&source=${encodeURIComponent(sourceId)}`}>编辑为新版本</Link></>}</div></section>
    <details className="page-panel"><summary>查看四列材料、收藏与调整</summary><ExpressionLibrary scope={scope}/><div className="materials-table-wrapper"><table className="materials-table"><thead><tr><th>想表达的意思</th><th>英文表达</th><th>完整中文原意</th><th>自然英文句子</th></tr></thead><tbody>{rows.map((row,index)=><tr key={index}><td>{row.recallPromptZh??row.chineseChunk}</td><td lang="en">{row.recallAnswerEn??row.englishChunk}{row.pattern&&<small>句式：{row.pattern}</small>}</td><td>{row.yourChineseSentence}</td><td lang="en">{row.naturalEnglishSentence}</td></tr>)}</tbody></table></div></details>
    <details className="page-panel" onToggle={event=>{if(!event.currentTarget.open)setSentencesOpen(false);}}><summary>自然表达全文与逐句试听</summary><p lang="en">{analysis.naturalVersion}</p><SpeakButton text={analysis.naturalVersion} style={questionId?'ielts-answer':'daily-conversation'} label="播放自然表达全文"/><details open={sentencesOpen} onToggle={event=>setSentencesOpen(event.currentTarget.open)}><summary>逐句播放（可选）</summary>{sentencesOpen&&<NaturalVersionPlayer naturalVersion={analysis.naturalVersion} style={questionId?'ielts-answer':'daily-conversation'}/>}</details></details>
    <details className="page-panel"><summary>我的原回答（中文、英文或混合）与补充原意</summary><p>{originalEnglish||'本次未提供原回答文本。'}</p>{originalChinese&&<><h3>补充的中文原意</h3><p>{originalChinese}</p></>}</details>
    <details className="page-panel"><summary>完整问题账本与纠错依据</summary><p>已经自然表达、不确定的意思同样保留，不等于每项都要训练。</p>{analysis.evidence?.diagnosis.units.map(unit=><article key={unit.id}><h3>{unit.intentZh}</h3><p>{analysis.evidence?.selection.units.find(s=>s.unitId===unit.id)?.reasonZh}</p></article>)}{analysis.corrections.map((c,i)=><article key={i}><p lang="en">原表达：{c.original}</p><p lang="en">参考表达：{c.corrected}</p><p>{c.reasonZh}</p></article>)}</details>
  </div>;
}
