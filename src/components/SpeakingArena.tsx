"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import type { QuestionDetail } from "@/lib/questions/service";
import type { SpeakingSessionView } from "@/lib/speaking/service";
import { getTTS } from "@/lib/tts";
import { InteractiveEnglishText } from "./InteractiveEnglishText";
import { LookupCard } from "./LookupCard";

interface RecognitionEventLike { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>; }
interface RecognitionLike { lang: string; continuous: boolean; interimResults: boolean; start(): void; stop(): void; abort(): void; onresult: ((event: RecognitionEventLike) => void) | null; onerror: ((event: { error: string }) => void) | null; onend: (() => void) | null; }
type RecognitionConstructor = new () => RecognitionLike;
type InputLanguage = "zh" | "en" | "mixed";
type OptimisticMessage = { id: string; text: string; messageKind: "text" | "voice" };
type MemoryNotice = { id: string; category: string; summary: string };

function recognitionConstructor(): RecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  const candidate = window as typeof window & { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor };
  return candidate.SpeechRecognition ?? candidate.webkitSpeechRecognition ?? null;
}

function statusLabel(session: SpeakingSessionView | null) {
  if (!session) return "正在准备";
  if (session.status === "teacher_responding") return "Chloe 正在回复";
  if (session.status === "evaluating") return "正在独立分析";
  if (session.status === "ai_failed") return "回复待重试";
  if (session.status === "completed") return "本轮已完成";
  return "在线教学中";
}

export function SpeakingArena({ question, answerId, resumeSessionId }: { question: QuestionDetail; answerId: string | null; resumeSessionId?: string }) {
  const requestId = useRef<string | null>(null);
  const completionEventId = useRef<string | null>(null);
  const recognitionRef = useRef<RecognitionLike | null>(null);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const [session, setSession] = useState<SpeakingSessionView | null>(null);
  const [lookupId, setLookupId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [inputLanguage, setInputLanguage] = useState<InputLanguage>("mixed");
  const [listening, setListening] = useState(false);
  const [draftFromVoice, setDraftFromVoice] = useState(false);
  const [optimisticMessage, setOptimisticMessage] = useState<OptimisticMessage | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [speechNote, setSpeechNote] = useState("");
  const [contextExpanded, setContextExpanded] = useState(false);
  const [newMemories, setNewMemories] = useState<MemoryNotice[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const storageKey = `roastduck:speaking:${question.id}:${answerId ?? "new"}`;
        requestId.current = window.localStorage.getItem(storageKey) || crypto.randomUUID();
        window.localStorage.setItem(storageKey, requestId.current);
        const response = resumeSessionId ? await fetch(`/api/speaking/sessions/${encodeURIComponent(resumeSessionId)}`, { cache: "no-store", signal: controller.signal }) : await fetch("/api/speaking/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ clientRequestId: requestId.current, questionId: question.id, answerId }),
          signal: controller.signal,
        });
        const body = (await response.json()) as { session?: SpeakingSessionView; error?: string };
        if (!response.ok || !body.session) throw new Error(body.error || "Chloe 准备失败");
        if (body.session.questionId !== question.id) throw new Error("这个会话不属于当前题目，请从题库重新进入。");
        setSession(body.session);
      } catch (reason) {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Chloe 准备失败");
      }
    })();
    return () => { controller.abort(); recognitionRef.current?.abort(); getTTS().stop(); };
  }, [answerId, question.id, resumeSessionId]);

  useEffect(() => {
    const messageList = messageListRef.current;
    if (messageList) messageList.scrollTop = messageList.scrollHeight;
  }, [session?.messages.length]);

  useEffect(() => {
    if (!session || session.status !== 'teacher_responding' || session.messages.some((message) => message.retryable)) return;
    const controller = new AbortController();
    const timer = window.setInterval(() => {
      void fetch(`/api/speaking/sessions/${encodeURIComponent(session.id)}`, { cache: 'no-store', signal: controller.signal })
        .then(async (response) => { if (response.ok) { const body = await response.json(); if (body.session) setSession(body.session); } })
        .catch(() => { /* 暂时离线时保留已保存消息，下轮刷新继续。 */ });
    }, 5000);
    return () => { window.clearInterval(timer); controller.abort(); };
  }, [session]);

  const failedMessage = useMemo(
    () => session?.messages.findLast((message) => message.role === "user" && message.retryable) ?? null,
    [session?.messages],
  );
  const comparisonSummary = useMemo(() => {
    const items = session?.gapComparisons ?? [];
    return {
      total: items.length,
      improved: items.filter((item) => item.comparison === "improved").length,
      repeated: items.filter((item) => item.comparison === "repeated").length,
      newCount: items.filter((item) => item.comparison === "new").length,
      uncertain: items.filter((item) => item.comparison === "uncertain").length,
    };
  }, [session?.gapComparisons]);

  async function postMessage(payload: { clientMessageId: string; text: string; inputLanguage: InputLanguage; messageKind: "text" | "voice"; retry: boolean }) {
    if (!session) return;
    let receivedSession = false;
    setBusy(true);
    setError("");
    if (!payload.retry) {
      setOptimisticMessage({ id: payload.clientMessageId, text: payload.text, messageKind: payload.messageKind });
      setDraft("");
      setDraftFromVoice(false);
    }
    try {
      const response = await fetch(`/api/speaking/sessions/${encodeURIComponent(session.id)}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await response.json()) as { session?: SpeakingSessionView & { newMemories?: MemoryNotice[] }; error?: string };
      if (body.session) {
        receivedSession = true;
        setSession(body.session);
      }
      if (!response.ok || !body.session) throw new Error(body.error || "Chloe 回复失败");
      setNewMemories(body.session.newMemories ?? []);
      setDraft("");
      setDraftFromVoice(false);
      setSpeechNote("");
    } catch (reason) {
      if (!payload.retry && !receivedSession) {
        setDraft(payload.text);
        setDraftFromVoice(payload.messageKind === "voice");
      }
      setError(reason instanceof Error ? reason.message : "Chloe 回复失败");
    } finally {
      setOptimisticMessage(null);
      setBusy(false);
    }
  }

  async function sendDraft() {
    if (!draft.trim()) { setError("可以用中文、英文或中英混合，先把想法说出来。"); return; }
    await postMessage({ clientMessageId: crypto.randomUUID(), text: draft.trim(), inputLanguage, messageKind: draftFromVoice ? "voice" : "text", retry: false });
  }

  async function retryFailedMessage() {
    if (!failedMessage) return;
    await postMessage({
      clientMessageId: failedMessage.clientMessageId,
      text: failedMessage.text,
      inputLanguage: failedMessage.inputLanguage ?? "mixed",
      messageKind: failedMessage.messageKind,
      retry: true,
    });
  }

  async function endConversation() {
    if (!session) return;
    completionEventId.current ??= crypto.randomUUID();
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/speaking/sessions/${encodeURIComponent(session.id)}/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "complete_conversation", clientEventId: completionEventId.current }),
      });
      const body = (await response.json()) as { session?: SpeakingSessionView; error?: string };
      if (body.session) setSession(body.session);
      if (!response.ok || !body.session) throw new Error(body.error || "结束会话失败");
      completionEventId.current = null;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "结束会话失败");
    } finally {
      setBusy(false);
    }
  }

  async function dismissMemory(id: string) {
    const response = await fetch("/api/companion/memories", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, status: "dismissed" }) });
    if (response.ok) setNewMemories((items) => items.filter((item) => item.id !== id));
  }

  async function reveal(level: number) {
    if (!session) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/speaking/sessions/${encodeURIComponent(session.id)}/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "reveal_hint", clientEventId: crypto.randomUUID(), level }),
      });
      const body = (await response.json()) as { session?: SpeakingSessionView; error?: string };
      if (!response.ok || !body.session) throw new Error(body.error || "展开提示失败");
      setSession(body.session);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "展开提示失败");
    } finally {
      setBusy(false);
    }
  }

  function toggleSpeech() {
    if (listening) { recognitionRef.current?.stop(); setListening(false); return; }
    const Recognition = recognitionConstructor();
    if (!Recognition) { setSpeechNote("当前浏览器不支持网页听写。请按 Win + H，转写文本仍可编辑。"); return; }
    const recognition = new Recognition();
    recognition.lang = inputLanguage === "en" ? "en-US" : "zh-CN";
    recognition.continuous = true;
    recognition.interimResults = true;
    const before = draft.trim();
    let committed = "";
    recognition.onresult = (event) => {
      let interim = "";
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (result.isFinal) committed += result[0].transcript;
        else interim += result[0].transcript;
      }
      setDraft([before, `${committed}${interim}`.trim()].filter(Boolean).join(before ? " " : ""));
    };
    recognition.onerror = (event) => {
      setListening(false);
      setSpeechNote(event.error === "not-allowed" ? "麦克风未授权；可按 Win + H 或直接输入。" : "听写中断，已识别文字仍保留。");
    };
    recognition.onend = () => setListening(false);
    recognitionRef.current = recognition;
    try { recognition.start(); setListening(true); setDraftFromVoice(true); setSpeechNote("正在转写；发送前可以继续修改，原始录音不会发给 DeepSeek。"); }
    catch { setSpeechNote("听写启动失败，请使用 Win + H 或手工输入。"); }
  }

  function startNewRound() {
    window.localStorage.removeItem(`roastduck:speaking:${question.id}:${answerId ?? "new"}`);
    window.location.assign(`/speaking-arena?question=${encodeURIComponent(question.id)}`);
  }

  return <div className="arena-shell"><div className="arena-frame arena-chat-frame">
    <header className="studio-header">
      <Link href={`/questions/${encodeURIComponent(question.id)}`} className="exit-button"><svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden="true"><path d="m15 6-6 6 6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>返回题目</Link>
      <div className="teacher-presence"><span aria-hidden="true" /><strong>Chloe · AI 学习搭子</strong><small>{statusLabel(session)}</small></div>
      <span className="arena-round">{session ? `第 ${Math.max(1, session.turnCount + 1)} 轮` : "准备中"}</span>
    </header>
    {error ? <div className="error-banner" role="alert"><span>{error}</span><button type="button" onClick={() => setError("")}>关闭</button></div> : null}
    {!session ? <section className="arena-loading" aria-live="polite"><div /><h1>Chloe 正在读题</h1><p>正在整理历史回答和本题表达，稍后就能自由开口。</p></section> : null}
    {session ? <div className="arena-chat-layout">
      <aside className="arena-chat-context">
        <button type="button" className="arena-context-toggle" aria-expanded={contextExpanded} aria-controls="speaking-context" onClick={() => setContextExpanded((value) => !value)}>题目与提示</button>
        <div id="speaking-context" className="arena-context-body" data-expanded={contextExpanded}>
        <InteractiveEnglishText content={question.interactiveQuestion} onLookup={setLookupId} className="arena-context-question" />
        <p>Part {question.part} · {question.topicZh || "雅思口语"}</p>
        <p>{question.textZh}</p>
        <div className="arena-context-note"><strong>你的思路</strong><small>{session.ideaSource === "user_history" ? "来自历史回答" : "AI 起步提示"}</small><p>{session.chineseIdea}</p></div>
        <div className="arena-chat-hints"><div><strong>卡住时再看</strong><span>提示不会限制你的回答方式</span></div>
          <button type="button" disabled={busy} onClick={() => void reveal(1)}>关键词</button>
          <button type="button" disabled={busy} onClick={() => void reveal(2)}>可用表达</button>
          {session.hintLevel >= 1 ? <div className="arena-chat-hint-content">{session.hints.interactiveKeywords.map((content) => <InteractiveEnglishText key={content.contentId} content={content} onLookup={setLookupId} />)}</div> : null}
          {session.hintLevel >= 2 ? <div className="arena-chat-hint-content">{session.hints.chunks.map((item, index) => <div key={session.hints.interactiveChunks[index].contentId}><InteractiveEnglishText content={session.hints.interactiveChunks[index]} onLookup={setLookupId} /><small>{item.meaningZh}</small></div>)}</div> : null}
        </div>
        </div>
      </aside>
      <section className="arena-conversation" aria-label="与 Chloe 的雅思口语对话">
        <div className="arena-chat-head"><div className="teacher-avatar" aria-hidden="true">C</div><div><strong>Chloe · IELTS 学习搭子</strong><span>自然美式英语 · 可以纯中文、纯英文或中英混合</span></div><em>{session.turnCount}/4 建议轮次</em></div>
        <div ref={messageListRef} className="arena-message-list" aria-live="polite">
          {session.messages.map((message) => <article key={message.id} className={`arena-message arena-message-${message.role} is-${message.status}`}>
            {message.role === "teacher" ? <div className="teacher-avatar" aria-hidden="true">C</div> : null}
            <div className="arena-message-column">
              <span>{message.role === "teacher" ? "Chloe" : message.role === "user" ? "你" : "系统"}</span>
              <div className="arena-bubble">
                {message.interactiveText.annotations.length ? <InteractiveEnglishText content={message.interactiveText} onLookup={setLookupId} /> : <p>{message.text}</p>}
                {message.role === "teacher" && /[A-Za-z]/.test(message.text) ? <button type="button" className="arena-play-message" onClick={() => getTTS().speak(message.text, { lang: "en-US", rate: .95 })}>播放</button> : null}
              </div>
              {message.status === "pending" ? <small>已保存，正在等待 Chloe 回复…</small> : null}
              {message.status === "failed" ? <small>消息已保留，Chloe 回复失败。</small> : null}
            </div>
          </article>)}
          {optimisticMessage ? <article key={optimisticMessage.id} className="arena-message arena-message-user is-pending">
            <div className="arena-message-column"><span>你</span><div className="arena-bubble"><p>{optimisticMessage.text}</p></div><small>{optimisticMessage.messageKind === "voice" ? "语音已转写，正在等待 Chloe 回复…" : "已保存，正在等待 Chloe 回复…"}</small></div>
          </article> : null}
          {session.status === "teacher_responding" || optimisticMessage ? <div className="arena-typing"><div className="teacher-avatar" aria-hidden="true">C</div><span><i /><i /><i /></span></div> : null}
        </div>
        {newMemories.map((memory) => <div key={memory.id} className="arena-memory-notice" role="status"><span>Chloe 已记住：{memory.summary}</span><button type="button" onClick={() => void dismissMemory(memory.id)}>撤销</button></div>)}
        {failedMessage ? <div className="arena-retry-message"><span>你的消息没有丢失。</span><button type="button" disabled={busy} onClick={() => void retryFailedMessage()}>重新请 Chloe 回复</button></div> : null}
        {session.status === "completed" ? <div className="arena-chat-complete"><strong>本轮回答、Gap 与学习材料审核已完成</strong><p>{comparisonSummary.total ? `本轮记录 ${comparisonSummary.newCount} 个新问题、${comparisonSummary.repeated} 个重复问题、${comparisonSummary.improved} 个已改善项${comparisonSummary.uncertain ? `，另有 ${comparisonSummary.uncertain} 个待确认项` : ""}。` : "本轮没有发现可确认的新问题。"}{session.learningMaterialCount ? `已有 ${session.learningMaterialCount} 个表达通过双语境审核并进入本题学习包。` : "本轮没有可直接制成学习卡的高价值表达。"}</p><div><Link href="/personal-book" className="primary-button">我的雅思答案</Link><Link href={`/learn?question=${encodeURIComponent(question.id)}`} className="secondary-button">学习本题表达</Link><button type="button" className="secondary-button" onClick={startNewRound}>再练一轮</button></div></div> : <div className="arena-composer">
          <div className="arena-language-picker" role="group" aria-label="回答语言">
            {([["mixed", "中英混合"], ["en", "英文"], ["zh", "中文"]] as const).map(([value, label]) => <button type="button" key={value} aria-pressed={inputLanguage === value} onClick={() => setInputLanguage(value)}>{label}</button>)}
          </div>
          <textarea aria-label="给 Chloe 的回答" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="放心说。不会的地方直接用中文，Chloe 会理解你的真实意思…" onKeyDown={(event) => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) void sendDraft(); }} />
          <div className="arena-composer-actions"><button type="button" className="arena-voice-button" aria-pressed={listening} onClick={toggleSpeech}>{listening ? "停止转写" : "语音输入"}</button><span>{speechNote || "Ctrl + Enter 发送 · 录音不上传"}</span><button type="button" className="primary-button" disabled={busy || !draft.trim() || session.status === "teacher_responding" || session.status === "ai_failed"} onClick={() => void sendDraft()}>{busy ? "Chloe 思考中…" : "发送"}</button></div>
          {session.messages.some((message) => message.role === "user") ? <button type="button" className="arena-end-button" disabled={busy || session.status === "teacher_responding" || Boolean(failedMessage)} onClick={() => void endConversation()}>{busy ? "正在保存并独立审核…" : session.status === "ai_failed" ? "重新保存并独立审核" : session.turnCount >= 4 ? "完成并分析这次回答" : "提前结束并分析"}</button> : null}
        </div>}
      </section>
    </div> : null}
  </div><LookupCard annotationId={lookupId} onClose={() => setLookupId(null)} /></div>;
}
