"use client";

import { useEffect, useRef, useState } from "react";
import { SpeakButton } from "./SpeakButton";

interface LookupData {
  id: string;
  surface: string;
  display: string;
  meaningZh: string;
  ipa: string;
  accent: string;
  lemma: string | null;
  source: string;
  kind: "chunk" | "lexeme";
  noteId: string | null;
  userRemark: string;
}

async function createAnnotationNote(annotationId: string, trigger: "user_added" | "lookup", signal?: AbortSignal) {
  const response = await fetch("/api/notes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ annotationId, trigger }),
    signal,
  });
  const body = (await response.json()) as { note?: { id: string } | null; error?: string };
  if (!response.ok) throw new Error(body.error || "加入难点失败，请重试");
  return body.note?.id ?? null;
}

export function LookupCard({ annotationId, onClose }: { annotationId: string | null; onClose: () => void }) {
  const [data, setData] = useState<LookupData | null>(null);
  const [error, setError] = useState("");
  const [remark, setRemark] = useState("");
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [adding, setAdding] = useState(false);
  const [loadVersion, setLoadVersion] = useState(0);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!annotationId) return;
    const controller = new AbortController();
    let focusFrame=0;
    setData(null);
    setError("");
    void fetch(`/api/lookups/${encodeURIComponent(annotationId)}`, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        const body = (await response.json()) as LookupData & { error?: string };
        if(controller.signal.aborted)return;
        if (!response.ok) throw new Error(body.error || "英文小卡加载失败");
        setData(body);
        setRemark(body.userRemark || "");
        focusFrame=requestAnimationFrame(() => {if(!controller.signal.aborted)closeRef.current?.focus();});

        // 查询接口始终保持只读；只有用户主动打开自动收集后，客户端才显式创建难点。
        if (!body.noteId) {
          try {
            const settingsResponse = await fetch("/api/settings", { signal: controller.signal, cache: "no-store" });
            const settingsBody = (await settingsResponse.json()) as {
              settings?: { autoCollectDifficulties?: boolean };
            };
            if (settingsResponse.ok && settingsBody.settings?.autoCollectDifficulties) {
              setAdding(true);
              const noteId = await createAnnotationNote(body.id, "lookup", controller.signal);
              if (noteId && !controller.signal.aborted) {
                setData((current) => current?.id === body.id ? { ...current, noteId } : current);
              }
            }
          } catch (reason) {
            if (!controller.signal.aborted) {
              setError(reason instanceof Error ? reason.message : "自动加入难点失败，可稍后手动重试");
            }
          } finally {
            if (!controller.signal.aborted) setAdding(false);
          }
        }
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "英文小卡加载失败");
      });
    return () => {controller.abort();cancelAnimationFrame(focusFrame);};
  }, [annotationId, loadVersion]);

  useEffect(() => {
    if (!annotationId) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [annotationId, onClose]);

  if (!annotationId) return null;

  const saveRemark = async () => {
    if (!data?.noteId) return;
    setSaving(true);
    setError("");
    try {
      const response = await fetch(`/api/notes/${encodeURIComponent(data.noteId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userRemark: remark }),
      });
      if (!response.ok) throw new Error("个人备注保存失败，请重试");
      setEditing(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "个人备注保存失败");
    } finally {
      setSaving(false);
    }
  };

  const addToNotes = async () => {
    if (!data || data.noteId) return;
    setAdding(true);
    setError("");
    try {
      const noteId = await createAnnotationNote(data.id, "user_added");
      if (noteId) setData({ ...data, noteId });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "加入难点失败，请重试");
    } finally {
      setAdding(false);
    }
  };

  return (
    <aside className="lookup-card" role="dialog" aria-modal="false" aria-label="英文解释卡片">
      <div className="flex items-start justify-between gap-5">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <p className="text-xs font-semibold tracking-[.08em] text-[var(--primary-strong)]">
              {data?.noteId ? "已在难点中" : "英文解释"}
            </p>
            {data && !data.noteId ? (
              <button type="button" className="text-button" disabled={adding} onClick={() => void addToNotes()}>
                {adding ? "加入中…" : "加入难点"}
              </button>
            ) : null}
          </div>
          {data ? <h2 className="mt-2 break-words text-2xl font-semibold tracking-[-.02em]" lang="en">{data.display}</h2> : null}
        </div>
        <button ref={closeRef} type="button" onClick={onClose} className="icon-button" aria-label="关闭英文小卡">
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="h-5 w-5">
            <path d="m7 7 10 10M17 7 7 17" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {!data && !error ? <div className="mt-6 h-20 animate-pulse rounded-xl bg-[var(--primary-soft)]" /> : null}
      {error ? (
        <div className="mt-5 text-sm text-[var(--danger)]" role="alert">
          <p>{error}</p>
          <button type="button" className="text-button mt-2" onClick={() => setLoadVersion((value) => value + 1)}>重新加载英文小卡</button>
        </div>
      ) : null}
      {data ? (
        <div className="mt-5 space-y-4">
          <div className="flex items-center gap-3">
            <SpeakButton text={data.display} lang={data.accent} />
            <div>
              {data.ipa ? <p className="font-medium text-[var(--muted-strong)]" lang="en">/{data.ipa.replace(/^\/+|\/+$/g, "")}/</p> : null}
              <p className="mt-0.5 text-xs text-[var(--muted)]">{data.accent} · {data.kind === "chunk" ? "语块" : "词条"}</p>
            </div>
          </div>
          <p className="text-base leading-7 text-[var(--foreground)]">{data.meaningZh}</p>
          {data.lemma && data.lemma !== data.surface.toLowerCase() ? (
            <p className="text-sm text-[var(--muted)]">原形：<span lang="en">{data.lemma}</span></p>
          ) : null}
          <div className="flex items-center justify-between gap-3 border-t border-[var(--border)] pt-4">
            <p className="truncate text-xs text-[var(--muted)]">释义来源：{data.source}</p>
            {data.noteId ? (
              <button type="button" className="text-button" onClick={() => setEditing((value) => !value)}>
                {editing ? "收起备注" : "补充备注"}
              </button>
            ) : null}
          </div>
          {editing ? (
            <div className="space-y-2">
              <label htmlFor="lookup-remark" className="block text-sm font-medium">我的备注</label>
              <textarea
                id="lookup-remark"
                value={remark}
                onChange={(event) => setRemark(event.target.value)}
                rows={3}
                maxLength={2000}
                placeholder="写下联想、使用场景或容易混淆的表达"
                className="field w-full resize-none"
              />
              <button type="button" className="primary-button w-full" disabled={saving} onClick={() => void saveRemark()}>
                {saving ? "保存中…" : "保存备注"}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </aside>
  );
}
