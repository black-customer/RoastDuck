"use client";

import Link from "next/link";
import { useState } from "react";
import type { listPersonalBook } from "@/lib/answers/processor";
import { InteractiveEnglishText } from "./InteractiveEnglishText";
import { LookupCard } from "./LookupCard";
import { PageHeader } from "./ui/PageHeader";

type PersonalBookView = Awaited<ReturnType<typeof listPersonalBook>>;

export function PersonalBook({ initialBook }: { initialBook: PersonalBookView }) {
  const [book, setBook] = useState(initialBook);
  const [lookupId, setLookupId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftDisplay, setDraftDisplay] = useState("");
  const [draftMeaning, setDraftMeaning] = useState("");
  const [error, setError] = useState("");

  async function refresh() {
    const response = await fetch("/api/personal-book", { cache: "no-store" });
    const body = (await response.json()) as { book?: PersonalBookView };
    if (response.ok && body.book) setBook(body.book);
  }

  async function remove(id: string) {
    if (!window.confirm("从个人词书移除这条关联？已经形成的学习进度不会被静默删除。")) return;
    const response = await fetch(`/api/personal-chunks/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!response.ok) { setError("移除失败，请稍后重试。"); return; }
    await refresh();
  }

  async function save(id: string) {
    const response = await fetch(`/api/personal-chunks/${encodeURIComponent(id)}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ display: draftDisplay, meaningZh: draftMeaning }),
    });
    const body = (await response.json()) as { error?: string };
    if (!response.ok) { setError(body.error || "修改失败"); return; }
    setEditingId(null); await refresh();
  }

  return (
    <div className="personal-book-shell"><div className="personal-book-frame">
      <PageHeader title="我的雅思答案" description={`从你的真实回答中整理表达，当前有 ${book.items.length} 个可用学习项。`} actions={<Link href="/questions?status=has_history" className="secondary-button">按题查看</Link>} />
      {error ? <div className="error-banner" role="alert"><span>{error}</span><button type="button" onClick={() => setError("")}>关闭</button></div> : null}
      {book.items.length ? <section className="personal-book-list"><div className="personal-book-list-head"><h2>我的学习表达</h2><span>已完成内容复核</span></div><ul>{book.items.map((item) => <li key={item.id}>
        <div className="personal-book-item-main">
          <div className="personal-book-item-title"><Link href={`/chunks/${encodeURIComponent(item.id)}`} lang="en">{item.display}</Link><span>{item.origin === "public" ? "已关联公共表达" : "个人表达"}</span></div>
          {editingId === item.id ? <div className="personal-book-edit"><label>英文表达<input value={draftDisplay} onChange={(event) => setDraftDisplay(event.target.value)} /></label><label>中文含义<input value={draftMeaning} onChange={(event) => setDraftMeaning(event.target.value)} /></label><div><button type="button" onClick={() => setEditingId(null)}>取消</button><button type="button" onClick={() => void save(item.id)}>保存</button></div></div> : <><p>{item.meaningZh}</p><small lang="en">/{item.ipa.replace(/^\/+|\/+$/g, "")}/ · {item.pattern}</small></>}
          {item.exampleEn ? <div className="personal-book-example"><InteractiveEnglishText content={item.interactiveExample} onLookup={setLookupId} /><span>{item.exampleZh}</span></div> : null}
        </div>
        <div className="personal-book-item-actions">{item.origin === "personal" ? <button type="button" onClick={() => { setEditingId(item.id); setDraftDisplay(item.display); setDraftMeaning(item.meaningZh); }}>修改</button> : null}<button type="button" onClick={() => void remove(item.id)}>移除</button></div>
      </li>)}</ul></section> : <section className="personal-book-empty"><h2>第一条个人表达，会从一次真实回答开始。</h2><p>中文、英文或中英混合都可以。系统会先保存原文，再修订、提取、独立审核。</p><Link href="/questions" className="primary-button">选择一道题</Link></section>}
      {book.rejected.length ? <details className="personal-review-exceptions"><summary>查看自动拒绝的候选（{book.rejected.length}）</summary><ul>{book.rejected.map((item, index) => <li key={`${item.canonicalChunk}-${index}`}><strong lang="en">{item.canonicalChunk}</strong><span>{item.reason}</span></li>)}</ul></details> : null}
    </div><LookupCard annotationId={lookupId} onClose={() => setLookupId(null)} /></div>
  );
}
