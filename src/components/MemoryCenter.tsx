"use client";

import { useMemo, useState } from "react";
import type { listCompanionMemories } from "@/lib/companion/service";
import { PageHeader } from "./ui/PageHeader";
import styles from "./MemoryCenter.module.css";

type Memory = Awaited<ReturnType<typeof listCompanionMemories>>[number];
const categoryLabels: Record<string, string> = {
  goal: "学习目标", preference: "偏好", interest: "兴趣", experience: "经历", opinion: "观点", learning: "学习记录",
};

export function MemoryCenter({ initialMemories }: { initialMemories: Memory[] }) {
  const [memories, setMemories] = useState(initialMemories);
  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("zh-CN");
    return needle ? memories.filter((memory) => memory.summary.toLocaleLowerCase("zh-CN").includes(needle)) : memories;
  }, [memories, query]);

  async function patchMemory(id: string, patch: { summary?: string; status?: "dismissed" }) {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/companion/memories", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, ...patch }) });
      const body = (await response.json()) as { memory?: Memory; error?: string };
      if (!response.ok || !body.memory) throw new Error(body.error || "记忆没有保存成功");
      if (patch.status === "dismissed") setMemories((items) => items.filter((item) => item.id !== id));
      else setMemories((items) => items.map((item) => item.id === id ? { ...item, ...body.memory } : item));
      setEditingId(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "记忆没有保存成功"); }
    finally { setBusy(false); }
  }

  async function remove(id: string) {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/companion/memories", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) });
      if (!response.ok) throw new Error(((await response.json()) as { error?: string }).error || "记忆没有删除成功");
      setMemories((items) => items.filter((item) => item.id !== id));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "记忆没有删除成功"); }
    finally { setBusy(false); }
  }

  async function clearAll() {
    if (!window.confirm("清空 Chloe 的全部长期记忆？对话记录和学习进度不会被删除。")) return;
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/companion/memories", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ all: true }) });
      if (!response.ok) throw new Error(((await response.json()) as { error?: string }).error || "记忆没有清空成功");
      setMemories([]);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "记忆没有清空成功"); }
    finally { setBusy(false); }
  }

  return <div className={styles.frame}>
    <PageHeader title="Chloe 记得什么" description="这里仅保存可追溯的学习记录和你明确说过的稳定信息。你随时可以修改、撤销或清空。" actions={memories.length ? <button type="button" className="secondary-button" disabled={busy} onClick={() => void clearAll()}>清空全部记忆</button> : null} />
    <div className={styles.controls}>
      <label htmlFor="memory-search">搜索记忆</label>
      <input id="memory-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索目标、偏好、经历或学习记录" />
      <span>{visible.length} 条</span>
    </div>
    {error ? <div className="error-banner" role="alert"><span>{error}</span><button type="button" onClick={() => setError("")}>关闭</button></div> : null}
    {visible.length ? <ul className={styles.list}>{visible.map((memory) => <li key={memory.id}>
      <div className={styles.meta}><span>{categoryLabels[memory.category] ?? memory.category}</span><time dateTime={memory.updatedAt}>{new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" }).format(new Date(memory.updatedAt))}</time></div>
      {editingId === memory.id ? <div className={styles.editor}>
        <label htmlFor={`memory-${memory.id}`}>记忆内容</label><textarea id={`memory-${memory.id}`} value={draft} onChange={(event) => setDraft(event.target.value)} rows={3} />
        <div><button type="button" disabled={busy} onClick={() => setEditingId(null)}>取消</button><button type="button" className="primary-button" disabled={busy || draft.trim().length < 2} onClick={() => void patchMemory(memory.id, { summary: draft.trim() })}>保存修改</button></div>
      </div> : <p>{memory.summary}</p>}
      <div className={styles.provenance}><span>来源：{memory.sourceType === "learning_event" ? "学习事件" : "Chloe 对话"}</span><span>置信度 {Math.round(memory.confidence * 100)}%</span></div>
      {editingId !== memory.id ? <div className={styles.actions}><button type="button" disabled={busy} onClick={() => { setEditingId(memory.id); setDraft(memory.summary); }}>修改</button><button type="button" disabled={busy} onClick={() => void patchMemory(memory.id, { status: "dismissed" })}>撤销使用</button><button type="button" disabled={busy} onClick={() => void remove(memory.id)}>删除</button></div> : null}
    </li>)}</ul> : <section className={styles.empty}>
      <svg viewBox="0 0 48 48" aria-hidden="true"><path d="M16 8h16a6 6 0 0 1 6 6v20a6 6 0 0 1-6 6H16a6 6 0 0 1-6-6V14a6 6 0 0 1 6-6Z" /><path d="M17 18h14M17 25h10" /></svg>
      <h2>{query ? "没有匹配的记忆" : "Chloe 还没有长期记忆"}</h2><p>{query ? "换一个关键词试试。" : "学习表现会确定性记录；稳定的个人信息只从你明确说过的话中提取。"}</p>
    </section>}
  </div>;
}
