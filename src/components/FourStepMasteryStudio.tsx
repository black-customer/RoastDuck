"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { AttemptView } from "@/lib/speaking-practice/service";
import { stepNames, type TrainingView } from "@/lib/four-step/contracts";
import { getTTS } from "@/lib/tts";

export function FourStepMasteryStudio({ attempt, materialId: explicitMaterialId, mode = "learn", onClose }: {
  attempt?: AttemptView; materialId?: string; mode?: "learn" | "review"; onClose: () => void;
}) {
  const materialId = explicitMaterialId ?? attempt?.materialId;
  const [view, setView] = useState<TrainingView | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const pendingRef = useRef<{ signature: string; id: string } | null>(null);
  const mounted = useRef(true);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    mounted.current = true;
    const previous = document.activeElement as HTMLElement | null;
    panelRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); closeRef.current(); }
      if (event.key !== "Tab") return;
      const nodes = [...(panelRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],textarea:not(:disabled),[tabindex="0"]') ?? [])].filter((node) => node.getClientRects().length);
      const first = nodes[0], last = nodes.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", handleKey);
    return () => { mounted.current = false; document.removeEventListener("keydown", handleKey); getTTS().stop(); previous?.focus(); };
  }, []);

  useEffect(() => {
    if (!materialId) { setError("这份历史回答的新材料尚未处理，原回答已保留。"); return; }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function load() {
      setBusy(true);
      try {
        const materialResponse = await fetch(`/api/training/materials/${encodeURIComponent(materialId!)}`, { signal: controller.signal });
        const material = await materialResponse.json();
        if (!materialResponse.ok) throw new Error(material.error || "无法读取材料");
        if (material.status !== "ready") {
          if (material.status === "failed") throw new Error(material.error || "材料处理未通过，请返回回答页查看和重试。");
          timer = setTimeout(() => void load(), 1800);
          return;
        }
        const response = await fetch("/api/training/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ materialId, mode }), signal: controller.signal });
        const body = await response.json();
        if (!response.ok || !body.session) throw new Error(body.error || "暂时无法开始训练");
        if (!controller.signal.aborted) { setView(body.session); setInput(body.session.draft); setError(""); setBusy(false); }
      } catch (reason) {
        if (!controller.signal.aborted) { setError(reason instanceof Error ? reason.message : "读取失败，可重试"); setBusy(false); }
      }
    }
    void load();
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [materialId, mode, reload]);

  useEffect(() => { if (!busy) inputRef.current?.focus(); }, [view?.step, view?.taskIndex, busy]);

  // 刷新时服务器可能仍在判定，轮询读取已保存结果，不能永久锁住输入框。
  useEffect(() => {
    if (!view?.busy || busy) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const id = view.id;
    async function recover() {
      try {
        const response = await fetch(`/api/training/sessions/${encodeURIComponent(id)}`, { signal: controller.signal });
        const body = await response.json();
        if (!response.ok || !body.session) throw new Error(body.error || "恢复判定失败，请重试");
        if (controller.signal.aborted) return;
        setView(body.session);
        setInput(body.session.draft);
        setError("");
        if (body.session.busy) timer = setTimeout(() => void recover(), 1500);
      } catch (reason) {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "恢复失败，原输入仍已保留");
      }
    }
    timer = setTimeout(() => void recover(), 1500);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [view?.id, view?.busy, busy]);

  async function send(type: "submit" | "assist" | "continue" | "recall") {
    if (!view || busy) return;
    const signature = JSON.stringify({ type, input: type === "submit" ? input : "", version: view.stepVersion });
    if (pendingRef.current?.signature !== signature) pendingRef.current = { signature, id: crypto.randomUUID() };
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/training/sessions/${encodeURIComponent(view.id)}/events`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type, input: type === "submit" ? input : undefined, clientEventId: pendingRef.current.id, stepVersion: view.stepVersion }) });
      const body = await response.json();
      if (!response.ok || !body.session) throw new Error(body.error || "判定暂不可用，输入已保留");
      if (mounted.current) { setView(body.session); setInput(body.session.draft); pendingRef.current = null; }
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : "发送失败，输入已保留，请重试");
    } finally { if (mounted.current) setBusy(false); }
  }

  const finished = view?.status === "completed";
  const unnecessary = view?.status === "no_training_required";
  return (
    <div className="mastery-overlay" role="dialog" aria-modal="true" aria-labelledby="four-step-title">
      <div className="mastery-shell" ref={panelRef}>
        <header className="mastery-header">
          <h2 id="four-step-title">四步表达强化</h2>
          <button type="button" className="secondary-button" onClick={onClose}>保存进度并退出</button>
        </header>
        <ol className="mastery-step-nav" aria-label="固定训练顺序">
          {stepNames.map((name, i) => <li key={name} className={view?.step === i + 1 ? "mastery-step-tab active" : "mastery-step-tab"} aria-current={view?.step === i + 1 ? "step" : undefined}>{i + 1}. {name}</li>)}
        </ol>
        <div className="mastery-canvas">
          {error && <div role="alert"><p>{error}</p><button className="secondary-button" onClick={() => view ? void send("submit") : setReload((n) => n + 1)} disabled={busy || !materialId || Boolean(view && !input.trim())}>重试</button><button className="secondary-button" disabled={busy} onClick={() => setReload((n) => n + 1)}>恢复服务端进度</button></div>}
          {!view && !error && <p role="status">正在准备已审核材料，原回答已保存…</p>}
          {view && (finished || unnecessary) ? <section>
            <h3>{unnecessary ? "本次无需强化" : "本轮强化已完成"}</h3>
            <p>{unnecessary ? "没有确认的必练表达，可以继续回答。" : "这代表完成了一轮练习，还不等于无提示或跨日掌握。请在新的回答中验证。"} </p>
            {view.questionId && <Link className="primary-button" href={`/questions/${encodeURIComponent(view.questionId)}/practice`}>开始新的独立回答</Link>}
            <button className="secondary-button" onClick={onClose}>返回本次材料</button>
          </section> : view && <section aria-busy={busy || view.busy}>
            <p>第 {view.taskIndex + 1} / {view.taskCount} 项</p>
            <h3>{view.promptZh}</h3>
            {view.before !== undefined && <p className="target-sentence-text" lang="en">{view.before}<strong aria-label="需要补全的表达"> [ ____ ] </strong>{view.after}</p>}
            <label htmlFor="four-step-input">你的英文表达</label>
            <textarea ref={inputRef} id="four-step-input" className="mastery-textarea" rows={view.step === 4 ? 6 : 3} maxLength={8000} value={input} onChange={(e) => setInput(e.target.value)} disabled={busy || view.busy || view.passed} aria-describedby="four-step-input-help" />
            <p id="four-step-input-help">可以打字，也可按 Win + H 或使用输入法麦克风。这里不会自动申请录音权限。</p>
            {view.hint && <p role="status">{view.hint}</p>}
            {view.answer && <div><p lang="en">{view.answer}</p><button className="secondary-button" onClick={() => getTTS().speak(view.answer!)}>试听表达</button></div>}
            {view.feedback && <p role="status">{view.feedback.feedbackZh}</p>}
            {view.passed ? <button className="primary-button" disabled={busy || view.busy} onClick={() => void send("continue")}>{view.step === 4 ? "完成本轮强化" : "继续"}</button> : <div className="input-action-row">
              {view.hint || view.answer ? <button className="primary-button" disabled={busy} onClick={() => void send("recall")}>遮住提示，再次提取</button> : <button className="primary-button" disabled={busy || view.busy || !input.trim()} onClick={() => void send("submit")}>{busy ? "正在判定…" : "检查表达"}</button>}
              <button className="secondary-button" disabled={busy || view.busy} onClick={() => void send("assist")}>不会／给我一点提示</button>
            </div>}
          </section>}
        </div>
      </div>
    </div>
  );
}
