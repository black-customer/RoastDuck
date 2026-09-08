"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { QuestionListItem } from "@/lib/questions/service";
import { InteractiveEnglishText } from "./InteractiveEnglishText";
import { LookupCard } from "./LookupCard";

interface QuestionSetSummary {
  id: string;
  nameZh: string;
  questionCount: number;
}

interface QuestionTopicSummary {
  id: string;
  nameZh: string;
  nameEn: string;
  part: number | null;
  questionCount: number;
}

interface QuestionResponse {
  items: QuestionListItem[];
  topics: QuestionTopicSummary[];
  total: number;
  page: number;
  pageCount: number;
  error?: string;
}

const EMPTY_RESPONSE: QuestionResponse = { items: [], topics: [], total: 0, page: 1, pageCount: 1 };

function FilterIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="h-5 w-5">
      <path d="M4 7h10M18 7h2M4 17h2M10 17h10M14 5v4M6 15v4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function ShuffleIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="h-5 w-5">
      <path d="M4 7h3.5c4.5 0 4.5 10 9 10H20m-3-3 3 3-3 3M4 17h3.5c1.7 0 2.8-1.4 3.8-3M14 8.5c.7-.9 1.5-1.5 2.7-1.5H20m-3-3 3 3-3 3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function QuestionLibrary() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryString = searchParams.toString();
  const [sets, setSets] = useState<QuestionSetSummary[]>([]);
  const [data, setData] = useState<QuestionResponse>(EMPTY_RESPONSE);
  const [searchDraft, setSearchDraft] = useState(searchParams.get("q") ?? "");
  const [loading, setLoading] = useState(true);
  const [randomLoading, setRandomLoading] = useState(false);
  const [error, setError] = useState("");
  const [lookupId, setLookupId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const updateFilters = useCallback((updates: Record<string, string | null>) => {
    const next = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(updates)) {
      if (!value || value === "all" || value === "0") next.delete(key);
      else next.set(key, value);
    }
    if (!("page" in updates)) next.delete("page");
    router.push(next.size ? `/questions?${next}` : "/questions", { scroll: false });
  }, [router, searchParams]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    const query = queryString ? `?${queryString}` : "";
    void Promise.all([
      fetch("/api/question-sets", { signal: controller.signal, cache: "no-store" }),
      fetch(`/api/questions${query}`, { signal: controller.signal, cache: "no-store" }),
    ]).then(async ([setsResponse, questionsResponse]) => {
      const setsBody = (await setsResponse.json()) as { sets?: QuestionSetSummary[]; error?: string };
      const questionsBody = (await questionsResponse.json()) as QuestionResponse;
      if (!setsResponse.ok) throw new Error(setsBody.error || "题集加载失败");
      if (!questionsResponse.ok) throw new Error(questionsBody.error || "题目加载失败");
      setSets(setsBody.sets ?? []);
      setData(questionsBody);
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "题库加载失败，请重试");
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [queryString, reloadKey]);

  useEffect(() => {
    setSearchDraft(searchParams.get("q") ?? "");
  }, [searchParams]);

  const active = useMemo(() => ({
    set: searchParams.get("set") ?? "",
    part: searchParams.get("part") ?? "",
    topic: searchParams.get("topic") ?? "",
    status: searchParams.get("status") ?? "all",
    sortBy: searchParams.get("sortBy") ?? "default",
    favorite: searchParams.get("favorite") === "1",
  }), [searchParams]);

  async function toggleMastery(questionId: string, currentMastered: boolean) {
    setData((prev) => ({
      ...prev,
      items: prev.items.map((q) => {
        if (q.id !== questionId) return q;
        const nextMastered = !currentMastered;
        return {
          ...q,
          isMastered: nextMastered,
          state: nextMastered ? "mastered" : (q.fourStepCompletedAt ? "learning_completed" : "learning_incomplete"),
          stateLabel: nextMastered ? "自评已掌握" : (q.fourStepCompletedAt ? "已完成学习" : "未完成学习"),
        };
      }),
    }));

    try {
      const response = await fetch(`/api/questions/${encodeURIComponent(questionId)}/mastery`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mastered: !currentMastered }),
      });
      if (!response.ok) throw new Error("更新掌握状态失败");
    } catch (err) {
      console.error(err);
      setReloadKey((k) => k + 1);
    }
  }

  async function openRandomQuestion() {
    setRandomLoading(true);
    setError("");
    try {
      const params = new URLSearchParams(searchParams.toString());
      params.delete("page");
      const response = await fetch(`/api/questions/random${params.size ? `?${params}` : ""}`, { cache: "no-store" });
      const body = (await response.json()) as { question?: QuestionListItem; error?: string };
      if (!response.ok || !body.question) throw new Error(body.error || "暂时无法分配题目");
      router.push(`/questions/${encodeURIComponent(body.question.id)}?from=random`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "暂时无法分配题目");
      setRandomLoading(false);
    }
  }

  return (
    <div className="question-shell">
      <div className="question-frame">
        <section className="question-intro">
          <div>
            <h1>雅思题库</h1>
            <p>按季度、Part 和话题找到想练的题；看不懂的英文可以直接点开查询。</p>
          </div>
          <button type="button" className="question-random-button" disabled={randomLoading} onClick={() => void openRandomQuestion()}>
            <ShuffleIcon />
            {randomLoading ? "正在挑题…" : "随机一道"}
          </button>
        </section>

        <section className="question-controls" aria-label="题库筛选">
          <form
            className="question-search"
            onSubmit={(event) => {
              event.preventDefault();
              updateFilters({ q: searchDraft.trim() || null });
            }}
          >
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="h-5 w-5"><circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.8" /><path d="m16 16 4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
            <label htmlFor="question-search" className="sr-only">搜索中英文题目或话题</label>
            <input id="question-search" value={searchDraft} onChange={(event) => setSearchDraft(event.target.value)} placeholder="搜索英文、中文或话题" />
            <button type="submit">搜索</button>
          </form>

          <div className="question-filter-row">
            <span className="question-filter-label"><FilterIcon />筛选</span>
            <label>
              <span className="sr-only">题集</span>
              <select value={active.set} onChange={(event) => updateFilters({ set: event.target.value || null })}>
                <option value="">全部季度</option>
                {sets.map((set) => <option key={set.id} value={set.id}>{set.nameZh}（{set.questionCount}）</option>)}
              </select>
            </label>
            <div className="question-part-tabs" aria-label="选择 IELTS Part">
              {["", "1", "2", "3"].map((part) => (
                <button key={part || "all"} type="button" aria-pressed={active.part === part} onClick={() => updateFilters({ part: part || null, topic: null })}>
                  {part ? `Part ${part}` : "全部"}
                </button>
              ))}
            </div>
            <label>
              <span className="sr-only">话题</span>
              <select value={active.topic} onChange={(event) => updateFilters({ topic: event.target.value || null })}>
                <option value="">全部话题</option>
                {data.topics.map((topic) => (
                  <option key={topic.id} value={topic.id}>{topic.nameZh || topic.nameEn}（{topic.questionCount}）</option>
                ))}
              </select>
            </label>
            <label>
              <span className="sr-only">回答与掌握状态</span>
              <select value={active.status} onChange={(event) => updateFilters({ status: event.target.value })}>
                <option value="all">全部状态</option>
                <option value="unanswered">未作答</option>
                <option value="learning_incomplete">未完成学习</option>
                <option value="learning_completed">已完成学习</option>
                <option value="mastered">自评已掌握</option>
              </select>
            </label>
            <label>
              <span className="sr-only">排序方式</span>
              <select value={active.sortBy} onChange={(event) => updateFilters({ sortBy: event.target.value })}>
                <option value="default">默认排序</option>
                <option value="longest_unreviewed">最久未复习</option>
                <option value="latest">最近作答/学习</option>
              </select>
            </label>
            <button type="button" className="question-favorite-filter" aria-pressed={active.favorite} onClick={() => updateFilters({ favorite: active.favorite ? null : "1" })}>
              <svg viewBox="0 0 24 24" fill={active.favorite ? "currentColor" : "none"} aria-hidden="true" className="h-4 w-4"><path d="m12 4 2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.5-4.8 2.5.9-5.4-3.9-3.8 5.4-.8L12 4Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /></svg>
              只看收藏
            </button>
          </div>
        </section>

        {error ? (
          <div className="error-banner question-error" role="alert">
            <span>{error}</span>
            <button type="button" onClick={() => setReloadKey((value) => value + 1)}>重新加载</button>
          </div>
        ) : null}

        <section className="question-results" aria-live="polite" aria-busy={loading}>
          {loading ? (
            <div className="question-list-skeleton" aria-label="题目加载中">{[0, 1, 2, 3].map((value) => <span key={value} />)}</div>
          ) : data.items.length ? (
            <ol className="question-list">
              {data.items.map((question) => (
                <li key={question.id} className="question-row">
                  <div className="question-row-meta">
                    <span>Part {question.part}</span>
                    <span>{question.topicZh || question.topicEn || "未分类话题"}</span>
                    {question.state === "mastered" ? (
                      <span className="is-mastered" style={{ color: "#16a34a", fontWeight: 600 }}>🌟 自评已掌握</span>
                    ) : question.state === "learning_completed" ? (
                      <span className="is-complete" style={{ color: "#2563eb", fontWeight: 500 }}>✅ 已完成学习</span>
                    ) : question.state === "learning_incomplete" ? (
                      <span className="is-learning" style={{ color: "var(--warning)", fontWeight: 500 }}>📖 未完成学习</span>
                    ) : (
                      <span className="is-unanswered" style={{ color: "#64748b" }}>未作答</span>
                    )}
                    {question.daysSinceReview != null && question.state !== "unanswered" ? (
                      <span
                        className="review-badge"
                        style={{
                          fontSize: "0.75rem",
                          padding: "2px 7px",
                          borderRadius: "9999px",
                          fontWeight: 500,
                          backgroundColor: question.daysSinceReview >= 3 ? "#fee2e2" : "#f1f5f9",
                          color: question.daysSinceReview >= 3 ? "#dc2626" : "#475569",
                        }}
                      >
                        {question.daysSinceReview === 0 ? "今天已练" : `${question.daysSinceReview} 天未复习`}
                      </span>
                    ) : null}
                    {question.repeatedGapCount ? <span>{question.repeatedGapCount} 个重复问题</span> : null}
                  </div>
                  {question.textEn.trim() ? <InteractiveEnglishText content={question.interactiveQuestion} onLookup={setLookupId} className="question-row-title" /> : <p className="question-row-title">历史回答 · 原始问句缺失</p>}
                  <p className="question-row-translation">{question.textZh || "中文题干正在补全；英文原题与来源可正常使用。"}</p>
                  <div className="question-row-footer">
                    <p>{question.setNames.join(" · ") || "个人题目"} · {question.answerCount ? `${question.answerCount} 次回答` : `${question.sourceCount} 个来源`}</p>
                    <div style={{ display: "inline-flex", alignItems: "center", gap: "10px" }}>
                      {question.answerCount > 0 ? (
                        <button
                          type="button"
                          onClick={() => void toggleMastery(question.id, question.isMastered)}
                          style={{
                            fontSize: "0.8rem",
                            padding: "4px 10px",
                            borderRadius: "6px",
                            border: question.isMastered ? "1px solid #86efac" : "1px solid #cbd5e1",
                            backgroundColor: question.isMastered ? "#f0fdf4" : "#ffffff",
                            color: question.isMastered ? "#16a34a" : "#64748b",
                            cursor: "pointer",
                            fontWeight: 500,
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "4px",
                          }}
                          title={question.isMastered ? "取消自评掌握" : "自评为已掌握（不代表跨日验证）"}
                        >
                          {question.isMastered ? "✓ 自评已掌握" : "自评掌握"}
                        </button>
                      ) : null}
                      <Link href={`/questions/${encodeURIComponent(question.id)}`} className="question-open-link">
                        {question.state === "learning_incomplete" ? "进入 4 步强化" : question.answerCount ? "查看/复习" : "查看并回答"}
                        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="h-4 w-4"><path d="m9 6 6 6-6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
                      </Link>
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <div className="question-empty">
              <h2>这个筛选组合暂时没有题目</h2>
              <p>清除部分条件，或者让系统从全部题库里随机挑一道。</p>
              <div>
                <button type="button" className="secondary-button" onClick={() => { setSearchDraft(""); router.push("/questions"); }}>清除筛选</button>
                <button type="button" className="primary-button" disabled={randomLoading} onClick={() => void openRandomQuestion()}>从全部题库随机</button>
              </div>
            </div>
          )}
        </section>

        {!loading && data.items.length ? (
          <nav className="question-pagination" aria-label="题库分页">
            <button type="button" disabled={data.page <= 1} onClick={() => updateFilters({ page: String(data.page - 1) })}>上一页</button>
            <span>第 {data.page} / {data.pageCount} 页</span>
            <button type="button" disabled={data.page >= data.pageCount} onClick={() => updateFilters({ page: String(data.page + 1) })}>下一页</button>
          </nav>
        ) : null}
      </div>
      <LookupCard annotationId={lookupId} onClose={() => setLookupId(null)} />
    </div>
  );
}
