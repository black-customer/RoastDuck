'use client';
import {useEffect,useRef,useState} from 'react';
import {useRouter} from 'next/navigation';
import type {SpeakingAttemptAnalysis} from '@/lib/speaking-practice/schemas';
export function ChineseAlignment({questionId,sourceId,originalEnglish,originalChinese,analysis}:{questionId:string;sourceId:string;originalEnglish:string;originalChinese:string;analysis:SpeakingAttemptAnalysis}){
  const router=useRouter(),request=useRef(crypto.randomUUID());
  const relevantChinese=analysis.evidence?analysis.evidence.diagnosis.units.filter(u=>u.status!=='non_answer').flatMap(u=>u.chinese.map(r=>r.text)).filter(t=>originalChinese.includes(t)):[];
  const [text,setText]=useState(analysis.evidence&&!relevantChinese.length?'':originalChinese),[busy,setBusy]=useState(false),[error,setError]=useState(''),[preview,setPreview]=useState(false);
  const key=`roastduck_chinese_alignment:${sourceId}`;
  useEffect(()=>{try{const raw=localStorage.getItem(key);if(raw){const saved=JSON.parse(raw);if(typeof saved.text==='string')setText(saved.text);if(typeof saved.clientId==='string')request.current=saved.clientId;}}catch{setError('浏览器暂时无法恢复中文草稿，请保留文字。');}},[key]);
  function change(text:string){setText(text);setPreview(false);try{localStorage.setItem(key,JSON.stringify({text,clientId:request.current}));setError('');}catch{setError('中文尚未保存到本机，请保留文字后再继续。');}}
  const hasChinese=analysis.evidence?analysis.evidence.diagnosis.units.some(u=>u.status!=='non_answer'&&[...u.chinese,...u.english,...u.raw??[]].some(r=>/[\u4e00-\u9fff]/.test(r.text))):Boolean(originalChinese.trim());
  async function post(url:string,method:string,body:unknown){const r=await fetch(url,{method,headers:{'content-type':'application/json'},body:JSON.stringify(body)}),data=await r.json();if(!r.ok)throw new Error(data.error??'暂时无法保存');return data;}
  async function submit(){if(busy)return;setBusy(true);setError('');try{
    let {draft}=await post('/api/answer-drafts','POST',{questionId,sourceAttemptId:sourceId,kind:'edit',clientId:request.current});
    if(!draft.submitted_attempt_id){({draft}=await post(`/api/answer-drafts/${draft.id}`,'PATCH',{version:draft.version,inputText:`${originalEnglish}\n\n以下是我补充或更正的中文原意，请以此理解我的想法：\n${text.trim()}`}));const result=await post(`/api/answer-drafts/${draft.id}`,'POST',{action:'submit',version:draft.version});router.push(`/questions/${questionId}/attempts/${result.attemptId}`);}
    else router.push(`/questions/${questionId}/attempts/${draft.submitted_attempt_id}`);
  }catch(e){setError(e instanceof Error?e.message:'暂时无法提交，中文仍保留');setBusy(false);}}
  return <details className="page-panel"><summary>{hasChinese?'补充或更正中文原意':'补充中文原意，让表达更贴近你的想法'}</summary><p>已有材料仍然可以学习。补充后会保留原回答，并生成一个新版本。</p>
    <label>我真正想表达的意思<textarea value={text} onChange={e=>change(e.target.value)} rows={5}/></label>
    {preview?<><h3>确认本次对齐</h3><p>原来的理解：{analysis.answerIntentZh||'此前仅根据英文理解。'}</p><p>新的中文原意：{text}</p><p>确认后使用你的 API 分析新版本，旧版本与学习记录保留。</p><button className="primary-button" disabled={busy} onClick={()=>void submit()}>{busy?'正在保存…':'确认并分析新版本'}</button></>:<button className="secondary-button" disabled={!text.trim()} onClick={()=>setPreview(true)}>查看对齐变化</button>}
    {error&&<p role="alert">{error}</p>}
  </details>;
}
