"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { FreeTalkMode } from "@/lib/free-talk/schemas";
import { getTTS } from "@/lib/tts";
import type {LightAudioState} from '@/lib/light-study/audio';
import { VoiceSelector } from "./VoiceSelector";
import { IeltsTopicDrawer, type IeltsQuestionItem } from "./IeltsTopicDrawer";
import {MaterialResult} from './MaterialResult';

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
  async function startFourStepMastery() {
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

  return (
    <div className="freetalk-shell">
      {/* Sidebar: Conversation List */}
      <aside className="freetalk-sidebar">
        <div className="freetalk-sidebar-header">
          <h2>Free Talk</h2>
          <button
            type="button"
            className="primary-button new-conv-btn"
            onClick={() => void handleCreateConversation(mode)}
          >
            + 新建对话
          </button>
        </div>

        <div className="conv-list">
          {conversations.map((conv) => (
            <button
              key={conv.id}
              type="button"
              className={`conv-item ${conv.id === currentId ? "is-active" : ""}`}
              onClick={() => {
                selectConversation(conv.id, conv.mode);
              }}
            >
              <div className="conv-item-title">{conv.title}</div>
              <div className="conv-item-meta">
                <span className={`mode-badge ${conv.mode}`}>
                  {conv.mode === "strict" ? "Strict" : "Relaxed"}
                </span>
                <span className="conv-item-date">
                  {new Date(conv.updatedAt).toLocaleDateString()}
                </span>
              </div>
            </button>
          ))}
        </div>
      </aside>

      {/* Main Chat Area */}
      <section className="freetalk-main" aria-label="与 Chloe 对话">
        {/* Header with Mode Toggle, WeChat typing status, Topic Picker, Voice Selector */}
        <header className="freetalk-header">
          <div className="header-info">
            <div className="header-title-row">
              <h1>AI Free Talk · 口语对练伙伴</h1>
              {busy ? (
                <div className="wechat-typing-status" aria-live="polite">
                  <span className="typing-text">Chloe 正在输入</span>
                  <span className="typing-dots">
                    <span className="dot dot-1">.</span>
                    <span className="dot dot-2">.</span>
                    <span className="dot dot-3">.</span>
                  </span>
                </div>
              ) : null}
            </div>
            <p className="freetalk-mode-desc">
              {mode === "relaxed"
                ? "【轻松畅聊模式】：注重对话流动。卡壳说中文或表达不自然时，AI 会在自然回复中以地道英语顺带纠错（Recast），对话不中断，后台保留待复盘候选。"
                : "【精练纠错模式】：注重强化吸收。出现关键表达卡壳时，AI 会稍作停留教学，并请你复述一次正确表达，确认准确后再继续交流。"}
            </p>
          </div>
          <div className="header-controls">
            <div className="freetalk-conversation-switcher">
              <select aria-label="当前对话" value={currentId} onChange={(event) => { const conv = conversations.find((item) => item.id === event.target.value); if (conv) selectConversation(conv.id, conv.mode); }}>
                {!currentId && <option value="">请选择或新建对话</option>}
                {conversations.map((conv) => <option key={conv.id} value={conv.id}>{conv.title}</option>)}
              </select>
              <button className="secondary-button" disabled={busy} onClick={() => void handleCreateConversation(mode)}>新建对话</button>
            </div>
            <button
              type="button"
              className="primary-button freetalk-mastery-btn"
              onClick={startFourStepMastery}
              disabled={busy || preparingReview || !messages.some((m) => m.role === "user")}
              title="复盘本轮对话沉淀的表达并进入 4 步强化营"
              style={{
                backgroundColor: capturedGaps.length > 0 ? "var(--color-primary-600, #4f46e5)" : "#64748b",
                color: "#ffffff",
                fontWeight: 600,
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
              }}
            >
              <span>🎯 复盘本轮表达</span>
              {capturedGaps.length > 0 ? (
                <span
                  style={{
                    backgroundColor: "rgba(255,255,255,0.25)",
                    padding: "1px 6px",
                    borderRadius: "9999px",
                    fontSize: "0.75rem",
                  }}
                >
                  {capturedGaps.length}
                </span>
              ) : null}
            </button>
            <button
              type="button"
              className="secondary-button topic-drawer-btn"
              onClick={() => setIsTopicDrawerOpen(true)}
              title="浏览雅思口语题库或随机抽题展开讨论"
            >
              🎯 雅思题库
            </button>
            <VoiceSelector compact />
            <div className="mode-toggle-group">
              <button
                type="button"
                className={`mode-toggle-btn ${mode === "relaxed" ? "active" : ""}`}
                onClick={() => setMode("relaxed")}
              >
                Relaxed (轻松)
              </button>
              <button
                type="button"
                className={`mode-toggle-btn ${mode === "strict" ? "active" : ""}`}
                onClick={() => setMode("strict")}
              >
                Strict (精练)
              </button>
            </div>
          </div>
        </header>

        {error ? (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button type="button" onClick={() => setError("")}>
              关闭
            </button>
          </div>
        ) : null}

        <details className="recap-range"><summary>选择复盘的消息范围（默认最近 12 条）</summary><label>从<select value={rangeStart} onChange={e=>setRangeStart(e.target.value)}><option value="">默认起点</option>{messages.map(m=><option key={m.id} value={m.id}>{m.role==='user'?'我':'Chloe'}：{m.text.slice(0,45)}</option>)}</select></label><label>到<select value={rangeEnd} onChange={e=>setRangeEnd(e.target.value)}><option value="">最新消息</option>{messages.map(m=><option key={m.id} value={m.id}>{m.role==='user'?'我':'Chloe'}：{m.text.slice(0,45)}</option>)}</select></label><p>最多 24 条。只对所选真实消息复盘，不拼造你的回答。</p></details>
        {/* Message Stream */}
        <div className="freetalk-messages">
          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`msg-row ${msg.role === "user" ? "user-row" : "assistant-row"}`}
            >
              <div className="msg-bubble">
                <div className="msg-header">
                  <span className="msg-author">
                    {msg.role === "user" ? "You" : "Chloe (AI)"}
                  </span>
                  {msg.role === "assistant" ? (
                    <div className="msg-action-btns">
                      <button
                        type="button"
                        className="tts-btn"
                        onClick={() =>
                          speakingMsgId === msg.id
                            ? stopAudio()
                            : playAudio(msg.id, msg.text)
                        }
                      >
                        {speakingMsgId === msg.id ? "⏹ 停止" : "🔊 朗读"}
                      </button>
                      <button
                        type="button"
                        className={`translate-btn ${expandedTranslations[msg.id] ? "is-active" : ""}`}
                        onClick={() =>
                          setExpandedTranslations((prev) => ({
                            ...prev,
                            [msg.id]: !prev[msg.id],
                          }))
                        }
                      >
                        {expandedTranslations[msg.id] ? "收起翻译" : "文 翻译"}
                      </button>
                    </div>
                  ) : null}
                </div>

                <div className="msg-content" lang={msg.role === "assistant" ? "en" : undefined}>
                  {msg.text}
                </div>
                {speechState?.id===msg.id&&<div className="speech-control-status" role="status">{speechState.state.message}{['result_unknown','invalid_audio'].includes(speechState.state.errorCode??'')&&<button type="button" onClick={()=>{if(window.confirm('重新合成此回复可能再次使用 MiMo 余额，继续？'))playAudio(msg.id,msg.text,true);}}>重新生成此声音</button>}</div>}

                {msg.role === "user" && ["failed", "pending"].includes(msg.metadata.deliveryStatus ?? "") && <div role="status"><p>{msg.metadata.deliveryStatus === "pending" ? "正在等待回复，原文已保存。" : "回复未完成，原文已保留。"}</p><button className="secondary-button" disabled={busy} onClick={() => void sendDirectMessage(msg.text, msg)}>原地重试</button></div>}
                {/* Assistant translation reveal */}
                {msg.role === "assistant" && expandedTranslations[msg.id] ? (
                  <div className="msg-translation-box">
                    <div className="translation-tag">中文对照</div>
                    <p className="translation-content">
                      {msg.metadata?.translationZh || "（暂未提供本句中文翻译）"}
                    </p>
                  </div>
                ) : null}

                {/* User correction inline tip */}
                {msg.role === "user" &&
                msg.metadata?.userCorrection &&
                !msg.metadata.userCorrection.natural ? (
                  <div className="user-correction-tip">
                    <div className="tip-tag">💡 地道表达建议</div>
                    {msg.metadata.userCorrection.issue ? (
                      <div className="tip-issue">
                        <span className="issue-label">问题：</span>
                        <span>{msg.metadata.userCorrection.issue}</span>
                      </div>
                    ) : null}
                    {msg.metadata.userCorrection.betterExpression ? (
                      <div className="tip-better">
                        <span className="better-label">推荐说法：</span>
                        <strong className="better-en" lang="en">
                          {msg.metadata.userCorrection.betterExpression}
                        </strong>
                      </div>
                    ) : null}
                    {msg.metadata.userCorrection.explanationZh ? (
                      <small className="tip-expl">
                        {msg.metadata.userCorrection.explanationZh}
                      </small>
                    ) : null}
                  </div>
                ) : null}

                {/* Captured Gap tags on message */}
                {msg.metadata?.gaps && msg.metadata.gaps.length > 0 ? (
                  <div className="msg-gap-tags">
                    {msg.metadata.gaps.map((gap, idx) => (
                      <span key={idx} className="gap-tag">
                        🎯 {gap.intentZh} → <strong>{gap.targetEnglish}</strong>
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          ))}

          <div ref={messagesEndRef} />
        </div>

        {/* Strict mode repetition alert if pending */}
        {isWaitingForRepetition ? (
          <div className="repetition-prompt-banner">
            <span className="rep-icon">🎤</span>
            <div className="rep-text">
              <strong>Chloe 正在聆听你的复述：</strong>
              <span>“{lastMsg.targetRepetition}”</span>
            </div>
          </div>
        ) : null}

        {/* Input Bar */}
        <div className="freetalk-bottom-bar" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px", padding: "0 4px" }}>
          <span style={{ fontSize: "0.82rem", color: "#64748b" }}>
            {capturedGaps.length > 0 ? `已捕捉到 ${capturedGaps.length} 个表达缺口，可随时进入 4 步强化营巩固` : "交流时遇到卡壳直接说中文，可以在复盘后形成学习材料"}
          </span>
          {capturedGaps.length > 0 ? (
            <button
              type="button"
              onClick={startFourStepMastery}
              style={{
                fontSize: "0.82rem",
                padding: "4px 10px",
                borderRadius: "6px",
                backgroundColor: "#eff6ff",
                border: "1px solid #bfdbfe",
                color: "#2563eb",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              🏁 结束并开启 4 步强化 ({capturedGaps.length})
            </button>
          ) : null}
        </div>

        <form className="freetalk-input-bar" onSubmit={handleSendMessage}>
          <textarea
            aria-label="给 Chloe 的消息"
            disabled={loadingMessages || !currentId}
            className="freetalk-textarea"
            rows={2}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void handleSendMessage();
              }
            }}
            placeholder={
              isWaitingForRepetition
                ? `试着复述：“${lastMsg.targetRepetition}”`
                : "用英文随心交流；遇到不会说的词直接换成中文继续说（按 Enter 发送）..."
            }
          />
          <div className="freetalk-actions">
            <button
              type="button"
              className={`mic-btn ${listening ? "is-listening" : ""}`}
              onClick={toggleSpeech}
              disabled={!currentId || loadingMessages}
              title={listening ? "停止语音输入" : "语音输入"}
            >
              {listening ? "🔴 停止" : "🎙️ 听写"}
            </button>
            <button
              type="submit"
              className="primary-button send-btn"
              disabled={busy || loadingMessages || !currentId || !input.trim()}
            >
              发送 (Send)
            </button>
          </div>
        </form>
      </section>

      {/* Right Drawer: Captured Gaps in Conversation */}
      <aside className="freetalk-gaps-drawer">
        <div className="drawer-header">
          <h3>本轮待复盘表达</h3>
          <span className="gap-counter">{capturedGaps.length} 个</span>
        </div>
        <p className="drawer-desc">
          你在对话中因卡壳使用中文或表达不自然的点，会在复盘时独立审核，确认后才能进入训练：
        </p>

        {capturedGaps.length === 0 ? (
          <div className="drawer-empty">
            <p>目前对话尚未触发新表达缺口。</p>
            <small>在交流中如果遇到不会的词，直接用中文表达即可！</small>
          </div>
        ) : (
          <>
            <ul className="drawer-gap-list">
              {capturedGaps.map((gap, idx) => (
                <li key={idx} className="drawer-gap-item">
                  <div className="drawer-gap-intent">{gap.intentZh}</div>
                  <div className="drawer-gap-target" lang="en">
                    {gap.targetEnglish}
                  </div>
                  <small className="drawer-gap-expl">{gap.explanationZh}</small>
                </li>
              ))}
            </ul>
            <div style={{ marginTop: "16px", padding: "8px 0" }}>
              <button
                type="button"
                className="primary-button"
                onClick={startFourStepMastery}
                style={{ width: "100%", justifyContent: "center", padding: "8px 12px", fontWeight: 600 }}
              >
                🚀 开始 4 步强化营 ({capturedGaps.length})
              </button>
            </div>
          </>
        )}
      </aside>

      {/* IELTS Topic Selection Drawer */}
      <IeltsTopicDrawer
        isOpen={isTopicDrawerOpen}
        onClose={() => setIsTopicDrawerOpen(false)}
        onSelectTopic={(topic) => void handleStartTopic(topic)}
      />

    </div>
  );
}
