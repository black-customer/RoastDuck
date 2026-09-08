"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type {
  ComprehensionRating,
  LearningSessionView,
  PracticeStep,
  TranscriptReplayStep,
} from "@/lib/learning/types";
import { getTTS } from "@/lib/tts";
import { ContextPanel } from "./ContextPanel";
import { InteractiveEnglishText } from "./InteractiveEnglishText";
import { LookupCard } from "./LookupCard";
import { ShadowingRecorder } from "./ShadowingRecorder";
import { SpeakButton } from "./SpeakButton";
import { GapRetrievalStage, isGapRetrievalStep } from "./GapRetrievalStage";
import { GapCompanionPanel } from "./GapCompanionPanel";

type BlindAudioStatus = "idle" | "loading" | "playing" | "blocked" | "failed";

const CHLOE_REVEALED_STEPS = new Set([
  "comparison",
  "adaptive_instruction",
  "repair_instruction",
  "outcome",
  "scheduled",
]);

function AudioGlyph({ playing = false }: { playing?: boolean }) {
  return playing ? (
    <span className="audio-wave" aria-hidden="true"><i /><i /><i /><i /></span>
  ) : (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" className="h-7 w-7">
      <path d="M5 9.5v5h3.1l4.4 3.5V6L8.1 9.5H5Z" fill="currentColor" />
      <path d="M15.5 9a4.2 4.2 0 0 1 0 6M18 6.8a7.3 7.3 0 0 1 0 10.4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function ContextConversation({
  context,
  onLookup,
  highlightSurface,
}: {
  context: TranscriptReplayStep["context"];
  onLookup: (id: string) => void;
  highlightSurface?: string;
}) {
  return (
    <div className="context-conversation">
      <div className="context-scene-meta">
        <p>{context.settingZh}</p>
        <span>{context.relationshipZh}</span>
        <span>{context.purposeZh}</span>
      </div>
      <ol className="context-lines" aria-label="语境文本">
        {context.lines.map((line) => (
          <li key={line.id} className={line.target ? "context-line context-line-target" : "context-line"}>
            <div className="context-speaker-row">
              <span>{line.speaker}</span>
              {line.target ? <small>目标表达所在句</small> : null}
            </div>
            <InteractiveEnglishText
              content={line.text}
              onLookup={onLookup}
              highlightSurface={line.target ? highlightSurface : undefined}
              className="context-line-english"
            />
            <p className="context-line-translation">{line.translationZh}</p>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function LearningSession({
  mode,
  questionId,
}: {
  mode: "learn" | "review";
  questionId?: string;
}) {
  const router = useRouter();
  const [view, setView] = useState<LearningSessionView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [lookupId, setLookupId] = useState<string | null>(null);
  const [contextOpen, setContextOpen] = useState(false);
  const [breakdownOpen, setBreakdownOpen] = useState(false);
  const [selectedTiles, setSelectedTiles] = useState<Array<{ id: string; label: string }>>([]);
  const [blindAudioStatus, setBlindAudioStatus] = useState<BlindAudioStatus>("idle");
  const stageHeadingRef = useRef<HTMLHeadingElement>(null);
  const blindAudioRef = useRef<HTMLAudioElement | null>(null);
  const autoPlayedRef = useRef("");
  const requestInFlightRef = useRef(false);
  const failedEventRef = useRef<Record<string, unknown> | null>(null);

  const stopBlindAudio = useCallback(() => {
    const audio = blindAudioRef.current;
    if (audio) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    }
    blindAudioRef.current = null;
  }, []);

  const initialize = useCallback(async (restart = false) => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/learning/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode,
          restart,
          scope: questionId ? "question" : "daily",
          ...(questionId ? { questionId } : {}),
        }),
        cache: "no-store",
      });
      const body = (await response.json()) as LearningSessionView & { error?: string };
      if (!response.ok) throw new Error(body.error || "学习会话加载失败");
      setView(body);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "学习会话加载失败");
    } finally {
      setLoading(false);
    }
  }, [mode, questionId]);

  const abandon = useCallback(async () => {
    if (!view?.id || requestInFlightRef.current) {
      router.push("/");
      return;
    }
    requestInFlightRef.current = true;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/learning/sessions/${encodeURIComponent(view.id)}`, { method: "DELETE" });
      if (!response.ok) {
        const body = (await response.json()) as { error?: string };
        throw new Error(body.error || "本组没有成功放弃");
      }
      router.push("/");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "本组没有成功放弃，请重试");
    } finally {
      requestInFlightRef.current = false;
      setBusy(false);
    }
  }, [router, view?.id]);

  useEffect(() => {
    void initialize();
    return () => {
      getTTS().stop();
      stopBlindAudio();
    };
  }, [initialize, stopBlindAudio]);

  const step = view?.step;
  useEffect(() => {
    setContextOpen(false);
    setBreakdownOpen(false);
    setSelectedTiles([]);
    setBlindAudioStatus("idle");
    stopBlindAudio();
    const retrievalInputStep = step && ["retrieval_prompt", "review_prompt", "active_recall", "transfer_recall", "repair_recall", "transfer_retry"].includes(step.type);
    // V3 的主要动作就是立即提取英文；输入步骤由 composer 聚焦文本框，其余步骤仍聚焦标题以播报状态变化。
    if (step && !retrievalInputStep) requestAnimationFrame(() => stageHeadingRef.current?.focus());
  }, [step, stopBlindAudio]);

  const persistEvent = useCallback(async (event: Record<string, unknown>) => {
    if (!view?.id || requestInFlightRef.current) return null;
    requestInFlightRef.current = true;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/learning/sessions/${encodeURIComponent(view.id)}/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(event),
      });
      const body = (await response.json()) as LearningSessionView & { error?: string };
      if (!response.ok) throw new Error(body.error || "这一步没有保存成功");
      failedEventRef.current = null;
      setView(body);
      return body;
    } catch (reason) {
      failedEventRef.current = event;
      setError(reason instanceof Error ? reason.message : "这一步没有保存成功，请重试");
      return null;
    } finally {
      requestInFlightRef.current = false;
      setBusy(false);
    }
  }, [view?.id]);

  const sendEvent = useCallback((event: Record<string, unknown>) => {
    const stepVersion = view?.step && "stepVersion" in view.step ? view.step.stepVersion : undefined;
    return persistEvent({ ...event, ...(stepVersion ? { stepVersion } : {}), clientEventId: crypto.randomUUID() });
  }, [persistEvent, view?.step]);

  const playBlindAudio = useCallback(async () => {
    if (step?.type !== "context_audio_input" || busy) return;
    stopBlindAudio();
    setBlindAudioStatus("loading");
    const audio = new Audio(step.audioUrl);
    blindAudioRef.current = audio;
    audio.preload = "auto";
    audio.addEventListener("playing", () => setBlindAudioStatus("playing"), { once: true });
    audio.addEventListener("ended", () => {
      blindAudioRef.current = null;
      setBlindAudioStatus("idle");
      void sendEvent({ type: "mark_audio_heard", playback: "played" });
    }, { once: true });
    audio.addEventListener("error", () => {
      blindAudioRef.current = null;
      setBlindAudioStatus("failed");
    }, { once: true });
    try {
      await audio.play();
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === "NotAllowedError") setBlindAudioStatus("blocked");
      else setBlindAudioStatus("failed");
    }
  }, [busy, sendEvent, step, stopBlindAudio]);

  useEffect(() => {
    if (step?.type !== "context_audio_input" || !step.autoPlay) return;
    const key = `${step.sessionId}|${step.stepVersion}`;
    if (autoPlayedRef.current === key) return;
    autoPlayedRef.current = key;
    const timer = window.setTimeout(() => void playBlindAudio(), 260);
    return () => window.clearTimeout(timer);
  }, [playBlindAudio, step]);

  const replayVisibleContext = useCallback((contextStep: TranscriptReplayStep, rate = 0.95) => {
    getTTS().stop();
    stopBlindAudio();
    const audio = new Audio(contextStep.audioUrl);
    blindAudioRef.current = audio;
    audio.playbackRate = rate;
    audio.addEventListener("ended", () => {
      if (blindAudioRef.current === audio) blindAudioRef.current = null;
    }, { once: true });
    audio.addEventListener("error", () => {
      if (blindAudioRef.current === audio) blindAudioRef.current = null;
      getTTS().speak(contextStep.context.lines.map((line) => line.text.text).join(". "), { lang: contextStep.context.accent, rate });
    }, { once: true });
    void audio.play().catch(() => {
      if (blindAudioRef.current === audio) blindAudioRef.current = null;
      getTTS().speak(contextStep.context.lines.map((line) => line.text.text).join(". "), { lang: contextStep.context.accent, rate });
    });
  }, [stopBlindAudio]);

  const rateComprehension = useCallback((rating: ComprehensionRating) => {
    void sendEvent({ type: "rate_comprehension", rating });
  }, [sendEvent]);

  const submitPractice = useCallback(async (practice: PracticeStep["practice"], answer: string) => {
    const next = await sendEvent({ type: "submit_practice", practiceId: practice.id, answer });
    if (next?.step.type === "guided_practice") setSelectedTiles([]);
  }, [sendEvent]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("button, a, input, textarea, select, [contenteditable='true']") || busy) return;
      if (step?.type === "comprehension_rating" && ["1", "2", "3"].includes(event.key)) {
        const ratings: ComprehensionRating[] = ["understood", "unsure", "not_understood"];
        rateComprehension(ratings[Number(event.key) - 1]);
        return;
      }
      if (step?.type === "guided_practice") {
        const number = Number(event.key) - 1;
        if (Number.isInteger(number) && number >= 0) {
          const option = step.practice.options[number];
          if (option) {
            event.preventDefault();
            void submitPractice(step.practice, option.id);
            return;
          }
          const tile = step.practice.tiles[number];
          if (tile && !selectedTiles.some((item) => item.id === tile.id)) {
            event.preventDefault();
            setSelectedTiles((items) => [...items, tile]);
            return;
          }
        }
        if (event.key === "Backspace" && selectedTiles.length) {
          event.preventDefault();
          setSelectedTiles((items) => items.slice(0, -1));
          return;
        }
        if (event.key === "Enter" && selectedTiles.length) {
          event.preventDefault();
          void submitPractice(step.practice, selectedTiles.map((tile) => tile.label).join(" "));
          return;
        }
      }
      if (event.code === "Space" && step?.type === "transcript_replay") {
        event.preventDefault();
        replayVisibleContext(step);
      }
      if (event.code === "Space" && step?.type === "shadowing") {
        event.preventDefault();
        getTTS().speak(step.targetLine.text.text, { lang: step.accent });
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [busy, rateComprehension, replayVisibleContext, selectedTiles, step, submitPractice]);

  const progress = step && "total" in step && "current" in step && step.total > 0
    ? Math.max(4, Math.min(100, ((step.current - 1) / step.total) * 100))
    : 100;
  const activeGapId = view?.experienceVersion === "gap_retrieval_v3"
    && step
    && CHLOE_REVEALED_STEPS.has(step.type)
    && "gapId" in step
    && typeof step.gapId === "string"
    ? step.gapId
    : null;

  if (loading) {
    return (
      <div className="learning-shell" aria-busy="true">
        <div className="learning-frame">
          <div className="h-10 w-full animate-pulse rounded-xl bg-[var(--primary-soft)]" />
          <div className="mt-24 h-52 animate-pulse rounded-2xl bg-white" />
          <p className="mt-6 text-center text-sm text-[var(--muted)]">正在恢复今天的学习位置…</p>
        </div>
      </div>
    );
  }

  if (!view || !step) {
    return (
      <div className="learning-shell">
        <div className="learning-frame flex min-h-dvh items-center justify-center">
          <div className="max-w-sm text-center">
            <h1 className="text-2xl font-semibold">学习会话没有打开</h1>
            <p className="mt-3 leading-7 text-[var(--muted)]">{error || "请重新加载；如果仍然失败，运行内容审计检查可发布内容。"}</p>
            <button type="button" className="primary-button mt-6 w-full" onClick={() => void initialize()}>重新加载</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="learning-shell">
      <div className="learning-frame">
        <header className="learning-header">
          <button type="button" className="exit-button" onClick={() => router.push("/")} aria-label="退出学习，返回首页">
            <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden="true"><path d="m15 6-6 6 6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
            退出
          </button>
          <div className="min-w-0 flex-1 px-4" role="progressbar" aria-label="本组学习进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress)}>
            <div className="progress-track"><div className="progress-value" style={{ transform: `scaleX(${progress / 100})` }} /></div>
          </div>
          <span className="whitespace-nowrap text-sm font-medium text-[var(--muted-strong)] tabular-nums">{"current" in step ? `${step.current} / ${step.total}` : "完成"}</span>
          {view.id && step.type !== "complete" ? (
            <details className="session-menu">
              <summary aria-label="学习会话选项"><svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5" aria-hidden="true"><circle cx="5" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="19" cy="12" r="1.7" /></svg></summary>
              <div><button type="button" disabled={busy} onClick={() => void initialize(true)}>重新开始本组</button><button type="button" disabled={busy} onClick={() => void abandon()}>放弃本组并返回首页</button></div>
            </details>
          ) : null}
        </header>

        {error ? (
          <div className="error-banner" role="alert"><span>{error}</span><button type="button" disabled={busy} onClick={() => {
            const failed = failedEventRef.current;
            if (failed) void persistEvent(failed);
            else void initialize();
          }}>重试</button></div>
        ) : null}

        <div className="learning-stage">
          {isGapRetrievalStep(step) ? <GapRetrievalStage step={step} busy={busy} headingRef={stageHeadingRef} onEvent={sendEvent} /> : null}
          {step.type === "context_audio_input" ? (
            <section className="stage-content stage-enter" aria-labelledby="context-audio-title">
              <div className="stage-copy">
                <h1 ref={stageHeadingRef} tabIndex={-1} id="context-audio-title" className="stage-title">先别看原文，只听场景</h1>
                <p className="stage-description">像真实交流一样先捕捉人物关系、意图和大意。播放结束后，再判断自己听懂了多少。</p>
              </div>
              <div className="blind-audio-stage" data-audio-status={blindAudioStatus}>
                <span className="blind-audio-orbit" aria-hidden="true" />
                <button type="button" className="blind-audio-button" aria-label={blindAudioStatus === "playing" ? "语境正在播放" : "播放语境音频"} disabled={busy || blindAudioStatus === "loading" || blindAudioStatus === "playing"} onClick={() => void playBlindAudio()}>
                  <AudioGlyph playing={blindAudioStatus === "playing" || blindAudioStatus === "loading"} />
                </button>
                <div className="blind-audio-copy" aria-live="polite">
                  <strong>{blindAudioStatus === "playing" ? "正在播放语境" : blindAudioStatus === "loading" ? "正在准备自然语音" : blindAudioStatus === "blocked" ? "浏览器等待你的点击" : blindAudioStatus === "failed" ? "语音暂时不可用" : "播放后开始判断"}</strong>
                  <span>{blindAudioStatus === "failed" ? "可以重试，或暂时以文本模式继续本轮。" : "首次播放不会显示英文或中文。"}</span>
                </div>
                {blindAudioStatus === "failed" ? <div className="blind-audio-fallback" role="status"><button type="button" className="secondary-button" disabled={busy} onClick={() => void playBlindAudio()}>重试音频</button><button type="button" className="text-button" disabled={busy} onClick={() => void sendEvent({ type: "mark_audio_heard", playback: "unavailable" })}>以文本降级继续</button></div> : null}
              </div>
              <p className="blind-privacy-note">本阶段的文本不会提前发送到页面；默认使用自然美式英语语音。</p>
            </section>
          ) : null}

          {step.type === "comprehension_rating" ? (
            <section className="stage-content stage-enter" aria-labelledby="comprehension-title">
              <div className="stage-copy"><h1 ref={stageHeadingRef} tabIndex={-1} id="comprehension-title" className="stage-title">刚才的场景，你听懂了吗？</h1><p className="stage-description">按真实感受选择。三个选项都会进入同一个文本回放页，只会改变后面的辅助与练习深度。</p></div>
              {step.playback === "unavailable" ? <div className="audio-degraded-note">本轮音频未成功播放，选择后会直接展示文本，不影响后续学习。</div> : null}
              <div className="comprehension-grid" aria-label="选择理解程度">{step.comprehensionOptions.map((option, index) => <button key={option.value} type="button" className="comprehension-option" data-level={option.value} disabled={busy} onClick={() => rateComprehension(option.value)} aria-keyshortcuts={String(index + 1)}><span>{option.label}</span><kbd>{index + 1}</kbd></button>)}</div>
            </section>
          ) : null}

          {step.type === "transcript_replay" ? (
            <section className="stage-content stage-enter" aria-labelledby="transcript-title">
              <div className="stage-copy"><h1 ref={stageHeadingRef} tabIndex={-1} id="transcript-title" className="stage-title">现在带着文本再听一遍</h1><p className="stage-description">先把整个语境听明白。此时还不标出主 Chunk；任意英文都可以点开查询，查询本身不会自动记录为难点。</p></div>
              <div className="context-replay-toolbar"><button type="button" className="secondary-button" onClick={() => replayVisibleContext(step)}><AudioGlyph />完整重播 <kbd>Space</kbd></button>{step.support.slowReplay ? <button type="button" className="text-button" disabled={busy} onClick={() => { void sendEvent({ type: "request_assist", assist: "slow_replay" }); replayVisibleContext(step, 0.72); }}>0.72× 慢速重播</button> : null}</div>
              <ContextConversation context={step.context} onLookup={setLookupId} />
              <button type="button" className="primary-button mt-5 w-full" disabled={busy} onClick={() => void sendEvent({ type: "continue_to_chunk" })}>看看这轮要学的表达</button>
            </section>
          ) : null}

          {step.type === "chunk_reveal" ? (
            <section className="stage-content stage-enter" aria-labelledby="chunk-title">
              <div className="stage-copy"><h1 ref={stageHeadingRef} tabIndex={-1} id="chunk-title" className="stage-title">把核心表达查明白</h1><p className="stage-description">回到刚才的真实语境，只正式学习一个表达；其他英文仍可按需查询。</p></div>
              <ContextConversation context={step.context} onLookup={setLookupId} highlightSurface={step.chunk.display} />
              <div className="chunk-reveal">
                <div className="flex items-start justify-between gap-5"><div className="min-w-0"><h2 className="break-words text-3xl font-semibold tracking-[-.025em] sm:text-4xl" lang="en">{step.chunk.display}</h2><p className="mt-2 text-sm font-medium text-[var(--muted-strong)]" lang="en">{step.chunk.ipa ? `/${step.chunk.ipa.replace(/^\/+|\/+$/g, "")}/` : "音标待内容审核"} · {step.chunk.accent}</p></div><SpeakButton text={step.chunk.display} lang={step.context.accent} size="lg" /></div>
                <p className="mt-6 text-xl font-semibold leading-8 text-[var(--primary-strong)]">{step.chunk.meaningZh}</p>
                {step.chunk.englishGloss ? <p className="mt-3 leading-7 text-[var(--muted-strong)]" lang="en">{step.chunk.englishGloss}</p> : null}
                {step.chunk.pattern ? <div className="mt-5 border-t border-[var(--border)] pt-4"><p className="text-xs font-semibold text-[var(--muted)]">Pattern</p><p className="mt-1 font-medium" lang="en">{step.chunk.pattern}</p></div> : null}
              </div>
              <div className="example-block"><div className="flex items-center justify-between gap-3"><span className="status-chip">{step.example.generated ? "生成例句" : "真实原句"}</span><button type="button" className="text-button" onClick={() => setContextOpen((value) => !value)}>{contextOpen ? "收起来源" : "查看来源"}</button></div><InteractiveEnglishText content={step.example} onLookup={setLookupId} highlightSurface={step.chunk.display} className="mt-4 text-lg leading-8" /><p className="mt-2 leading-7 text-[var(--muted)]">{step.example.translationZh}</p></div>
              {contextOpen ? <ContextPanel contextId={step.example.contextId} onLookup={setLookupId} onClose={() => setContextOpen(false)} /> : null}
              {step.support.automaticNote ? <div className="note-confirmation" role="status"><span>你已开启自动收集；这条表达已加入“我的雅思答案”的待学表达。</span></div> : null}
              <div className="support-actions">{step.support.breakdown ? <button type="button" className="secondary-button" disabled={busy || breakdownOpen} onClick={() => { setBreakdownOpen(true); void sendEvent({ type: "request_assist", assist: "breakdown" }); }}>拆分看一遍</button> : null}</div>
              {breakdownOpen ? <div className="breakdown-row" lang="en">{step.chunk.display.split(/\s+/).map((word, index) => <span key={`${word}-${index}`}>{word}</span>)}</div> : null}
              <button type="button" className="primary-button mt-3 w-full" disabled={busy} onClick={() => void sendEvent({ type: "continue_to_shadowing" })}>去模仿目标句</button>
            </section>
          ) : null}

          {step.type === "shadowing" ? (
            <section className="stage-content stage-enter" aria-labelledby="shadowing-title">
              <div className="stage-copy"><h1 ref={stageHeadingRef} tabIndex={-1} id="shadowing-title" className="stage-title">听一遍，再照着说</h1><p className="stage-description">录音只留在当前页面内存中。回放对比，不满意就再来一次。</p></div>
              <div className="shadowing-sentence"><div><span className="context-speaker-label">{step.targetLine.speaker}</span><InteractiveEnglishText content={step.targetLine.text} onLookup={setLookupId} className="block text-xl leading-9 sm:text-2xl" /></div></div>
              <ShadowingRecorder sentence={step.targetLine.text.text} accent={step.accent} disabled={busy} onComplete={(result) => void sendEvent({ type: "complete_shadowing", ...result })} />
            </section>
          ) : null}

          {step.type === "contextual_recall" ? (
            <section className="stage-content stage-enter" aria-labelledby="recall-title">
              <div className="stage-copy"><h1 ref={stageHeadingRef} tabIndex={-1} id="recall-title" className="stage-title">不看原文，把它自己说出来</h1><p className="stage-description">不要求逐字背诵；请在相同语境里自然表达刚才的意思。</p></div>
              <div className="recall-scene"><span>具体语境</span><h2>{step.scene.settingZh}</h2><dl><div><dt>你和谁说</dt><dd>{step.scene.relationshipZh}</dd></div><div><dt>你为什么说</dt><dd>{step.scene.purposeZh}</dd></div></dl><blockquote>{step.scene.promptZh}</blockquote><p><strong>要表达的意思：</strong>{step.scene.targetMeaningZh}</p></div>
              <ShadowingRecorder sentence="" accent={step.accent} disabled={busy} showSourcePlayback={false} completeLabel="完成回忆，进入练习" fallbackCompleteLabel="我已自行说过，进入练习" onComplete={(result) => void sendEvent({ type: "complete_contextual_recall", ...result })} />
            </section>
          ) : null}

          {step.type === "guided_practice" ? (
            <section className="stage-content stage-enter" aria-labelledby="practice-title">
              <div className="stage-copy"><h1 ref={stageHeadingRef} tabIndex={-1} id="practice-title" className="stage-title">把表达从记忆里提取出来</h1><p className="stage-description">练习 {step.practiceNumber} / {step.practiceTotal}。答错不会跳过，做对当前题后才继续。</p></div>
              <div className="practice-block">
                <div><p className="text-sm font-semibold text-[var(--primary-strong)]">{step.practice.title}</p><p className="mt-1 text-sm leading-6 text-[var(--muted)]">{step.practice.instruction}</p></div>
                {step.practice.prompt ? <InteractiveEnglishText content={step.practice.prompt} onLookup={setLookupId} className="practice-prompt" /> : null}
                {step.practice.promptZh ? <p className="practice-prompt-zh">{step.practice.promptZh}</p> : null}
                {step.practice.audioText ? <SpeakButton text={step.practice.audioText} size="lg" /> : null}
                {step.practice.options.length ? <div className="space-y-3">{step.practice.options.map((option, index) => <button type="button" className="practice-option" key={option.id} disabled={busy} onClick={() => void submitPractice(step.practice, option.id)}><kbd>{index + 1}</kbd><span>{option.label}</span></button>)}</div> : null}
                {step.practice.tiles.length ? <div className="space-y-4"><div className="tile-answer" aria-label="已选择的英文词块">{selectedTiles.length ? selectedTiles.map((tile) => <button type="button" key={tile.id} onClick={() => setSelectedTiles((items) => items.filter((item) => item.id !== tile.id))}>{tile.label}</button>) : <span>按顺序点击下方词块</span>}</div><div className="tile-bank">{step.practice.tiles.map((tile) => { const selected = selectedTiles.some((item) => item.id === tile.id); return <button type="button" key={tile.id} disabled={selected || busy} onClick={() => setSelectedTiles((items) => [...items, tile])}>{tile.label}</button>; })}</div><button type="button" className="primary-button w-full" disabled={busy || selectedTiles.length === 0} onClick={() => void submitPractice(step.practice, selectedTiles.map((tile) => tile.label).join(" "))}>检查答案</button></div> : null}
                {step.practice.feedback ? <div className="practice-feedback" role="alert"><strong>再试一次</strong><p>{step.practice.feedback.message}</p>{step.practice.feedback.expectedHint ? <p className="mt-1 text-sm">提示：{step.practice.feedback.expectedHint}</p> : null}</div> : null}
              </div>
            </section>
          ) : null}

          {step.type === "outcome" ? (
            <section className="stage-content stage-enter outcome-stage" aria-labelledby="outcome-title">
              <div className="outcome-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" className="h-9 w-9"><path d="m6.5 12.5 3.5 3.5 7.5-8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg></div>
              <h1 ref={stageHeadingRef} tabIndex={-1} id="outcome-title" className="stage-title text-center">{step.result.label}</h1><p className="mx-auto max-w-md text-center leading-7 text-[var(--muted)]">{step.result.message}</p>
              {step.result.retrievalSummary ? <dl className="outcome-details"><div><dt>迁移使用</dt><dd>{step.result.retrievalSummary.transferPassed ? "通过" : "待加强"}</dd></div><div><dt>提示层级</dt><dd>{step.result.retrievalSummary.assistanceLevel}</dd></div><div><dt>独立提取</dt><dd>{step.result.retrievalSummary.independent ? "是" : "尚未"}</dd></div></dl> : <dl className="outcome-details"><div><dt>当场重试</dt><dd>{step.result.errors}</dd></div><div><dt>辅助次数</dt><dd>{step.result.assists}</dd></div><div><dt>模仿次数</dt><dd>{step.result.shadowingAttempts}</dd></div></dl>}
              <button type="button" className="primary-button w-full" disabled={busy} onClick={() => void sendEvent({ type: "continue_outcome" })}>保存复习安排</button>
            </section>
          ) : null}

          {step.type === "scheduled" ? (
            <section className="stage-content stage-enter outcome-stage" aria-labelledby="scheduled-title">
              <div className="schedule-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" className="h-8 w-8"><path d="M7 3v3m10-3v3M4.5 9h15M6 5h12a2 2 0 0 1 2 2v12H4V7a2 2 0 0 1 2-2Z" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg></div>
              <h1 ref={stageHeadingRef} tabIndex={-1} id="scheduled-title" className="stage-title text-center">不是学完一次，而是安排到会</h1><p className="mx-auto max-w-md text-center leading-7 text-[var(--muted)]">系统已根据本轮的理解、辅助、重试和模仿表现安排下一次出现。</p>
              <button type="button" className="primary-button w-full" disabled={busy} onClick={() => void sendEvent({ type: "continue_scheduled" })}>{step.nextAction === "next_item" ? (view.experienceVersion === "gap_retrieval_v3" ? "继续下一个 Gap" : "继续下一个语境") : "完成这一组"}</button>
            </section>
          ) : null}

          {step.type === "complete" ? (
            <section className="stage-content outcome-stage" aria-labelledby="complete-title">
              <div className="outcome-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" className="h-9 w-9"><path d="m6.5 12.5 3.5 3.5 7.5-8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg></div>
              <h1 ref={stageHeadingRef} tabIndex={-1} id="complete-title" className="stage-title text-center">{step.total ? "今天这一组完成了" : "当前没有可学习内容"}</h1><p className="mx-auto max-w-md text-center leading-7 text-[var(--muted)]">{step.total ? `完成 ${step.completed} 个完整学习轮。复习时间已经保存。` : step.message}</p>
              {step.total && view.experienceVersion === "gap_retrieval_v3" && questionId ? <><button type="button" className="primary-button w-full" onClick={() => router.push(`/speaking-arena?question=${encodeURIComponent(questionId)}`)}>重新回答这道题</button><button type="button" className="text-button" onClick={() => router.push("/")}>暂时不答，返回首页</button></> : <button type="button" className="primary-button w-full" onClick={() => router.push("/")}>返回首页</button>}{!step.total ? <p className="text-center text-sm text-[var(--muted)]">未通过独立审核或缺少完整语境的内容不会进入学习队列。</p> : null}
            </section>
          ) : null}
        </div>
      </div>
      {activeGapId ? <GapCompanionPanel gapId={activeGapId} onLookup={setLookupId} /> : null}
      <LookupCard annotationId={lookupId} onClose={() => setLookupId(null)} />
    </div>
  );
}
