'use client';
import Link from 'next/link';
import {useCallback, useEffect, useId, useRef, useState} from 'react';
import type {SentenceCard, SentenceOverview, SentencePreference, SentenceScope, SentenceSourceOption} from '@/lib/sentence-study/contracts';
import type {SentenceFeedback} from '@/lib/sentence-study/preferences';
import {StartSentenceButton, sentenceScopeQuery} from '@/components/sentence-study/StartSentenceButton';
import styles from './SentenceLibrary.module.css';

// Extend the existing blue-gray reading surface: the sentence is the visual anchor,
// its source stays beside it, and personal controls open inline without a modal.
type Filter = 'all' | 'favorite' | 'notes' | 'paused' | 'feedback';
type Catalogue = {scope: SentenceScope; cards: SentenceCard[]; feedback: SentenceFeedback[]};
type Command = {endpoint: 'preferences' | 'feedback'; body: Record<string, unknown>};
const emptyPreference: SentencePreference = {hidden: false, favorite: false, selfKnown: false, note: '', version: 0};
const filterLabels: Record<Filter, string> = {all: '全部句子', favorite: '已收藏', notes: '有备注', paused: '暂不提醒', feedback: '有材料反馈'};
const feedbackLabels = {incorrect: '内容有误', unclear: '讲解不清楚', other: '其他建议'};

export function sourceInSentenceScope(source: SentenceSourceOption, scope: SentenceScope) {
  if (scope.type === 'all') return true;
  if (scope.type === 'question') return source.type === 'question' && source.id === scope.id;
  if (scope.type === 'conversation') return source.type === 'conversation' && source.id === scope.id;
  if (scope.type === 'material') return source.materialId === scope.id;
  if (scope.type !== 'collection') return false;
  return source.type === (scope.id === 'ielts' ? 'question' : 'conversation') &&
    (!scope.questionId || source.id === scope.questionId) && (!scope.topicId || source.topicId === scope.topicId) &&
    (!scope.seasonId || (scope.seasonId === 'unmarked' ? !source.seasons.length : source.seasons.some(season => season.id === scope.seasonId)));
}
export function filterSentenceLibrary(cards: SentenceCard[], query: string, filter: Filter, feedback: SentenceFeedback[]) {
  const needle = query.trim().toLocaleLowerCase();
  const reported = new Set(feedback.filter(item => item.status === 'open').map(item => item.sentenceId));
  return cards.filter(card => {
    const preference = card.preference ?? emptyPreference;
    const matches = !needle || [card.chinese, card.english, card.contextZh, card.source.title, preference.note, ...card.usages.map(usage => `${usage.text} ${usage.meaningZh}`)].join(' ').toLocaleLowerCase().includes(needle);
    return matches && (filter === 'all' || filter === 'favorite' && preference.favorite || filter === 'notes' && !!preference.note.trim() || filter === 'paused' && (preference.hidden || preference.selfKnown) || filter === 'feedback' && reported.has(card.id));
  });
}
export function sentenceCardScope(card: SentenceCard): SentenceScope {return {type: 'material', id: card.materialId};}
function Star({filled}: {filled: boolean}) {return <svg viewBox="0 0 24 24" aria-hidden="true" fill={filled ? 'currentColor' : 'none'}><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3l-5.6 2.9 1.1-6.2L3 9.6l6.2-.9L12 3Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/></svg>;}

export function SentenceLibrary({overview, initialScope = {type: 'all'}, initialQuery = '', search = false}: {overview: SentenceOverview; initialScope?: SentenceScope; initialQuery?: string; search?: boolean}) {
  const [scope, setScope] = useState<SentenceScope>(initialScope), [query, setQuery] = useState(initialQuery), [filter, setFilter] = useState<Filter>('all');
  const [view, setView] = useState<'sentences' | 'sources'>('sentences'), [data, setData] = useState<Catalogue | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const generation = useRef(0), request = useRef<AbortController | null>(null), inputId = useId();
  const scopeQuery = sentenceScopeQuery(scope);
  const reload = useCallback(async () => {
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    const version = ++generation.current; setLoading(true); setError('');
    try {
      const response = await fetch('/api/sentence-study/preferences?' + scopeQuery, {signal: controller.signal, cache: 'no-store'}), body = await response.json();
      if (!response.ok) throw new Error(body.error ?? '当前句子材料暂时无法读取。');
      if (!Array.isArray(body.cards) || !Array.isArray(body.feedback)) throw new Error('材料读取不完整，请重试。');
      if (version !== generation.current || controller.signal.aborted) return;
      setData(previous => ({...body, cards: body.cards.map((card: SentenceCard) => {
        const prior = previous?.cards.find(old => old.id === card.id && old.version === card.version);
        return prior && (prior.preference?.version ?? 0) > (card.preference?.version ?? 0) ? {...card, preference: prior.preference} : card;
      })}));
    } catch (reason) {if (!controller.signal.aborted && version === generation.current) setError(reason instanceof Error ? reason.message : '材料暂时无法读取，请重试。');}
    finally {if (!controller.signal.aborted && version === generation.current) setLoading(false);}
  }, [scopeQuery]);
  useEffect(() => {setData(null); void reload(); return () => request.current?.abort();}, [reload]);
  useEffect(() => {const refresh = () => {if (document.visibilityState === 'visible') void reload();}; window.addEventListener('focus', refresh); return () => window.removeEventListener('focus', refresh);}, [reload]);
  function changeScope(next: SentenceScope) {setScope(next); setFilter('all');}
  function preferenceChanged(id: string, preference: SentencePreference) {setData(current => current ? {...current, cards: current.cards.map(card => card.id === id ? {...card, preference} : card)} : current);}
  function feedbackChanged(feedback: SentenceFeedback) {
    setData(current => current ? {...current, feedback: [feedback, ...current.feedback.filter(item => item.id !== feedback.id)], cards: current.cards.map(card => card.id === feedback.sentenceId && card.version === feedback.unitVersion && feedback.kind === 'incorrect' && feedback.status === 'open' ? {...card, unavailable: '这版材料已标记内容有误，暂缓作为示范。'} : card)} : current);
    void reload();
  }
  const collection = scope.type === 'collection' ? scope.id : null;
  const allQuestions = overview.sources.filter(source => source.type === 'question');
  const topics = [...new Map(allQuestions.filter(source => source.topicId).map(source => [source.topicId!, source.topic || '未命名话题'] as const)).entries()].sort((a, b) => a[1].localeCompare(b[1], 'zh-CN'));
  const seasons = [...new Map(allQuestions.flatMap(source => source.seasons.map(season => [season.id, season.name] as const))).entries()];
  const scopedSources = overview.sources.filter(source => sourceInSentenceScope(source, scope));
  const cards = data?.cards ?? [], shown = filterSentenceLibrary(cards, query, filter, data?.feedback ?? []);
  const sourceIds = new Set(shown.map(card => card.source.questionId ? `question:${card.source.questionId}` : `conversation:${card.source.id}`));
  const shownSources = scopedSources.filter(source => sourceIds.has(`${source.type}:${source.id}`) || !query.trim() && filter === 'all' && !source.totalCount && !!source.materialStatus);
  let scopeTitle = scope.type === 'all' ? '全部学习材料' : scopedSources[0]?.title ?? '所选材料';
  if (scope.type === 'collection') scopeTitle = scope.questionId ? allQuestions.find(source => source.id === scope.questionId)?.title ?? '所选题目' : scope.topicId ? topics.find(([id]) => id === scope.topicId)?.[1] ?? '所选话题' : scope.seasonId ? seasons.find(([id]) => id === scope.seasonId)?.[1] ?? '未标注题季' : scope.id === 'ielts' ? '雅思回答' : '对话复盘';
  return <section className={styles.library} aria-label="当前句子材料">
    {search && <nav className={styles.collections} aria-label="搜索材料来源">{[['all', '全部材料'], ['ielts', '雅思回答'], ['free_talk', '对话复盘']].map(([id, label]) => <button key={id} type="button" aria-pressed={id === 'all' ? scope.type === 'all' : collection === id} onClick={() => changeScope(id === 'all' ? {type: 'all'} : {type: 'collection', id: id as 'ielts' | 'free_talk'})}>{label}</button>)}</nav>}
    <div className={styles.toolbar}><label className={styles.search} htmlFor={inputId}>查找句子、用法或备注<input id={inputId} type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="输入中文意思、英文或自己的备注" autoComplete="off"/></label><div className={styles.viewSwitch} aria-label="材料显示方式"><button type="button" aria-pressed={view === 'sentences'} onClick={() => setView('sentences')}>看句子</button><button type="button" aria-pressed={view === 'sources'} onClick={() => setView('sources')}>{collection === 'free_talk' ? '按对话' : '按整题'}</button></div></div>
    {scope.type === 'collection' && scope.id === 'ielts' && <div className={styles.scopeFilters}>
      <label>题目<select value={scope.questionId ?? ''} onChange={event => setScope({...scope, questionId: event.target.value || undefined})}><option value="">全部题目</option>{allQuestions.map(source => <option value={source.id} key={source.id}>{source.title}</option>)}</select></label>
      <label>话题<select value={scope.topicId ?? ''} onChange={event => setScope({...scope, topicId: event.target.value || undefined})}><option value="">全部话题</option>{topics.map(([id, name]) => <option value={id} key={id}>{name}</option>)}</select></label>
      <label>题季<select value={scope.seasonId ?? ''} onChange={event => setScope({...scope, seasonId: event.target.value || undefined})}><option value="">全部题季</option>{seasons.map(([id, name]) => <option value={id} key={id}>{name}</option>)}<option value="unmarked">未标注题季</option></select></label>
    </div>}
    <div className={styles.scopeActions}><p>学习范围：<strong>{scopeTitle}</strong></p>{cards.some(card => !card.unavailable) && <div><StartSentenceButton key={`learn:${scopeQuery}`} scope={scope} mode="learn" label="打开这个范围学习" className="secondary-button"/><StartSentenceButton key={`review:${scopeQuery}`} scope={scope} mode="review" label="复习这个范围" className="secondary-button"/></div>}</div>
    <div className={styles.filters} aria-label="个人材料筛选">{(Object.keys(filterLabels) as Filter[]).map(value => <button type="button" key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{filterLabels[value]}</button>)}</div>
    <div className={styles.resultLine}><p>{data ? `${shown.length} 句${query.trim() ? '匹配搜索' : ''}` : '正在读取当前材料…'}</p>{data && <button type="button" disabled={loading} onClick={() => void reload()}>{loading ? '正在更新…' : '刷新材料'}</button>}</div>
    {error && <div className={styles.error} role="alert"><p>{error}</p><button type="button" className="secondary-button" onClick={() => void reload()}>重新读取</button></div>}
    {loading && !data ? <div className={styles.loading} role="status">正在读取已审核的句子和个人备注…</div> : view === 'sentences' ? <div className={styles.sentences}>{shown.map(card => <SentenceLibraryRow key={`${card.id}:${card.version}`} card={card} feedback={(data?.feedback ?? []).filter(item => item.sentenceId === card.id)} onPreference={preference => preferenceChanged(card.id, preference)} onFeedback={feedbackChanged} onReload={() => void reload()}/>)}</div> : <div className={styles.sources}>{shownSources.map(source => <article key={`${source.type}:${source.id}`}><div><h2>{source.title}</h2>{source.textEn && source.textEn !== source.title && <p lang="en">{source.textEn}</p>}<p className={styles.hint}>{source.totalCount ? `${source.totalCount} 句当前材料${source.topic ? ` · ${source.topic}` : ''}` : source.materialStatus === 'failed' ? '材料处理未完成，原回答保留。' : '材料仍在整理或核对。'}</p></div><div className={styles.sourceActions}>{source.totalCount > 0 && <StartSentenceButton scope={{type: source.type === 'question' ? 'question' : 'conversation', id: source.id}} mode="learn" label="打开整题学习"/>}<Link href={source.href}>查看来源与材料</Link>{source.type === 'question' && <Link href={`/answer-history/${encodeURIComponent(source.id)}`}>回答与原声历史</Link>}</div></article>)}</div>}
    {!loading && data && !shown.length && <div className={styles.empty}><h2>{query || filter !== 'all' ? '没有匹配的句子' : '从你想说的话开始'}</h2><p>{query || filter !== 'all' ? '换个关键词，或清除筛选查看当前范围的全部句子。' : '先保存一份回答或对话，审核后的自然表达会出现在这里。'}</p>{query || filter !== 'all' ? <button type="button" className="secondary-button" onClick={() => {setQuery(''); setFilter('all');}}>清除搜索与筛选</button> : <Link className="primary-button" href={collection === 'free_talk' ? '/free-talk' : '/questions'}>{collection === 'free_talk' ? '开始对话' : '选择一道题'}</Link>}</div>}
  </section>;
}

function restoredCommand(value: unknown, card: SentenceCard, feedback: SentenceFeedback[]): Command | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Command, body = item.body;
  if (!body || typeof body !== 'object' || typeof body.clientRequestId !== 'string') return null;
  if (item.endpoint === 'preferences' || item.endpoint === 'feedback' && body.action === 'report') return body.sentenceId === card.id && body.unitVersion === card.version ? item : null;
  if (item.endpoint === 'feedback' && body.action === 'withdraw' && feedback.some(entry => entry.id === body.feedbackId)) return item;
  return null;
}
export function SentenceLibraryRow({card, feedback, onPreference, onFeedback, onReload}: {card: SentenceCard; feedback: SentenceFeedback[]; onPreference: (preference: SentencePreference) => void; onFeedback: (feedback: SentenceFeedback) => void; onReload: () => void}) {
  const preference = card.preference ?? emptyPreference, inputId = useId();
  const [note, setNote] = useState(preference.note), [reason, setReason] = useState(''), [kind, setKind] = useState<SentenceFeedback['kind']>('unclear');
  const [busy, setBusy] = useState(false), [pending, setPending] = useState<Command | null>(null), [message, setMessage] = useState(''), [error, setError] = useState('');
  const key = `roastduck-sentence-library:${card.id}:${card.version}`, savedNote = useRef(preference.note), alive = useRef(true), sending = useRef(false);
  useEffect(() => {alive.current = true; try {const raw = localStorage.getItem(key); if (raw) {const value = JSON.parse(raw); if (typeof value.note === 'string' && value.note.length <= 4000) setNote(value.note); if (typeof value.reason === 'string' && value.reason.length <= 4000) setReason(value.reason); const command = restoredCommand(value.pending, card, feedback); if (command) {setPending(command); setError('上次保存尚未确认，可以恢复同一次提交。');}}} catch {setError('本机暂存无法读取，请保留正在编辑的内容。');} return () => {alive.current = false;};
    // Each mounted row belongs to one stable sentence edition.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => {const previous = savedNote.current; setNote(value => value === previous ? preference.note : value); savedNote.current = preference.note;}, [preference.note]);
  function persist(nextNote = note, nextReason = reason, command: Command | null = pending) {localStorage.setItem(key, JSON.stringify({note: nextNote, reason: nextReason, pending: command}));}
  function editNote(value: string) {setNote(value); try {persist(value);} catch {setError('备注尚未暂存，请保留文字并检查浏览器存储。');}}
  function editReason(value: string) {setReason(value); try {persist(note, value);} catch {setError('反馈尚未暂存，请保留文字并检查浏览器存储。');}}
  async function send(command: Command) {
    if (sending.current) return;
    sending.current = true;
    try {persist(note, reason, command);} catch {sending.current = false; setError('本机暂存未完成，本次还没有发送。请保留文字并恢复浏览器存储。'); return;}
    setPending(command); setBusy(true); setError(''); setMessage('');
    try {
      const response = await fetch(`/api/sentence-study/${command.endpoint}`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(command.body)}), body = await response.json();
      if (!response.ok) {
        if (response.status === 400 || response.status === 409) {setPending(null); persist(note, reason, null);}
        throw new Error(body.error ?? '保存尚未确认，请重试。');
      }
      if (!alive.current) return;
      if (command.endpoint === 'preferences') {onPreference(body.preference); setMessage('个人设置已保存。');}
      else {onFeedback(body.feedback); if (command.body.action === 'report') setReason(''); setMessage(body.feedback.status === 'withdrawn' ? '材料反馈已撤回。' : '材料反馈已保存。');}
      setPending(null);
      try {persist(command.endpoint === 'preferences' && typeof command.body.note === 'string' ? body.preference.note : note, command.endpoint === 'feedback' && command.body.action === 'report' ? '' : reason, null);} catch {setError('服务器已保存，本机暂存清理失败；刷新后可以重新核对。');}
    } catch (failure) {if (alive.current) setError(failure instanceof Error ? failure.message : '网络中断，内容和提交编号仍保留。');}
    finally {sending.current = false; if (alive.current) setBusy(false);}
  }
  function setPreference(patch: Partial<Omit<SentencePreference, 'version'>>) {void send({endpoint: 'preferences', body: {clientRequestId: crypto.randomUUID(), sentenceId: card.id, unitVersion: card.version, version: preference.version, ...patch}});}
  const disabled = busy || !!pending;
  return <article className={styles.sentence}>
    <div className={styles.sentenceHeading}><Link href={card.source.href} className={styles.sourceLink}>{card.source.title}</Link><button type="button" className={styles.favorite} aria-label={preference.favorite ? '取消收藏这句' : '收藏这句'} aria-pressed={preference.favorite} disabled={disabled} onClick={() => setPreference({favorite: !preference.favorite})}><Star filled={preference.favorite}/>{preference.favorite ? '已收藏' : '收藏'}</button></div>
    <div className={styles.reading}><p className={styles.chinese}>{card.chinese}</p>{card.unavailable ? <div className={styles.unavailable}><p>这句材料暂缓使用</p><p>{card.unavailable}</p><details><summary>查看原句</summary><p lang="en">{card.english}</p></details></div> : <p className={styles.english} lang="en">{card.english}</p>}</div>
    <div className={styles.statuses}>{preference.hidden && <span>暂不提醒</span>}{preference.selfKnown && <span>自评已会 · 已停推</span>}{card.progressVersion > 0 ? <span>有自评记录</span> : card.firstExposedAt ? <span>已接触，尚未自评</span> : <span>尚未接触</span>}{!card.progressVersion && card.firstReviewDueAt && <span>首次回想：{new Date(card.firstReviewDueAt).toLocaleDateString('zh-CN')}</span>}</div>
    {preference.note && <p className={styles.savedNote}>我的备注：{preference.note}</p>}
    <div className={styles.rowActions}>{!card.unavailable && <Link className={styles.openLesson} href={`/sentence-study?${sentenceScopeQuery(sentenceCardScope(card))}&mode=learn`}>打开整题学习</Link>}<details className={styles.details}><summary>备注与学习偏好</summary><div className={styles.editor}>
      <label htmlFor={`${inputId}-note`}>我的备注<textarea id={`${inputId}-note`} value={note} maxLength={4000} rows={3} disabled={disabled} onChange={event => editNote(event.target.value)}/></label><button type="button" className="secondary-button" disabled={disabled || note === preference.note} onClick={() => setPreference({note})}>保存备注</button>
      <div className={styles.preferenceActions}><button type="button" aria-pressed={preference.hidden} disabled={disabled} onClick={() => setPreference(preference.hidden ? {hidden: false, selfKnown: false} : {hidden: true})}>{preference.hidden ? '恢复学习提醒' : '暂不学，停止提醒'}</button><button type="button" aria-pressed={preference.selfKnown} disabled={disabled} onClick={() => setPreference(preference.selfKnown ? {selfKnown: false, hidden: false} : {selfKnown: true})}>{preference.selfKnown ? '重新加入学习' : '我已会，先不提醒'}</button></div><p className={styles.hint}>这些是个人偏好，原句和历史记录保留，不会补记学习成绩。</p>
    </div></details><details className={styles.details}><summary>材料反馈{feedback.some(item => item.status === 'open') ? ' · 有记录' : ''}</summary><div className={styles.editor}>
      <label htmlFor={`${inputId}-kind`}>反馈类型<select id={`${inputId}-kind`} value={kind} disabled={disabled} onChange={event => setKind(event.target.value as SentenceFeedback['kind'])}>{Object.entries(feedbackLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label htmlFor={`${inputId}-reason`}>哪儿需要改进？<textarea id={`${inputId}-reason`} rows={3} maxLength={4000} value={reason} disabled={disabled} onChange={event => editReason(event.target.value)}/></label>
      {kind === 'incorrect' && <p className={styles.hint}>提交后，这版句子会暂缓作为示范。需要时可撤回反馈。</p>}
      <button type="button" className="secondary-button" disabled={disabled || !reason.trim()} onClick={() => void send({endpoint: 'feedback', body: {action: 'report', clientRequestId: crypto.randomUUID(), sentenceId: card.id, unitVersion: card.version, kind, reason}})}>保存材料反馈</button>
      {feedback.length > 0 && <ol className={styles.feedbackList}>{feedback.map(item => <li key={item.id}><p><strong>{feedbackLabels[item.kind]}</strong>{item.unitVersion !== card.version ? ' · 旧版反馈' : ''} · {item.status === 'withdrawn' ? '已撤回' : '已保存'}</p><p>{item.reason}</p>{item.status === 'open' && <button type="button" disabled={disabled} onClick={() => void send({endpoint: 'feedback', body: {action: 'withdraw', clientRequestId: crypto.randomUUID(), feedbackId: item.id}})}>撤回这条反馈</button>}</li>)}</ol>}
    </div></details></div>
    {busy && <p className={styles.hint} role="status">正在保存…</p>}{message && <p className={styles.hint} role="status">{message}</p>}{error && <div className={styles.error} role="alert"><p>{error}</p>{pending ? <button type="button" disabled={busy} onClick={() => void send(pending)}>恢复同一次保存</button> : <button type="button" onClick={onReload}>读取最新设置</button>}</div>}
  </article>;
}
