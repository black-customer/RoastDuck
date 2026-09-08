'use client';
import Link from 'next/link';
import {useMemo} from 'react';
import type {SpeakingAttemptAnalysis} from '@/lib/speaking-practice/schemas';
import {ExpressionLibrary} from './ExpressionLibrary';
import {SpeakButton} from './SpeakButton';
import {NaturalVersionPlayer} from './NaturalVersionPlayer';
export function MaterialsSummary({analysis,materialId,questionId,sourceId,originalEnglish,originalChinese,onStrengthen}:{analysis:SpeakingAttemptAnalysis;materialId:string;questionId?:string;sourceId:string;originalEnglish:string;originalChinese:string;onStrengthen:()=>void}){
  const scope=useMemo(()=>({type:'material' as const,id:materialId}),[materialId]),rows=analysis.learningMaterials;
  return <div className="material-result"><section className="page-panel material-summary"><p className="eyebrow">本次回答的学习材料</p><h1>{rows.length?`${rows.length} 个值得学习的表达`:'本次无需加入强化的表达'}</h1><p>{rows.length?'从你想说、却还未自然表达的意思开始。每次学几个，不必一次学完整份材料。':'没有确认需要制卡的缺口，不代表完整口语能力已经通过检验。'}</p>{analysis.corrections[0]&&<p className="material-feedback">{analysis.corrections[0].reasonZh}</p>}
    {analysis.evidence?.selection.units.some(u=>u.status==='uncertain')&&<p>还有意思不确定的内容，保留在问题账本，不强行制卡。</p>}
    {rows.length>0&&<Link className="primary-button" href={`/light-study?scope=material&id=${encodeURIComponent(materialId)}`}>轻松学本次表达</Link>}
    <div className="row-actions">{rows.length>0&&<button className="secondary-button" onClick={onStrengthen}>可选：四步强化</button>}{questionId&&<><Link className="secondary-button" href={`/questions/${questionId}/practice?kind=independent&source=${encodeURIComponent(sourceId)}`}>不看提示，重新回答</Link><Link href={`/questions/${questionId}/practice?kind=edit&source=${encodeURIComponent(sourceId)}`}>编辑为新版本</Link></>}</div></section>
    <details className="page-panel"><summary>查看四列材料、收藏与调整</summary><ExpressionLibrary scope={scope}/><div className="materials-table-wrapper"><table className="materials-table"><thead><tr><th>想表达的意思</th><th>英文表达</th><th>完整中文原意</th><th>自然英文句子</th></tr></thead><tbody>{rows.map((row,index)=><tr key={index}><td>{row.chineseChunk}</td><td lang="en">{row.englishChunk}</td><td>{row.yourChineseSentence}</td><td lang="en">{row.naturalEnglishSentence}</td></tr>)}</tbody></table></div></details>
    <details className="page-panel"><summary>自然表达全文与逐句试听</summary><p lang="en">{analysis.naturalVersion}</p><SpeakButton text={analysis.naturalVersion} label="播放自然表达全文"/><details><summary>逐句播放（可选）</summary><NaturalVersionPlayer naturalVersion={analysis.naturalVersion}/></details></details>
    <details className="page-panel"><summary>我的原回答与中文意思</summary><p lang="en">{originalEnglish||'这次明确选择了暂时不会用英文表达。'}</p><p>{originalChinese||'未补充中文，仅依据本次英文分析。'}</p></details>
    <details className="page-panel"><summary>完整问题账本与纠错依据</summary><p>已经自然表达、不确定的意思同样保留，不等于每项都要训练。</p>{analysis.evidence?.diagnosis.units.map(unit=><article key={unit.id}><h3>{unit.intentZh}</h3><p>{analysis.evidence?.selection.units.find(s=>s.unitId===unit.id)?.reasonZh}</p></article>)}{analysis.corrections.map((c,i)=><article key={i}><p lang="en">原表达：{c.original}</p><p lang="en">参考表达：{c.corrected}</p><p>{c.reasonZh}</p></article>)}</details>
  </div>;
}
