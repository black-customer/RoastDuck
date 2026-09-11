"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import type { PersonalAnswerView } from "@/lib/answers/service";

const statusLabel: Record<string, string> = {
  draft: "原文已保存",
  queued: "等待 AI 处理",
  processing: "正在生成",
  ready: "英文版本可编辑",
  needs_attention: "需要处理",
  failed: "处理失败",
  superseded: "原始记录已归档（切分修复）",
};

export function AnswerWorkspace({ initialAnswer }: { initialAnswer: PersonalAnswerView }) {
  const [answer, setAnswer] = useState(initialAnswer);
  const current = useMemo(() => answer.versions.find((version) => version.id === answer.currentVersionId) ?? answer.versions[0], [answer]);
  const [draft, setDraft] = useState(current?.textEn ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [editorReady, setEditorReady] = useState(false);
  const autoProcessStarted = useRef(false);
  const draftDirty = useRef(false);

  useEffect(() => { if (!draftDirty.current) setDraft(current?.textEn ?? ""); }, [current?.id, current?.textEn]);
  // The server-rendered textarea must not accept input before React has attached
  // its change handler; hydration could otherwise restore the old value mid-edit.
  useEffect(() => { setEditorReady(true); }, []);
  useEffect(() => {
    if (answer.status === "superseded") return;
    if (!["queued", "processing"].includes(answer.status) && !["queued", "generating", "reviewing", "applying"].includes(answer.job?.status ?? "")) return;
    const timer = window.setInterval(async () => {
      const response = await fetch(`/api/answers/${encodeURIComponent(answer.id)}`, { cache: "no-store" });
      const body = (await response.json()) as { answer?: PersonalAnswerView };
      if (response.ok && body.answer) setAnswer(body.answer);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [answer.id, answer.job?.status, answer.status]);

  useEffect(() => {
    if (autoProcessStarted.current || answer.status !== "queued" || answer.job?.status !== "queued") return;
    autoProcessStarted.current = true;
    const clientRequestId = crypto.randomUUID();
    void (async () => {
      try {
        const response = await fetch(`/api/answers/${encodeURIComponent(answer.id)}/process`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ clientRequestId, force: false }),
        });
        const body = (await response.json()) as { answer?: PersonalAnswerView; error?: string };
        if (!response.ok || !body.answer) throw new Error(body.error || "AI 处理失败");
        setAnswer(body.answer);
        if (body.answer.status === "ready") setMessage("个人英文版本和学习材料已经生成，并完成独立自动审核。" );
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "AI 处理失败");
        const refreshed = await fetch(`/api/answers/${encodeURIComponent(answer.id)}`, { cache: "no-store" }).catch(() => null);
        if (refreshed?.ok) {
          const body = (await refreshed.json()) as { answer?: PersonalAnswerView };
          if (body.answer) setAnswer(body.answer);
        }
      }
    })();
  }, [answer.id, answer.job?.status, answer.status]);

  async function saveVersion() {
    if (!draft.trim() || !current) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const response = await fetch(`/api/answers/${encodeURIComponent(answer.id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ textEn: draft, baseVersionNo: answer.versions[0].versionNo }) });
      const body = (await response.json()) as { answer?: PersonalAnswerView; error?: string };
      if (!response.ok || !body.answer) throw new Error(body.error || "版本保存失败");
      draftDirty.current = false;
      setAnswer(body.answer); setMessage("已保存为新版本，原始回答仍完整保留。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "版本保存失败"); }
    finally { setBusy(false); }
  }

  async function retry() {
    setBusy(true); setError(""); setMessage("");
    try {
      const response = await fetch(`/api/answers/${encodeURIComponent(answer.id)}/process`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientRequestId: crypto.randomUUID(), force: true }) });
      const body = (await response.json()) as { answer?: PersonalAnswerView; error?: string };
      if (!response.ok || !body.answer) throw new Error(body.error || "重新处理失败");
      setAnswer(body.answer); setMessage(body.answer.status === 'ready' ? "重新处理完成，原文已保留。" : "已重新加入处理队列。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "重新处理失败"); }
    finally { setBusy(false); }
  }

  return (
    <div className="studio-shell"><div className="studio-frame">
      <header className="studio-header"><Link href={`/questions/${encodeURIComponent(answer.questionId)}`} className="exit-button">← 返回题目</Link><span>{statusLabel[answer.status] || answer.status}</span></header>
      {error ? <div className="error-banner" role="alert"><span>{error}</span><button type="button" onClick={() => setError("")}>关闭</button></div> : null}
      {message ? <div className="success-banner" role="status">{message}</div> : null}
      {answer.recovery ? <section className="page-panel"><h2>这份原始记录已完成切分修复</h2><p>原文和所有旧版本完整保留，只读归档。请从修复后的回答继续学习。</p><ul>{answer.recovery.replacements.map((replacement, index) => <li key={replacement.id}><Link href={`/answer-studio/${encodeURIComponent(replacement.id)}`}>查看修复后的回答 {index + 1}</Link></li>)}</ul></section> : null}
      <section className="workspace-question"><h1 lang={answer.question.textEn ? "en" : "zh-CN"}>{answer.question.textEn || "历史回答 · 原始问句缺失"}</h1><p>{answer.question.textZh}</p></section>
      <div className="workspace-grid">
        <section className="workspace-card workspace-original"><div className="workspace-card-title"><div><h2>你的原始回答</h2></div><small>永不覆盖</small></div><p>{answer.rawText}</p></section>
        <section className="workspace-card workspace-revision"><div className="workspace-card-title"><div><h2>{current?.kind === "normalized_transcript" ? "整理后的回答" : current?.kind === "raw" || current?.kind === "raw_transcript" ? "原始英文版本" : "自然英文版本"}</h2></div><small>{current ? `V${current.versionNo}` : "待生成"}</small></div>
          {draft || current?.textEn ? <><label className="sr-only" htmlFor="answer-english-version">{answer.status === "superseded" ? "英文答案版本（只读）" : "可编辑的英文答案版本"}</label><textarea id="answer-english-version" value={draft} readOnly={!editorReady || answer.status === "superseded"} aria-busy={!editorReady} maxLength={8000} onChange={(event) => { draftDirty.current = true; setDraft(event.target.value); }} />{!editorReady&&<p role="status">正在准备编辑区域，原回答已保留。</p>}<div className="workspace-actions"><button type="button" className="secondary-button" disabled={!editorReady || answer.status === "superseded" || busy || !draft.trim() || draft.trim() === current?.textEn.trim()} onClick={() => void saveVersion()}>{busy ? "处理中…" : "另存为新版本"}</button></div></> : <div className="workspace-pending"><strong>{statusLabel[answer.status] || "等待处理"}</strong><p>原始回答已经安全保存。</p></div>}
          {['draft', 'failed', 'needs_attention'].includes(answer.status) ? <div className="workspace-actions"><p>原文和当前编辑内容会保留，可以重新处理 AI 任务。</p><button type="button" className="secondary-button" disabled={!editorReady || busy} onClick={() => void retry()}>{busy ? "正在处理…" : "重新处理"}</button></div> : null}
        </section>
      </div>
      <section className="version-history"><div><h2>全部版本</h2></div><ol>{answer.versions.map((version) => <li key={version.id}><strong>V{version.versionNo} · {({ raw: "原始版本", raw_transcript: "原始转写", normalized_transcript: "断句与切分整理", ai_revised: "AI 修订", user_edited: "用户编辑" })[version.kind]}</strong><span>{new Date(version.createdAt).toLocaleString("zh-CN")}</span></li>)}</ol></section>
      {answer.status === "ready" ? <section className="workspace-output-cta"><div><h2>回答已保存</h2><p>在本题学习包查看材料处理状态、待学表达和重答记录。</p></div><Link href={`/questions/${encodeURIComponent(answer.questionId)}`} className="primary-button">查看本题学习进度</Link></section> : null}
    </div></div>
  );
}
