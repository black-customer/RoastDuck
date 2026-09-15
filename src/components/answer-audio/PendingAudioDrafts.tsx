'use client';
import {useCallback,useEffect,useState} from 'react';
import {listQuestionDrafts,readDraftBlob,removeDraft,uploadAudioDraft,type AudioDraft} from '@/lib/answer-audio/client-drafts';
import {linkFullAnswer,pendingFullAnswerLinks} from '@/lib/answer-audio/source-link-client';
import {stageLabels,type FullAnswerInput} from '@/lib/answer-audio/contracts';
import styles from './AnswerAudio.module.css';

/** Explicit recovery lives at question scope, including drafts from a previous practice identity. */
export function PendingAudioDrafts({questionId,onSaved}:{questionId:string;onSaved:()=>Promise<void>}){
  const [drafts,setDrafts]=useState<AudioDraft[]>([]),[links,setLinks]=useState<FullAnswerInput[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState('');
  const refresh=useCallback(async()=>{setDrafts(await listQuestionDrafts(questionId));setLinks(pendingFullAnswerLinks(questionId));},[questionId]);
  useEffect(()=>{void refresh().catch(()=>setError('本机草稿暂时无法读取，请检查浏览器存储。'));},[refresh]);
  async function save(draft:AudioDraft){const input=draft.answerInput;if(!input)return;setBusy(draft.id);setError('');try{await uploadAudioDraft(draft,input,()=>undefined);await removeDraft(draft.id);await refresh();await onSaved();}catch{setError('原声尚未保存完整，分片仍保留。可以下载原文件，或稍后继续保存。');}finally{setBusy('');}}
  async function download(draft:AudioDraft){try{const blob=await readDraftBlob(draft),url=URL.createObjectURL(blob),anchor=document.createElement('a');anchor.href=url;anchor.download=draft.source==='upload'?draft.originalName:`interrupted-answer-${draft.id}`;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch{setError('草稿分片暂时无法读取，请保留浏览器数据并稍后重试。');}}
  async function link(){setBusy('links');setError('');try{for(const input of links)await linkFullAnswer(input);await refresh();await onSaved();}catch{setError('部分回答历史尚未关联，原文字和原声保留，可以继续重试。');await refresh();}finally{setBusy('');}}
  if(!drafts.length&&!links.length&&!error)return null;
  return <section className={styles.take} aria-label="本机未完成保存"><h2>继续上次的保存</h2><p className={styles.muted}>这些本机草稿不计入完整回答。完整原声可续传；中断片段仅供下载保留。</p>
    {links.length?<div className={styles.actions}><span>有 {links.length} 份已保存文字待关联到历史</span><button type="button" className="secondary-button" disabled={!!busy} onClick={()=>void link()}>恢复回答历史关联</button></div>:null}
    {drafts.map(draft=><div className={styles.asset} key={draft.id}><p className={styles.meta}>{new Date(draft.createdAt).toLocaleString('zh-CN')} · {draft.answerInput?stageLabels[draft.answerInput.stage]:'原提示条件待恢复'} · {draft.source==='upload'?draft.originalName:'录音'} · {draft.state==='ready'?'完整暂存，尚未确认保存':'未完成片段'}</p><div className={styles.actions}>{draft.state==='ready'&&draft.answerInput?<button type="button" className="secondary-button" disabled={!!busy} onClick={()=>void save(draft)}>继续保存这份原声</button>:null}<button type="button" className={styles.textButton} disabled={!draft.byteLength} onClick={()=>void download(draft)}>下载本机片段</button><button type="button" className={styles.textButton} disabled={!!busy} onClick={()=>void removeDraft(draft.id).then(refresh).catch(()=>setError('草稿未能移除，请稍后重试。'))}>移除本机草稿</button></div></div>)}
    {error?<p className={styles.error} role="alert">{error}</p>:null}
  </section>;
}
