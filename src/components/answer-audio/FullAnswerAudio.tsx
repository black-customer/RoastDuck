'use client';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AUDIO_ACCEPT, RECORDING_MAX_MS, stageLabels, type AnswerStage, type FullAnswerInput } from '@/lib/answer-audio/contracts';
import { appendDraftChunk, listDrafts, persistFile, readDraft, readDraftBlob, removeDraft, saveDraft, uploadAudioDraft, type AudioDraft } from '@/lib/answer-audio/client-drafts';
import { pickMimeType } from '@/lib/media/recorder-machine';
import {beginRecording} from '@/lib/speech/recording-coordinator';
import styles from './AnswerAudio.module.css';

export interface FullAnswerAudioProps { questionId: string; sourceKey: string; stage: AnswerStage; materialId?: string | null; taskId?: string; promptCondition?: string; text?: string; onSaved?: (fullAnswerId: string) => void }
export function FullAnswerAudio({ questionId, sourceKey, stage, materialId, taskId, promptCondition, onSaved }: FullAnswerAudioProps) {
  const [drafts, setDrafts] = useState<AudioDraft[]>([]), [selectedId, setSelectedId] = useState('');
  const [phase, setPhase] = useState<'idle' | 'requesting' | 'recording' | 'stopping' | 'saving'>('idle');
  const [elapsed,setElapsed]=useState(0);
  const recordingRelease=useRef<(()=>void)|null>(null);
  const [message, setMessage] = useState(''), [error, setError] = useState(''), [preview, setPreview] = useState(''), [savedId, setSavedId] = useState('');
  const recorder = useRef<MediaRecorder | null>(null), stream = useRef<MediaStream | null>(null), mounted = useRef(false), generation = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null), permissionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const outcomes = useRef(new WeakMap<MediaRecorder, { complete: boolean; failed: boolean }>()), audio = useRef<HTMLAudioElement | null>(null);
  const selected = drafts.find(d => d.id === selectedId), busy = phase !== 'idle';
  const answerInput:FullAnswerInput={questionId,sourceKey,stage,promptCondition:promptCondition??stageLabels[stage],materialId,text:'',refs:{...(sourceKey.startsWith('draft:')?{draftId:sourceKey.slice(6)}:{}),...(taskId?{taskId}:{})}};
  const refresh = useCallback(async () => { const all = await listDrafts(sourceKey, questionId); if (mounted.current) { setDrafts(all); setSelectedId(current => all.some(d => d.id === current) ? current : all.at(-1)?.id ?? ''); } }, [sourceKey, questionId]);
  const release = useCallback(() => { stream.current?.getTracks().forEach(t => t.stop()); stream.current = null; recordingRelease.current?.();recordingRelease.current=null;if (timer.current) clearTimeout(timer.current); timer.current = null; }, []);
  const invalidate = useCallback(() => { generation.current++; }, []);
  const stop = useCallback((kind: 'complete' | 'interrupted') => { const capture = recorder.current; if (capture) { const outcome = outcomes.current.get(capture); if (outcome) outcome.complete = kind === 'complete'; } if (capture?.state === 'recording') { if (mounted.current) setPhase('stopping'); capture.stop(); } release(); }, [release]);
  useEffect(() => {
    mounted.current = true; setSavedId(''); setPhase('idle'); setError(''); setMessage('');
    void refresh().catch(() => { if (mounted.current) setError('浏览器暂存不可用。请检查本机存储空间或使用常规浏览窗口后重试。'); });
    const leave = () => { invalidate(); stop('interrupted'); };
    const beforeUnload = (event: BeforeUnloadEvent) => { if (recorder.current?.state === 'recording') { event.preventDefault(); } };
    const quiet = (event: Event) => { if ((event as CustomEvent).detail?.source !== audio.current) audio.current?.pause(); };
    window.addEventListener('pagehide', leave); window.addEventListener('beforeunload', beforeUnload); window.addEventListener('roastduck:stop-all-audio', quiet);
    return () => { mounted.current = false; invalidate(); stop('interrupted'); if (permissionTimer.current) clearTimeout(permissionTimer.current); window.removeEventListener('pagehide', leave); window.removeEventListener('beforeunload', beforeUnload); window.removeEventListener('roastduck:stop-all-audio', quiet); };
  }, [refresh, stop, invalidate]);
  useEffect(() => { let url = '', alive = true; setPreview(''); if (selected && selected.byteLength > 0 && phase === 'idle') void readDraftBlob(selected).then(blob => { if (alive) { url = URL.createObjectURL(blob); setPreview(url); } }).catch(() => { if (alive) setError('草稿分片无法完整读取，请保留现有文件后重试'); }); return () => { alive = false; if (url) URL.revokeObjectURL(url); }; }, [selected, phase]);
  useEffect(()=>{if(phase!=='recording')return;const started=Date.now();setElapsed(0);const tick=setInterval(()=>setElapsed(Math.floor((Date.now()-started)/1000)),500);return()=>clearInterval(tick)},[phase]);
  useEffect(()=>{let live=true;void fetch(`/api/full-answer-attempts?questionId=${encodeURIComponent(questionId)}`).then(r=>r.ok?r.json():null).then(body=>{const existing=body?.attempts?.find((a:{sourceKey:string;id:string;audio:unknown[]})=>a.sourceKey===sourceKey&&a.audio.length);if(live&&existing)setSavedId(existing.id)}).catch(()=>{});return()=>{live=false}},[sourceKey,questionId]);

  async function start() {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') { setError('这个浏览器不能录音，仍可上传已有音频'); return; }
    const own = ++generation.current; setPhase('requesting'); setError(''); setMessage(''); let expired = false; let permissionTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const granted = await Promise.race([
        navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } }).then(s => { if (expired || !mounted.current || generation.current !== own) { s.getTracks().forEach(t => t.stop()); throw new Error('麦克风请求已结束'); } return s; }),
        new Promise<never>((_, reject) => { permissionTimeout = setTimeout(() => { expired = true; reject(new Error('尚未获得麦克风权限，可重试或上传已有音频')); }, 15000); permissionTimer.current = permissionTimeout; }),
      ]);
      if (permissionTimeout) clearTimeout(permissionTimeout); stream.current = granted;
      recordingRelease.current=beginRecording();window.speechSynthesis?.cancel();
      const mimeType = pickMimeType(MediaRecorder.isTypeSupported.bind(MediaRecorder));
      const capture = new MediaRecorder(granted, mimeType ? { mimeType } : undefined); recorder.current = capture;
      const draft: AudioDraft = { id: crypto.randomUUID(), sourceKey, questionId, mimeType: capture.mimeType || 'audio/webm', originalName: '我的完整回答', source: 'recording', state: 'recording', byteLength: 0, chunkCount: 0, createdAt: new Date().toISOString(), answerInput };
      await saveDraft(draft); if (!mounted.current || own !== generation.current) { release(); return; }
      setSelectedId(draft.id); const outcome = { complete: false, failed: false }; outcomes.current.set(capture, outcome); let captureWrites: Promise<unknown> = Promise.resolve();
      capture.ondataavailable = event => { if (!event.data.size) return; captureWrites = captureWrites.then(() => appendDraftChunk(draft.id, event.data)).catch(() => { outcome.failed = true; outcome.complete = false; if (capture.state === 'recording') capture.stop(); granted.getTracks().forEach(t => t.stop()); if (mounted.current && generation.current === own) { release(); setError('本机暂存不足或写入失败。已存片段保留为未完成草稿，可下载后重新录音。'); } }); };
      capture.onstop = () => { granted.getTracks().forEach(t => t.stop()); if (generation.current === own) release(); const completed = outcome.complete; captureWrites = captureWrites.then(async () => { const latest = await readDraft(draft.id); if (latest) await saveDraft({ ...latest, state: completed && !outcome.failed && latest.byteLength > 0 ? 'ready' : 'interrupted' }); if (mounted.current && generation.current === own) { recorder.current = null; setPhase('idle'); setMessage(completed && !outcome.failed ? '原声已暂存。回听后可保存为这次完整回答。' : '录音已中断，片段仍保留在本机草稿中。'); await refresh(); } }).catch(() => { if (mounted.current && generation.current === own) { setPhase('idle'); setError('草稿尚未确认保存，请保留页面并检查存储空间'); } }); };
      capture.onerror = () => stop('interrupted'); granted.getAudioTracks().forEach(track => track.addEventListener('ended', () => { if (capture.state === 'recording') stop('interrupted'); }, { once: true }));
      capture.start(1000); setPhase('recording');
      timer.current = setTimeout(() => { stop('complete'); if (mounted.current) setMessage('已到 10 分钟安全上限，录音停止并保留。'); }, RECORDING_MAX_MS);
    } catch (cause) { expired = true; if (permissionTimeout) clearTimeout(permissionTimeout); if (own === generation.current) release(); if (mounted.current && own === generation.current) { setPhase('idle'); setError(cause instanceof DOMException && cause.name === 'NotAllowedError' ? '未获得麦克风权限。可在浏览器设置允许录音，或上传已有音频。' : cause instanceof Error ? cause.message : '无法开始录音，可重试或上传音频'); } }
  }
  async function selectFile(file: File) { const own = generation.current; setPhase('saving'); setError(''); try { const draft = await persistFile(file, sourceKey, questionId,answerInput); if (mounted.current && generation.current === own) { setSelectedId(draft.id); await refresh(); setMessage('原文件已暂存，可以回听并保存'); } } catch (cause) { if (mounted.current && generation.current === own) { setError(cause instanceof Error ? cause.message : '暂存失败，请保留原文件后重试'); await refresh().catch(() => undefined); } } finally { if (mounted.current && generation.current === own) setPhase('idle'); } }
  async function save() {
    if (!selected) return; const own = generation.current; setPhase('saving'); setError('');
    try { const result = await uploadAudioDraft(selected, selected.answerInput??answerInput, (done, total) => { if (mounted.current && generation.current === own) setMessage(`正在保存原声 ${done}/${total}`); });
      await removeDraft(selected.id); if (mounted.current && generation.current === own) { setSavedId(result.fullAnswerId); setMessage(result.asset.removedAt || result.asset.purgedAt ? '这份原声以前已移除；原有移除状态保留，请到历史查看。' : '完整回答已保存，原声没有转写或交给 AI。'); await refresh(); onSaved?.(result.fullAnswerId); }
    } catch (cause) { if (mounted.current && generation.current === own) { setError(cause instanceof Error ? cause.message : '保存未完成，原声仍在本机，可重试'); await refresh().catch(() => undefined); } } finally { if (mounted.current && generation.current === own) setPhase('idle'); }
  }
  return <section className={styles.recorder} aria-label="完整回答原声">
    <div className={styles.intro}><h2>留下这次的声音</h2><span>可选</span></div>
    <p className={styles.muted}>录音或上传，保留原声。仅保存到本机，不转写、不做声音评分。</p>
    <div className={styles.actions}>
      {phase === 'recording' ? <><button type="button" className="primary-button" onClick={() => stop('complete')}>停止录音</button><span aria-label="已录时长">{Math.floor(elapsed/60)}:{String(elapsed%60).padStart(2,'0')}</span></> : <button type="button" className="secondary-button" disabled={busy||!!savedId} onClick={() => void start()}>{phase === 'requesting' ? '等待麦克风权限…' : phase === 'stopping' ? '正在保存分片…' : '开始录音'}</button>}
      {phase==='requesting'?<button type="button" className="secondary-button" onClick={()=>{invalidate();if(permissionTimer.current)clearTimeout(permissionTimer.current);release();setPhase('idle');setMessage('已取消麦克风请求；稍后的授权不会开始录音。')}}>取消请求</button>:null}
      <label className={styles.upload}>上传音频<input type="file" accept={AUDIO_ACCEPT} disabled={busy||!!savedId} aria-label="上传完整回答音频" onChange={event => { const file = event.target.files?.[0]; if (file) void selectFile(file); event.target.value = ''; }} /></label>
    </div>
    <p className={styles.small}>{phase === 'recording' ? '正在录音，说完后点击停止。离开页面会保留为未完成片段。' : '录音最多 10 分钟；单份音频最大 50 MiB。支持 MP3 / M4A / WAV / WebM / Ogg。'}</p>
    {drafts.length > 0 && phase === 'idle' ? <div className={styles.draft}>
      <label>本机待保存原声<select value={selectedId} onChange={e => setSelectedId(e.target.value)}>{drafts.map((d, i) => <option key={d.id} value={d.id}>{i + 1}. {d.source === 'recording' ? '录音' : d.originalName} · {d.state === 'ready' ? '已完整暂存' : '未完成片段'}</option>)}</select></label>
      {selected?.state !== 'ready' ? <p className={styles.muted}>这份录音或上传曾被中断，仅供下载保留，不计入完整回答。重新录音或重新选择原文件后再保存。</p> : null}
      {preview ? <><audio ref={audio} src={preview} controls preload="metadata" aria-label="回听待保存原声" onPlay={e => { window.dispatchEvent(new CustomEvent('roastduck:stop-all-audio', { detail: { source: e.currentTarget } })); e.currentTarget.playbackRate = 1; }} onRateChange={e => { if (e.currentTarget.playbackRate !== 1) e.currentTarget.playbackRate = 1; }} /><a href={preview} download={selected?.source === 'upload' ? selected.originalName : `answer-draft-${selected?.id}.webm`}>下载本机草稿</a></> : null}
      {selected?.source==='upload'&&!selected.uploadInput?<label>录制时间（可选；不知道可留空）<input type="datetime-local" onChange={event=>{const recordedAt=event.target.value?new Date(event.target.value).toISOString():null;void saveDraft({...selected,recordedAt}).then(refresh).catch(()=>setError('录制时间尚未保存'));}}/></label>:null}
      <div className={styles.actions}><button type="button" className="primary-button" disabled={selected?.state !== 'ready'||!!savedId} onClick={() => void save()}>保存这次完整回答</button><button type="button" className={styles.textButton} onClick={() => { if (selected) void removeDraft(selected.id).then(refresh).catch(() => setError('草稿未能移除，请重试')); }}>移除这份草稿</button></div>
    </div> : null}
    {savedId?<p className={styles.status}>本次原声已保存。可以补充本次文字；重新录制请先开始新一次完整回答，旧原声不会覆盖。</p>:null}
    {message ? <p className={styles.status} role="status">{message}</p> : null}{error ? <p className={styles.error} role="alert">{error}</p> : null}
    <Link className={styles.historyLink} href={`/answer-history/${encodeURIComponent(questionId)}`}>{savedId ? '查看已保存原声与历史对比' : '查看这道题的回答历史'}</Link>
  </section>;
}
