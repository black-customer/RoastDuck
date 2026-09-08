"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { LookupCard } from "./LookupCard";

interface DifficultyNote {
  id: string;
  chunkId: string | null;
  annotationId: string | null;
  surface: string;
  meaningZh: string;
  sourceType: string;
  sourceId: string;
  status: string;
  userRemark: string;
  triggerCount: number;
  lastTrigger: string;
  createdAt: string;
  updatedAt: string;
}

type Filter = "open" | "resolved" | "all";

const triggerLabels: Record<string, string> = {
  lookup_opened: "查询英文",
  comprehension_unsure: "有点懵",
  comprehension_missed: "没听懂",
  practice_incorrect: "练习错误",
};

function shortDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(date);
}

export function DifficultiesList({ initialNotes }: { initialNotes: DifficultyNote[] }) {
  const [notes, setNotes] = useState(initialNotes);
  const [filter, setFilter] = useState<Filter>("open");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [lookupId, setLookupId] = useState<string | null>(null);

  const visibleNotes = useMemo(
    () => notes.filter((note) => filter === "all" || note.status === filter),
    [filter, notes],
  );

  const patchNote = async (id: string, body: { userRemark?: string; status?: "open" | "resolved" }) => {
    setSavingId(id);
    setError("");
    try {
      const response = await fetch(`/api/notes/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await response.json()) as { note?: DifficultyNote; error?: string };
      if (!response.ok || !payload.note) throw new Error(payload.error || "难点保存失败");
      setNotes((current) => current.map((note) => (note.id === id ? payload.note! : note)));
      setEditingId(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "难点保存失败");
    } finally {
      setSavingId(null);
    }
  };

  const beginEdit = (note: DifficultyNote) => {
    setEditingId(note.id);
    setDraft(note.userRemark);
    setError("");
  };

  return (
    <section className="mt-10" aria-label="难点笔记列表">
      <div className="flex gap-6 border-b border-[var(--border)]" role="group" aria-label="筛选难点">
        {([
          ["open", "待处理"],
          ["resolved", "已解决"],
          ["all", "全部"],
        ] as const).map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={filter === value}
            className={`border-b-2 px-0.5 pb-3 text-sm font-semibold transition-colors ${
              filter === value
                ? "border-[var(--primary)] text-[var(--primary-strong)]"
                : "border-transparent text-[var(--muted)] hover:text-[var(--foreground)]"
            }`}
            onClick={() => setFilter(value)}
          >
            {label}
          </button>
        ))}
      </div>

      {error ? <p className="error-banner mt-5" role="alert">{error}</p> : null}

      {visibleNotes.length ? (
        <div className="divide-y divide-[var(--border)]">
          {visibleNotes.map((note) => (
            <article key={note.id} className="py-7">
              <div className="flex items-start justify-between gap-5">
                <div className="min-w-0">
                  {note.annotationId ? (
                    <button
                      type="button"
                      className="interactive-english text-left text-xl font-semibold tracking-[-.02em]"
                      lang="en"
                      onClick={() => setLookupId(note.annotationId)}
                      aria-label={`查看 ${note.surface} 的解释`}
                    >
                      {note.surface}
                    </button>
                  ) : note.chunkId ? (
                    <Link
                      href={`/chunks/${encodeURIComponent(note.chunkId)}`}
                      className="interactive-english text-xl font-semibold tracking-[-.02em]"
                      lang="en"
                    >
                      {note.surface}
                    </Link>
                  ) : (
                    <p className="text-xl font-semibold tracking-[-.02em]" lang="en">{note.surface}</p>
                  )}
                  <p className="mt-2 leading-7 text-[var(--foreground)]">{note.meaningZh || "释义待补充"}</p>
                </div>
                <span className={`status-chip flex-none ${note.status === "resolved" ? "!bg-[var(--success-soft)] !text-[var(--success)]" : ""}`}>
                  {note.status === "resolved" ? "已解决" : "待处理"}
                </span>
              </div>

              <p className="mt-3 text-xs leading-5 text-[var(--muted)]">
                {triggerLabels[note.lastTrigger] ?? "学习中记录"} · 出现 {note.triggerCount} 次 · {shortDate(note.updatedAt)}更新
              </p>

              {note.userRemark && editingId !== note.id ? (
                <blockquote className="mt-4 border-l-2 border-[var(--primary-soft-strong)] pl-4 text-sm leading-6 text-[var(--muted-strong)]">
                  {note.userRemark}
                </blockquote>
              ) : null}

              {editingId === note.id ? (
                <div className="mt-5 space-y-3">
                  <label htmlFor={`remark-${note.id}`} className="block text-sm font-semibold">我的备注</label>
                  <textarea
                    id={`remark-${note.id}`}
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    maxLength={2000}
                    rows={3}
                    className="field w-full resize-y"
                    placeholder="写下联想、使用场景或容易混淆的表达"
                  />
                  <div className="flex flex-wrap gap-3">
                    <button
                      type="button"
                      className="primary-button"
                      disabled={savingId === note.id}
                      onClick={() => void patchNote(note.id, { userRemark: draft })}
                    >
                      {savingId === note.id ? "保存中…" : "保存备注"}
                    </button>
                    <button type="button" className="secondary-button" onClick={() => setEditingId(null)}>取消</button>
                  </div>
                </div>
              ) : (
                <div className="mt-5 flex flex-wrap gap-x-5 gap-y-2">
                  <button type="button" className="text-button" onClick={() => beginEdit(note)}>
                    {note.userRemark ? "修改备注" : "补充备注"}
                  </button>
                  <button
                    type="button"
                    className="text-button"
                    disabled={savingId === note.id}
                    onClick={() => void patchNote(note.id, { status: note.status === "resolved" ? "open" : "resolved" })}
                  >
                    {note.status === "resolved" ? "重新打开" : "标记已解决"}
                  </button>
                </div>
              )}
            </article>
          ))}
        </div>
      ) : (
        <div className="py-20 text-center">
          <p className="text-lg font-semibold">这里暂时没有{filter === "open" ? "待处理" : filter === "resolved" ? "已解决" : ""}难点</p>
          <p className="mt-2 text-sm leading-6 text-[var(--muted)]">学习时点击英文，系统会自动把需要回看的内容带到这里。</p>
          <Link href="/learn?mode=learn" className="primary-button mt-6">去学习</Link>
        </div>
      )}

      <LookupCard annotationId={lookupId} onClose={() => setLookupId(null)} />
    </section>
  );
}
