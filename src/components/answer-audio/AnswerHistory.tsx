'use client';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { audioDuration, comparisonDefaults, stageLabels, type FullAnswer, type AudioAsset } from '@/lib/answer-audio/contracts';
import styles from './AnswerAudio.module.css';
import {PendingAudioDrafts} from './PendingAudioDrafts';

const date = (value: string) => new Date(value).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
export function AnswerHistory({ questionId }: { questionId: string }) {
  const [attempts, setAttempts] = useState<FullAnswer[]>([]), [question, setQuestion] = useState({ textEn: '', textZh: '' });
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [selection, setSelection] = useState<[string, string]>(['', '']);
  const [active, setActive] = useState(''), [pending, setPending] = useState(''), [confirm, setConfirm] = useState(''), [confirmation, setConfirmation] = useState(''),[sequencePlaying,setSequencePlaying]=useState(false);
  const audio = useRef<HTMLAudioElement | null>(null);
  const playQueue=useRef<string[]>([]),loadSequence=useRef(0),lifecycle=useRef({active:false,questionId});
  const load = useCallback(async () => {
    if(!lifecycle.current.active||lifecycle.current.questionId!==questionId)return;
    const own=++loadSequence.current;
    const response = await fetch(`/api/full-answer-attempts?questionId=${encodeURIComponent(questionId)}`, { cache: 'no-store' }), data = await response.json();
    if (!response.ok) throw new Error(data.error ?? '历史暂时无法读取');
    if(own!==loadSequence.current||!lifecycle.current.active||lifecycle.current.questionId!==questionId)return;
    const next = data.attempts as FullAnswer[]; setAttempts(next); setQuestion(data.question);
    setSelection(prior => { const available = new Set(next.flatMap(a => a.audio.filter(s => !s.removedAt && !s.purgedAt && !s.unavailable).map(s => s.id))); const fallback = comparisonDefaults(next); return [available.has(prior[0]) ? prior[0] : fallback[0], available.has(prior[1]) ? prior[1] : fallback[1]]; });
  }, [questionId]);
  const closeHistory=useCallback(()=>{lifecycle.current.active=false;loadSequence.current++;audio.current?.pause();playQueue.current=[];},[]);
  useEffect(() => { let live = true;lifecycle.current={active:true,questionId};setLoading(true);setError('');setActive('');setSelection(['','']);playQueue.current=[];setSequencePlaying(false);void load().catch(e => { if (live) setError(e.message); }).finally(() => { if (live) setLoading(false); }); const quiet = (event: Event) => { if ((event as CustomEvent).detail?.source !== audio.current){audio.current?.pause();playQueue.current=[];setSequencePlaying(false);} }; window.addEventListener('roastduck:stop-all-audio', quiet); return () => { live = false;closeHistory();window.removeEventListener('roastduck:stop-all-audio', quiet); }; }, [load,questionId,closeHistory]);
  const available = attempts.flatMap(a => a.audio.filter(s => !s.removedAt && !s.purgedAt && !s.unavailable).map(s => ({ answer: a, asset: s })));
  const left = available.find(s => s.asset.id === selection[0]), right = available.find(s => s.asset.id === selection[1]);
  const different = left && right && (left.answer.stage !== right.answer.stage || left.answer.promptCondition !== right.answer.promptCondition || left.answer.refs.taskId !== right.answer.refs.taskId);
  const differentAnswers=!!left&&!!right&&left.answer.id!==right.answer.id;
  async function change(asset: AudioAsset, operation: 'note' | 'remove' | 'restore' | 'purge', note?: string) {
    setPending(asset.id); setError('');
    try { const response = await fetch(`/api/answer-audio/${asset.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operation, note, ...(operation === 'purge' ? { confirmation } : {}) }) }), result = await response.json(); if (!response.ok) throw new Error(result.error ?? '保存失败'); if (operation === 'remove' || operation === 'purge') { audio.current?.pause();playQueue.current=[];setSequencePlaying(false);if (active === asset.id) setActive(''); } setConfirm(''); setConfirmation(''); await load(); } catch (e) { setError(e instanceof Error ? e.message : '操作失败，请重试'); } finally { setPending(''); }
  }
  function playFailed(){playQueue.current=[];setSequencePlaying(false);setError('浏览器尚未开始播放，请点击播放器的播放键');}
  function choose(id: string,keepSequence=false) { if (!id) return;if(!keepSequence){playQueue.current=[];setSequencePlaying(false);}audio.current?.pause(); if (id === active && audio.current) { audio.current.currentTime = 0; void audio.current.play().catch(playFailed); } else setActive(id); }
  function playSequence(){if(!differentAnswers||!left||!right)return;setError('');playQueue.current=[right.asset.id];setSequencePlaying(true);choose(left.asset.id,true);}
  function stopSequence(){playQueue.current=[];setSequencePlaying(false);audio.current?.pause();}
  function finished(){const next=playQueue.current.shift();if(next)choose(next,true);else setSequencePlaying(false);}
  useEffect(() => { if (!active || !audio.current) return; audio.current.playbackRate = 1; void audio.current.play().catch(()=>{playQueue.current=[];setSequencePlaying(false);setError('浏览器尚未开始播放，请点击播放器的播放键');}); }, [active]);
  return <div className={styles.history}>
    <Link href={`/questions/${encodeURIComponent(questionId)}`}>返回题目</Link>
    <h1>听听每一次的自己</h1><p className={styles.question}>{question.textZh || question.textEn}{question.textZh && question.textEn ? <><br />{question.textEn}</> : null}</p>
    {loading ? <p role="status">正在读取回答历史…</p> : null}{error ? <p className={styles.error} role="alert">{error}</p> : null}
    {!loading && !attempts.length ? <p className={styles.muted}>这道题还没有保存完整回答。录音、上传或提交文字后，会在这里留下记录。</p> : null}
    <PendingAudioDrafts questionId={questionId} onSaved={load}/>
    {available.length ? <section className={styles.comparison} aria-label="原声对比">
      <h2>选两次，交替回听</h2>
      <div className={styles.choices}>{(['A', 'B'] as const).map((name, index) => <label key={name}>回答 {name}<select value={selection[index]} onChange={e => {stopSequence();setSelection(current => index === 0 ? [e.target.value, current[1]] : [current[0], e.target.value]);}}><option value="">选择另一次完整回答</option>{available.map(({ answer, asset }) => <option key={asset.id} value={asset.id}>{asset.recordedAt?`录于 ${date(asset.recordedAt)}`:`保存于 ${date(asset.createdAt)}（录制时间未知）`} · {stageLabels[answer.stage]} · {asset.source === 'recording' ? '录音' : '上传'}</option>)}</select><button className="secondary-button" type="button" disabled={!selection[index]} onClick={() => choose(selection[index])}>播放 {name}</button></label>)}</div>
      <div className={styles.actions}><button className="primary-button" type="button" disabled={!differentAnswers} onClick={playSequence}>按 A → B 顺序回听</button>{sequencePlaying?<button className="secondary-button" type="button" onClick={stopSequence}>停止顺序回听</button>:null}</div>
      {!differentAnswers?<p className={styles.muted}>请选择两次不同的完整回答；同一次回答的附件不算两次练习。</p>:null}
      <p className={styles.meta}>A：{left?.answer.taskPrompt ? `${left.answer.taskPrompt} · ` : ''}{left?.answer.promptCondition}<br />B：{right?.answer.taskPrompt ? `${right.answer.taskPrompt} · ` : ''}{right?.answer.promptCondition}</p>
      {different ? <p className={styles.muted}>这两次的提示条件不同，请结合当时是否看过中文、英文或反馈来比较。</p> : <p className={styles.muted}>优先选择相同提示条件下的最早与最近一次。时长不代表进步。</p>}
      <div className={styles.playback}><span>原速 1×</span><audio key={active} ref={audio} src={active ? `/api/answer-audio/${active}` : undefined} controls preload="metadata" aria-label="完整回答原声播放器" onEnded={finished} onError={() => {playQueue.current=[];setSequencePlaying(false);if (active) setError('原声未能播放，文件可能缺失、校验失败或浏览器不支持。可下载原文件或从含媒体的备份恢复。'); }} onPlay={e => { window.dispatchEvent(new CustomEvent('roastduck:stop-all-audio', { detail: { source: e.currentTarget } })); e.currentTarget.playbackRate = 1; }} onRateChange={e => { if (e.currentTarget.playbackRate !== 1) e.currentTarget.playbackRate = 1; }} /></div>
    </section> : null}
    {attempts.map((answer, index) => <article className={styles.take} key={answer.id}>
      <h2>{answer.countsAsAttempt===false?'历史修订 · 不另计完整回答':answer.refs.taskId ? `相关新题 · 第 ${attempts.slice(0, index + 1).filter(a => a.countsAsAttempt!==false&&a.refs.taskId === answer.refs.taskId).length} 次回答` : `本题第 ${attempts.slice(0, index + 1).filter(a => a.countsAsAttempt!==false&&!a.refs.taskId).length} 次完整回答`} · {stageLabels[answer.stage]}</h2>{answer.taskPrompt ? <p>{answer.taskPrompt}</p> : null}<p className={styles.meta}>保存于 {date(answer.createdAt)} · {answer.promptCondition}</p>
      {answer.legacy?<p className={styles.small}>沿用原回答记录与日期，没有补造录音或新提交。</p>:null}{answer.sourceHref?<Link href={answer.sourceHref}>查看原记录</Link>:null}
      {answer.text ? <details><summary>{answer.legacy?'查看原回答文字':'查看附加文字'}</summary><pre>{answer.text}</pre><p className={styles.small}>{answer.legacy?'这是原来保存的回答文字，没有音频转写。':'这是保存时附加的文字，不是音频转写。'}</p></details> : <p className={styles.small}>仅保存了原声，没有附加文字。</p>}
      {!answer.audio.length ? <p className={styles.muted}>这次回答没有保存原声。</p> : null}
      {answer.audio.map(asset => <div className={styles.asset} key={asset.id}>
        <p className={styles.meta}>{asset.source === 'recording' ? '浏览器录音' : `上传原文件：${asset.originalName}`} · {audioDuration(asset.durationSeconds)} · {(asset.byteLength / 1024 / 1024).toFixed(2)} MiB{asset.purgedAt ? ' · 原声已永久删除' : asset.removedAt ? ' · 已移除，可恢复' : ''}</p>
        <p className={styles.meta}>{asset.recordedAt?`录制于 ${date(asset.recordedAt)} · ${asset.recordedAtSource==='recording'?'录音开始时间':'用户填写时间'}`:'录制时间未知'} · 保存于 {date(asset.createdAt)}</p>
        {asset.unavailable ? <p className={styles.error}>原声文件缺失或大小不符，目前无法回听。回答记录仍保留，可从含媒体的备份恢复原文件。</p> : null}
        <div className={styles.actions}>{!asset.removedAt && !asset.purgedAt ? <>{!asset.unavailable ? <><button type="button" className="secondary-button" onClick={() => choose(asset.id)}>回听原声</button><a href={`/api/answer-audio/${asset.id}?download=1`} download>下载原文件</a></> : null}<button type="button" className={styles.textButton} disabled={pending === asset.id} onClick={() => void change(asset, 'remove')}>移除原声</button></> : !asset.purgedAt ? <button type="button" className="secondary-button" disabled={pending === asset.id} onClick={() => void change(asset, 'restore')}>恢复原声</button> : null}
          {!asset.purgedAt ? <button type="button" className={styles.textButton} onClick={() => { setConfirm(asset.id); setConfirmation(''); }}>永久删除…</button> : null}</div>
        <form onSubmit={event => { event.preventDefault(); const note = new FormData(event.currentTarget).get('note'); void change(asset, 'note', String(note ?? '')); }}><label>给这次原声留个备注<textarea key={`${asset.id}:${asset.note}`} name="note" defaultValue={asset.note} maxLength={2000} placeholder="例如：今天想句子的停顿少了，下一次留意结尾。" /></label><button type="submit" className={styles.textButton} disabled={pending === asset.id}>保存备注</button></form>
        {confirm === asset.id ? <div className={styles.confirm}><p>永久删除会清理这份原声文件，回答、文字和其他引用仍保留。此操作不能恢复，已导出的旧备份不会自动擦除。</p><label>输入“永久删除原声”确认<input value={confirmation} onChange={e => setConfirmation(e.target.value)} autoComplete="off" /></label><div className={styles.actions}><button type="button" className="secondary-button" onClick={() => setConfirm('')}>取消</button><button type="button" className="primary-button" disabled={confirmation !== '永久删除原声' || pending === asset.id} onClick={() => void change(asset, 'purge')}>确认永久删除</button></div></div> : null}
      </div>)}
    </article>)}
  </div>;
}
