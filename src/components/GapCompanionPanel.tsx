"use client";

import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";
import type { InteractiveText } from "@/lib/learning/types";
import { InteractiveEnglishText } from "./InteractiveEnglishText";
import styles from "./GapCompanionPanel.module.css";

interface CompanionMessage {
  id: string;
  role: "user" | "teacher" | "system";
  text: string;
  status: "pending" | "sent" | "failed";
  clientMessageId: string;
  interactiveText: InteractiveText;
}

interface CompanionThread {
  id: string;
  title: string;
  messages: CompanionMessage[];
}

interface NewMemory { id: string; category: string; summary: string }

function detectLanguage(text: string): "zh" | "en" | "mixed" {
  const hasZh = /[\u3400-\u9fff]/.test(text);
  const hasEn = /[A-Za-z]/.test(text);
  return hasZh && hasEn ? "mixed" : hasZh ? "zh" : "en";
}

export function GapCompanionPanel({ gapId, onLookup }: { gapId: string; onLookup: (annotationId: string) => void }) {
  const [open, setOpen] = useState(false);
  const [thread, setThread] = useState<CompanionThread | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [newMemories, setNewMemories] = useState<NewMemory[]>([]);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    setOpen(false);
    setThread(null);
    setDraft("");
    setError("");
    setNewMemories([]);
  }, [gapId]);

  useEffect(() => {
    if (!open || thread || busy) return;
    setBusy(true);
    void fetch("/api/companion/threads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scopeType: "gap", scopeId: gapId }),
    }).then(async (response) => {
      const body = (await response.json()) as { thread?: CompanionThread; error?: string };
      if (!response.ok || !body.thread) throw new Error(body.error || "Chloe 暂时没有打开");
      setThread(body.thread);
      requestAnimationFrame(() => composerRef.current?.focus());
    }).catch((reason) => setError(reason instanceof Error ? reason.message : "Chloe 暂时没有打开"))
      .finally(() => setBusy(false));
  }, [busy, gapId, open, thread]);

  useEffect(() => {
    if (open) endRef.current?.scrollIntoView({ block: "end" });
  }, [open, thread?.messages.length]);

  useEffect(() => {
    if (open) {
      wasOpenRef.current = true;
      const frame = requestAnimationFrame(() => {
        if (thread) composerRef.current?.focus();
        else closeRef.current?.focus();
      });
      return () => cancelAnimationFrame(frame);
    }
    if (!wasOpenRef.current) return;
    wasOpenRef.current = false;
    const frame = requestAnimationFrame(() => launcherRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open, thread]);

  async function deliver(payload: { clientMessageId: string; text: string; retry?: boolean }) {
    if (!thread || busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/companion/threads/${encodeURIComponent(thread.id)}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...payload, inputLanguage: detectLanguage(payload.text), messageKind: "text" }),
      });
      const body = (await response.json()) as { thread?: CompanionThread; newMemories?: NewMemory[]; error?: string };
      if (body.thread) setThread(body.thread);
      if (!response.ok) throw new Error(body.error || "消息没有发送成功");
      setNewMemories(body.newMemories ?? []);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "消息没有发送成功");
      const response = await fetch(`/api/companion/threads/${encodeURIComponent(thread.id)}/messages`, { cache: "no-store" });
      const body = (await response.json()) as { thread?: CompanionThread };
      if (body.thread) setThread(body.thread);
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !thread || busy) return;
    setDraft("");
    void deliver({ clientMessageId: crypto.randomUUID(), text });
  }

  async function dismissMemory(id: string) {
    const response = await fetch("/api/companion/memories", {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, status: "dismissed" }),
    });
    if (response.ok) setNewMemories((items) => items.filter((item) => item.id !== id));
  }

  function handlePanelKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      return;
    }
    if (event.key !== "Tab" || !panelRef.current) return;
    const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>(
      'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
    )).filter((element) => element.getAttribute("aria-hidden") !== "true");
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return <>
    <button ref={launcherRef} type="button" className={styles.launcher} aria-label="询问 Chloe 当前表达" aria-expanded={open} aria-controls="gap-chloe-panel" onClick={() => setOpen((value) => !value)}>
      <span className={styles.avatar} aria-hidden="true">C</span>
      <span><strong>问 Chloe</strong><small>当前表达</small></span>
    </button>
    {open ? <button type="button" tabIndex={-1} aria-hidden="true" className={styles.backdrop} onClick={() => setOpen(false)} /> : null}
    <aside ref={panelRef} id="gap-chloe-panel" role="dialog" aria-modal={open ? true : undefined} aria-hidden={!open} className={styles.panel} data-open={open} aria-label="Chloe 学习搭子" onKeyDown={handlePanelKeyDown}>
      <header className={styles.header}>
        <span className={styles.avatar} aria-hidden="true">C</span>
        <div><strong>Chloe</strong><span>AI 美式英语学习搭子</span></div>
        <button ref={closeRef} type="button" className={styles.close} onClick={() => setOpen(false)} aria-label="收起 Chloe">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
        </button>
      </header>
      <div className={styles.messages} aria-live="polite" aria-busy={busy && !thread}>
        {!thread && !error ? <div className={styles.loading}>正在接上这条表达的对话…</div> : null}
        {thread?.messages.map((message) => <article key={message.id} className={styles.message} data-role={message.role} data-status={message.status}>
          <div className={styles.bubble}>
            <InteractiveEnglishText content={message.interactiveText} onLookup={onLookup} />
            {message.status === "pending" ? <small>正在发送…</small> : null}
            {message.status === "failed" ? <button type="button" disabled={busy} onClick={() => void deliver({ clientMessageId: message.clientMessageId, text: message.text, retry: true })}>重试这条消息</button> : null}
          </div>
        </article>)}
        {newMemories.map((memory) => <div key={memory.id} className={styles.memoryNotice} role="status">
          <span>已记住：{memory.summary}</span><button type="button" onClick={() => void dismissMemory(memory.id)}>撤销</button>
        </div>)}
        {error ? <div className={styles.error} role="alert">{error}</div> : null}
        <div ref={endRef} />
      </div>
      <form className={styles.composer} onSubmit={submit}>
        <label htmlFor="gap-chloe-message">问当前表达</label>
        <textarea ref={composerRef} id="gap-chloe-message" rows={2} value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="中文、英文或中英混合都可以" disabled={!thread || busy} onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); }
        }} />
        <div><span>Enter 发送 · Shift + Enter 换行</span><button type="submit" disabled={!thread || busy || !draft.trim()}>发送</button></div>
      </form>
    </aside>
  </>;
}
