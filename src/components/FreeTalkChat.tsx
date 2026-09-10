"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { FreeTalkMode } from "@/lib/free-talk/schemas";
import { getTTS } from "@/lib/tts";
import type {LightAudioState} from '@/lib/light-study/audio';
import { VoiceSelector } from "./VoiceSelector";
import { IeltsTopicDrawer, type IeltsQuestionItem } from "./IeltsTopicDrawer";
import {MaterialResult} from './MaterialResult';
import styles from './FreeTalkChat.module.css';

interface ConversationSummary {
  id: string;
  title: string;
  mode: FreeTalkMode;
  createdAt: string;
  updatedAt: string;
}

interface MessageView {
  id: string;
  conversationId: string;
  sequenceNo: number;
  role: "user" | "assistant";
  text: string;
  teachingState: "repetition_requested" | "repetition_confirmed" | null;
  targetRepetition: string | null;
  gapCount: number;
  metadata: {
    clientMessageId?: string; deliveryStatus?: "pending" | "failed" | "completed";errorCode?:string;
    translationZh?: string;
    userCorrection?: {
      natural: boolean;
      issue?: string;
      betterExpression?: string;
      explanationZh?: string;
    };
    gaps?: Array<{
      key: string;
      intentZh: string;
      targetEnglish: string;
      gapType: string;
      evidence: string;
      explanationZh: string;
    }>;
    resurfacedItemKey?: string | null;
  };
  createdAt: string;
}

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
}

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

function speechRecognitionConstructor(): SpeechRecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  const candidate = window as typeof window & {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return candidate.SpeechRecognition ?? candidate.webkitSpeechRecognition ?? null;
}

export function FreeTalkChat({
  initialConversations,
  activeConversationId,
}: {
  initialConversations: ConversationSummary[];
  activeConversationId?: string;
}) {
  const [conversations, setConversations] = useState(initialConversations);
  const [currentId, setCurrentId] = useState(
    activeConversationId || initialConversations[0]?.id || "",
  );
  const [messages, setMessages] = useState<MessageView[]>([]);
  const [mode, setMode] = useState<FreeTalkMode>(
    conversations.find((c) => c.id === currentId)?.mode || "relaxed",
  );
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [listening, setListening] = useState(false);
  const [speakingMsgId, setSpeakingMsgId] = useState<string | null>(null);
  const [speechState,setSpeechState]=useState<{id:string;state:LightAudioState}|null>(null);
  const [isTopicDrawerOpen, setIsTopicDrawerOpen] = useState(false);
  const [expandedTranslations, setExpandedTranslations] = useState<Record<string, boolean>>({});
  const createRequest=useRef<string|null>(null);
  const [rangeStart,setRangeStart]=useState(''),[rangeEnd,setRangeEnd]=useState('');
  const [conversationListOpen, setConversationListOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [reviewRangeOpen, setReviewRangeOpen] = useState(false);
  const candidateDialog = useRef<HTMLDialogElement>(null);

  const epochRef = useRef(0);
  const invalidateRequests = useCallback(() => { epochRef.current++; }, []);
  const pendingConversations = useRef(new Set<string>());
  const drafts = useRef<Record<string, string>>({});
  const [loadingMessages, setLoadingMessages] = useState(false);
  function releaseRecognition() {
    const recognition = recognitionRef.current;
    if (recognition) { recognition.onresult = null; recognition.onerror = null; recognition.onend = null; recognition.abort(); recognitionRef.current = null; }
  }
  function selectConversation(id: string, nextMode: FreeTalkMode) {
    epochRef.current++;
    drafts.current[currentId] = input;
    releaseRecognition(); getTTS().stop();
    setRangeStart('');setRangeEnd('');setSpeechState(null);
    setConversationListOpen(false); setReviewRangeOpen(false);
    setCurrentId(id); setMode(nextMode); setMessages([]); setInput(drafts.current[id] ?? ""); setError(""); setListening(false); setSpeakingMsgId(null); setBusy(pendingConversations.current.has(id));
  }
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, busy]);

  // GET 只读；切换与卸载立即使旧回调失效并释放音频/听写资源。
  useEffect(() => {
    const controller = new AbortController();
    const generation = epochRef.current;
    if (currentId) {
      setLoadingMessages(true);
      void fetch(`/api/free-talk/conversations/${encodeURIComponent(currentId)}/messages`, { signal: controller.signal })
        .then(async (response) => { if (!response.ok) throw new Error("加载对话记录失败"); return response.json(); })
        .then((data) => { if (!controller.signal.aborted && generation === epochRef.current) setMessages(data.messages ?? []); })
        .catch(() => { if (!controller.signal.aborted && generation === epochRef.current) setError("加载对话记录失败，请刷新恢复"); })
        .finally(() => { if (!controller.signal.aborted && generation === epochRef.current) setLoadingMessages(false); });
    }
    return () => { controller.abort(); invalidateRequests(); releaseRecognition(); getTTS().stop(); };
  }, [currentId, invalidateRequests]);

  async function handleCreateConversation(newMode: FreeTalkMode = "relaxed") {
    setBusy(true);
    setError("");
    try {
      createRequest.current??=crypto.randomUUID();
      const response = await fetch("/api/free-talk/conversations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientRequestId:createRequest.current,
          title: `Free Talk (${newMode === "strict" ? "Strict" : "Relaxed"})`,
          mode: newMode,
        }),
      });
      const data = (await response.json()) as {
        conversation?: ConversationSummary;
        error?: string;
      };
      if (!response.ok || !data.conversation) {
        throw new Error(data.error || "创建对话失败");
      }
      setConversations((prev) => [data.conversation!, ...prev]);
      selectConversation(data.conversation.id, data.conversation.mode);
      createRequest.current=null;
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建对话失败");
    } finally {
      setBusy(false);
    }
  }

  async function sendDirectMessage(userText: string, retryMessage?: MessageView) {
    if (!userText.trim() || loadingMessages || !currentId || pendingConversations.current.has(currentId)) return;
    const conversation = currentId, generation = epochRef.current;
    const requestId = retryMessage?.metadata.clientMessageId ?? crypto.randomUUID();
    const retryUnknown=retryMessage?.metadata.errorCode==='result_unknown';
    if(retryUnknown&&!window.confirm('上次回复结果未确认，重新请求可能再次使用 API 余额。继续？'))return;
    const tempId = retryMessage?.id ?? `temp_${requestId}`;
    pendingConversations.current.add(conversation);
    setBusy(true); setError("");
    const temporary: MessageView = { id: tempId, conversationId: conversation, sequenceNo: messages.length + 1, role: "user", text: userText, teachingState: null, targetRepetition: null, gapCount: 0, metadata: { clientMessageId: requestId, deliveryStatus: "pending" }, createdAt: new Date().toISOString() };
    setMessages((previous) => retryMessage ? previous.map((message) => message.id === tempId ? { ...message, metadata: { ...message.metadata, deliveryStatus: "pending" } } : message) : [...previous, temporary]);
    try {
      const response = await fetch(`/api/free-talk/conversations/${encodeURIComponent(conversation)}/messages`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: userText, mode, clientMessageId: requestId, retry: Boolean(retryMessage),retryUnknown }),
      });
      const data = await response.json();
      if (!response.ok || !data.assistantMessage) throw Object.assign(new Error(data.error || "发送消息失败"),{code:data.code});
      if (generation !== epochRef.current) return;
      if(data.assistantMessage.conversationId&&data.assistantMessage.conversationId!==currentId){selectConversation(data.assistantMessage.conversationId,mode);return;}
      if(data.messages){setMessages(data.messages);return;}
      setMessages((previous) => [
        ...previous.filter((m) => m.id !== data.assistantMessage.id).map((m) => m.id === tempId ? { ...m, id: data.userMessageId ?? m.id, metadata: { ...m.metadata, deliveryStatus: "completed", userCorrection: data.userCorrection } } : m),
        data.assistantMessage,
      ]);
    } catch (reason) {
      if (generation !== epochRef.current) return;
      setError(reason instanceof Error ? reason.message : "消息发送失败，原文已保留");
      setMessages((previous) => previous.map((message) => message.id === tempId ? { ...message, metadata: { ...message.metadata, deliveryStatus: "failed",errorCode:reason&&typeof reason==='object'&&'code' in reason?String(reason.code):undefined } } : message));
    } finally {
      pendingConversations.current.delete(conversation);
      if (generation === epochRef.current) setBusy(false);
    }
  }

  async function handleSendMessage(e?: React.FormEvent) {
    if (e) e.preventDefault();
    if (!input.trim() || busy || loadingMessages || !currentId) return;

    const userText = input.trim();
    setInput("");
    await sendDirectMessage(userText);
  }

  async function handleStartTopic(topic: IeltsQuestionItem) {
    const promptText = `Hi Chloe! I'd like to practice this IELTS Speaking Part ${topic.part} topic: "${topic.textEn}". What's your first question or thought on this topic?`;
    await sendDirectMessage(promptText);
  }


  function toggleSpeech() {
    if (listening) {
      releaseRecognition();
      setListening(false);
      return;
    }
    releaseRecognition();
    const Recognition = speechRecognitionConstructor();
    if (!Recognition) {
      setError("当前浏览器不支持网页听写，请使用 Win + H 或直接键入。");
      return;
    }
    const recognition = new Recognition();
    recognition.lang = "en-US";
    recognition.continuous = true;
    recognition.interimResults = true;
    let committed = "";
    const before = input.trim();
    recognition.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const res = event.results[i];
        if (res.isFinal) committed += res[0].transcript;
        else interim += res[0].transcript;
      }
      const recognized = `${committed}${interim}`.trim();
      setInput([before, recognized].filter(Boolean).join(before ? " " : ""));
    };
    recognition.onerror = () => setListening(false);
    recognition.onend = () => setListening(false);
    recognitionRef.current = recognition;
    try {
      recognition.start();
      setListening(true);
    } catch {
      setListening(false);
    }
  }

  function playAudio(msgId: string, text: string,retryUnknown=false) {
    setSpeakingMsgId(msgId);
    const generation = epochRef.current;
    const finished = () => { if (generation === epochRef.current) setSpeakingMsgId((current) => current === msgId ? null : current); };
    getTTS().speak(text, {retryUnknown,ownerId:`chat:${currentId}`,onState:state=>{if(generation===epochRef.current)setSpeechState({id:msgId,state});}, onEnd: finished, onError: finished });
  }

  function stopAudio() {
    getTTS().stop();
    setSpeakingMsgId(null);
  }

  // Aggregate all captured gaps in this conversation
  const capturedGaps = messages.flatMap((m) => m.metadata.gaps ?? []);
  const [activeMaterialId, setActiveMaterialId] = useState<string | null>(null);
  const [preparingReview, setPreparingReview] = useState(false);
  async function startMaterialReview() {
    if (!currentId || preparingReview) return;
    const generation = epochRef.current;
    setPreparingReview(true); setError("");
    try {
      const response = await fetch(`/api/free-talk/conversations/${encodeURIComponent(currentId)}/materials`, { method: "POST",headers:{'Content-Type':'application/json'},body:JSON.stringify({startId:rangeStart||messages[Math.max(0,messages.length-12)]?.id,endId:rangeEnd||messages.at(-1)?.id}) });
      const body = await response.json();
      if (!response.ok || !body.materialId) throw new Error(body.error || "复盘暂时不可用");
      if (generation === epochRef.current) { releaseRecognition(); stopAudio(); setListening(false); setActiveMaterialId(body.materialId); }
    } catch (reason) { setError(reason instanceof Error ? reason.message : "复盘失败，请重试"); }
    finally { setPreparingReview(false); }
  }

  // Last assistant message with repetition request
  const lastMsg = messages[messages.length - 1];
  const isWaitingForRepetition =
    lastMsg?.role === "assistant" &&
    lastMsg.teachingState === "repetition_requested" &&
    lastMsg.targetRepetition;

  if (activeMaterialId) return <><button className="exit-button" onClick={()=>setActiveMaterialId(null)}>← 返回聊天</button><MaterialResult id={activeMaterialId}/></>;

  const hasUserMessages = messages.some((message) => message.role === "user");
  const canReview = hasUserMessages && !busy && !loadingMessages && !preparingReview;

  return (
    <div className={styles.shell}>
      <section className={styles.main} data-testid="freetalk-main" aria-label="与 Chloe 对话">
        <header className={styles.header}>
          <div className={styles.titleRow}>
            <div>
              <h1>与 Chloe 聊聊</h1>
              <p>中文、英文或混合都可以，聊完再整理想学的表达。</p>
            </div>
            {busy && <span className={styles.status} role="status">正在等待 Chloe 回复…</span>}
          </div>
          <div className={styles.toolbar}>
            <button type="button" className="secondary-button" aria-expanded={conversationListOpen} aria-controls="conversation-history" onClick={() => { setConversationListOpen(!conversationListOpen); setSettingsOpen(false); }}>
              {conversationListOpen ? "收起历史" : "历史对话"}
            </button>
            <button type="button" className="secondary-button" disabled={busy || preparingReview} onClick={() => void handleCreateConversation(mode)}>新建对话</button>
            <button type="button" className="secondary-button" aria-expanded={settingsOpen} aria-controls="conversation-settings" onClick={() => { setSettingsOpen(!settingsOpen); setConversationListOpen(false); }}>
              对话设置
            </button>
            <button type="button" className="primary-button" aria-expanded={reviewRangeOpen} aria-controls="conversation-review-range" disabled={!canReview} onClick={() => { setReviewRangeOpen(!reviewRangeOpen); setConversationListOpen(false); setSettingsOpen(false); }}>
              {preparingReview ? "正在准备材料…" : "复盘本轮表达"}
            </button>
          </div>
          {conversationListOpen && <nav id="conversation-history" className={styles.history} aria-label="历史对话">
            {conversations.length ? conversations.map((conversation) => (
              <button key={conversation.id} type="button" aria-current={conversation.id === currentId ? "true" : undefined} onClick={() => selectConversation(conversation.id, conversation.mode)}>
                <span>{conversation.title}</span>
                <small>{conversation.mode === "strict" ? "精练" : "轻松"} · {new Date(conversation.updatedAt).toLocaleDateString("zh-CN")}</small>
              </button>
            )) : <p>还没有对话。新建一段对话后，就可以开始聊。</p>}
          </nav>}
          {settingsOpen && <div id="conversation-settings" className={styles.settings}>
            <div>
              <h2>声音与模式</h2>
              <VoiceSelector />
            </div>
            <div className={styles.modeOptions} aria-label="对话模式">
              <button type="button" aria-pressed={mode === "relaxed"} onClick={() => setMode("relaxed")}>轻松畅聊</button>
              <button type="button" aria-pressed={mode === "strict"} onClick={() => setMode("strict")}>精练纠错</button>
            </div>
            <p>{mode === "relaxed" ? "先把对话聊下去。遇到不会说的意思可以用中文，之后再复盘。" : "Chloe 会针对关键表达给出建议，并邀请你复述。可以随时切回轻松畅聊。"}</p>
            <button type="button" className="secondary-button" disabled={!currentId || busy || loadingMessages} onClick={() => setIsTopicDrawerOpen(true)}>选择一道雅思话题</button>
          </div>}
          {reviewRangeOpen && <section id="conversation-review-range" className={styles.reviewRange} aria-label="选择复盘消息">
            <h2>这次复盘哪些消息？</h2>
            <p>默认最近 12 条，最多 24 条。确认范围后开始整理材料。</p>
            <div className={styles.rangeFields}>
              <label>从
                <select value={rangeStart} onChange={(event) => setRangeStart(event.target.value)}>
                  <option value="">最近 12 条的起点</option>
                  {messages.map((message) => <option key={message.id} value={message.id}>{message.role === "user" ? "我" : "Chloe"}：{message.text.slice(0, 45)}</option>)}
                </select>
              </label>
              <label>到
                <select value={rangeEnd} onChange={(event) => setRangeEnd(event.target.value)}>
                  <option value="">最新消息</option>
                  {messages.map((message) => <option key={message.id} value={message.id}>{message.role === "user" ? "我" : "Chloe"}：{message.text.slice(0, 45)}</option>)}
                </select>
              </label>
            </div>
            <div className={styles.actions}>
              <button type="button" className="primary-button" disabled={!canReview} onClick={() => void startMaterialReview()}>{preparingReview ? "正在准备材料…" : "确认范围，开始复盘"}</button>
              <button type="button" className="secondary-button" disabled={preparingReview} onClick={() => setReviewRangeOpen(false)}>继续聊天</button>
            </div>
          </section>}
        </header>

        {error && <div className={styles.error} role="alert"><span>{error}</span><button type="button" onClick={() => setError("")}>关闭提示</button></div>}

        <div className={styles.messages} aria-busy={loadingMessages}>
          {loadingMessages && <p className={styles.empty} role="status">正在读取对话…</p>}
          {!loadingMessages && !messages.length && <div className={styles.empty}><h2>{currentId ? "从你想说的事开始" : "先新建一段对话"}</h2><p>{currentId ? "可以聊今天发生的事，也可以直接用中文说出暂时不会表达的意思。" : "点击上方“新建对话”，已有记录会一直保留在历史里。"}</p></div>}
          {messages.map((message) => <article key={message.id} className={`${styles.message} ${message.role === "user" ? styles.userMessage : styles.assistantMessage}`}>
            <div className={styles.messageHeader}>
              <span>{message.role === "user" ? "我" : "Chloe · AI"}</span>
              {message.role === "assistant" && <div className={styles.messageActions}>
                <button type="button" onClick={() => speakingMsgId === message.id ? stopAudio() : playAudio(message.id, message.text)}>{speakingMsgId === message.id ? "停止" : "朗读"}</button>
                <button type="button" aria-expanded={!!expandedTranslations[message.id]} onClick={() => setExpandedTranslations((previous) => ({ ...previous, [message.id]: !previous[message.id] }))}>{expandedTranslations[message.id] ? "收起翻译" : "翻译"}</button>
              </div>}
            </div>
            <div className={styles.messageText} lang={message.role === "assistant" ? "en" : undefined}>{message.text}</div>
            {speechState?.id === message.id && <div className={styles.audioStatus} role="status">{speechState.state.message}{["result_unknown", "invalid_audio"].includes(speechState.state.errorCode ?? "") && <button type="button" onClick={() => { if (window.confirm("重新合成此回复可能再次使用 MiMo 余额，继续？")) playAudio(message.id, message.text, true); }}>重新生成此声音</button>}</div>}
            {message.role === "user" && ["failed", "pending"].includes(message.metadata.deliveryStatus ?? "") && <div className={styles.delivery} role="status"><p>{message.metadata.deliveryStatus === "pending" ? "正在等待回复，原文已保存。" : "回复未完成，原文已保留。"}</p><button className="secondary-button" disabled={busy} onClick={() => void sendDirectMessage(message.text, message)}>原地重试</button></div>}
            {message.role === "assistant" && expandedTranslations[message.id] && <div className={styles.translation}><strong>中文对照</strong><p>{message.metadata.translationZh || "这条回复暂未提供中文翻译。"}</p></div>}
            {message.role === "user" && message.metadata.userCorrection && !message.metadata.userCorrection.natural && <details className={styles.correction}>
              <summary>看看表达建议</summary>
              {message.metadata.userCorrection.issue && <p>{message.metadata.userCorrection.issue}</p>}
              {message.metadata.userCorrection.betterExpression && <p lang="en"><strong>{message.metadata.userCorrection.betterExpression}</strong></p>}
              {message.metadata.userCorrection.explanationZh && <p>{message.metadata.userCorrection.explanationZh}</p>}
            </details>}
          </article>)}
          <div ref={messagesEndRef} />
        </div>

        {isWaitingForRepetition && <div className={styles.repetition}><strong>可以试着复述：</strong><span lang="en">{lastMsg.targetRepetition}</span></div>}
        <footer className={styles.composer}>
          {capturedGaps.length > 0 && <button type="button" className={styles.candidateButton} onClick={() => candidateDialog.current?.showModal()}>查看待复盘候选（{capturedGaps.length}）</button>}
          <form className={styles.inputForm} onSubmit={handleSendMessage}>
            <label className="sr-only" htmlFor="free-talk-message">给 Chloe 的消息</label>
            <textarea id="free-talk-message" disabled={loadingMessages || !currentId} rows={3} value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void handleSendMessage(); } }} placeholder={isWaitingForRepetition ? `试着复述：“${lastMsg.targetRepetition}”` : "说说你想聊的事，中英文都可以…"} />
            <div className={styles.inputActions}>
              <span>Enter 发送 · Shift + Enter 换行</span>
              <button type="button" className="secondary-button" aria-pressed={listening} disabled={!currentId || loadingMessages} onClick={toggleSpeech}>{listening ? "停止听写" : "听写"}</button>
              <button type="submit" className="primary-button" disabled={busy || loadingMessages || !currentId || !input.trim()}>发送</button>
            </div>
          </form>
        </footer>
      </section>

      <dialog ref={candidateDialog} className={styles.candidateDrawer} aria-labelledby="candidate-drawer-title" onClick={(event) => { if (event.target === event.currentTarget) candidateDialog.current?.close(); }}>
        <div className={styles.drawerHeader}><h2 id="candidate-drawer-title">待复盘候选</h2><button type="button" className="secondary-button" onClick={() => candidateDialog.current?.close()}>关闭</button></div>
        <p>这些是对话中的候选表达，还需复盘审核。候选数量不代表最终学习项数量。</p>
        <ul className={styles.candidateList}>{capturedGaps.map((gap, index) => <li key={`${gap.key}-${index}`}><h3>{gap.intentZh}</h3><p lang="en">{gap.targetEnglish}</p><p>{gap.explanationZh}</p></li>)}</ul>
        <button type="button" className="primary-button" disabled={!canReview} onClick={() => { candidateDialog.current?.close(); setReviewRangeOpen(true); setSettingsOpen(false); setConversationListOpen(false); }}>选择消息范围，去复盘</button>
      </dialog>
      <IeltsTopicDrawer isOpen={isTopicDrawerOpen} onClose={() => setIsTopicDrawerOpen(false)} onSelectTopic={(topic) => void handleStartTopic(topic)} />
    </div>
  );
}
