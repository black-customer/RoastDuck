"use client";

import { useEffect, useRef, useState } from "react";

export interface IeltsQuestionItem {
  id: string;
  part: number;
  textEn: string;
  textZh?: string;
  topicTitleZh?: string;
}

interface IeltsTopicDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectTopic: (question: IeltsQuestionItem) => void;
}

export function IeltsTopicDrawer({ isOpen, onClose, onSelectTopic }: IeltsTopicDrawerProps) {
  const [questions, setQuestions] = useState<IeltsQuestionItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [partFilter, setPartFilter] = useState<number | undefined>(undefined);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const requestOrder = useRef(0);
  const openRef = useRef(isOpen);
  openRef.current = isOpen;
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!isOpen) return;
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); closeRef.current(); }
      if (event.key !== "Tab") return;
      const buttons = [...panel.current!.querySelectorAll<HTMLElement>("button:not(:disabled),input")];
      const first = buttons[0], last = buttons.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", handleKey);
    return () => { document.removeEventListener("keydown", handleKey); previous?.focus(); };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;

    let active = true;
    const requestId = ++requestOrder.current;
    setLoading(true);
    setError("");

    const params = new URLSearchParams();
    if (partFilter) params.set("part", String(partFilter));
    if (searchQuery.trim()) params.set("q", searchQuery.trim());
    params.set("pageSize", "36");

    void fetch(`/api/questions?${params.toString()}`)
      .then(async (res) => {
        if (!res.ok) throw new Error("获取题库失败");
        return (await res.json()) as { items?: Array<{ id: string; part: number; textEn: string; textZh?: string; topicZh?: string }> };
      })
      .then((data) => {
        if (!active || requestId !== requestOrder.current) return;
        const mapped: IeltsQuestionItem[] = (data.items ?? []).map((q) => ({
          id: q.id,
          part: q.part,
          textEn: q.textEn,
          textZh: q.textZh,
          topicTitleZh: q.topicZh,
        }));
        setQuestions(mapped);
      })
      .catch(() => {
        if (active && requestId === requestOrder.current) setError("题库加载失败，原列表已保留。");
      })
      .finally(() => {
        if (active && requestId === requestOrder.current) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [isOpen, partFilter, searchQuery, reload]);

  async function handlePickRandom() {
    const requestId = ++requestOrder.current;
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (partFilter) params.set("part", String(partFilter));
      const res = await fetch(`/api/questions/random?${params.toString()}`);
      if (!res.ok) throw new Error("随机题暂不可用");
      if (openRef.current && requestId === requestOrder.current) {
        const data = (await res.json()) as { question?: { id: string; part: number; textEn: string; textZh?: string; topicZh?: string } };
        if (data.question) {
          const item: IeltsQuestionItem = {
            id: data.question.id,
            part: data.question.part,
            textEn: data.question.textEn,
            textZh: data.question.textZh,
            topicTitleZh: data.question.topicZh,
          };
          // Put the random question at top and select it
          setQuestions((prev) => [item, ...prev.filter((q) => q.id !== item.id)]);
          setSelectedId(item.id);
        }
      }
    } catch {
      if (openRef.current && requestId === requestOrder.current) setError("随机题暂不可用，请重试。");
    } finally {
      if (openRef.current && requestId === requestOrder.current) setLoading(false);
    }
  }

  if (!isOpen) return null;

  return (
    <div className="topic-drawer-backdrop" onClick={onClose} role="presentation">
      <div
        ref={panel}
        className="topic-drawer"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="雅思口语题库探讨"
      >
        <div className="topic-drawer-header">
          <div>
            <h3>🎯 雅思口语题库探讨</h3>
            <small>挑选一道雅思真题，与 AI 伙伴展开模拟讨论并学习地道口语表达</small>
          </div>
          <button
            type="button"
            className="drawer-close-btn"
            onClick={onClose}
            aria-label="关闭抽屉"
          >
            ✕
          </button>
        </div>

        {/* Filter Toolbar */}
        {error && <div role="alert"><p>{error}</p><button onClick={() => setReload((n) => n + 1)}>重新加载</button></div>}
        <div className="topic-drawer-toolbar">
          <div className="part-tab-group">
            <button
              type="button"
              className={`part-tab ${partFilter === undefined ? "is-active" : ""}`}
              onClick={() => setPartFilter(undefined)}
            >
              全部 Part
            </button>
            <button
              type="button"
              className={`part-tab ${partFilter === 1 ? "is-active" : ""}`}
              onClick={() => setPartFilter(1)}
            >
              Part 1
            </button>
            <button
              type="button"
              className={`part-tab ${partFilter === 2 ? "is-active" : ""}`}
              onClick={() => setPartFilter(2)}
            >
              Part 2
            </button>
            <button
              type="button"
              className={`part-tab ${partFilter === 3 ? "is-active" : ""}`}
              onClick={() => setPartFilter(3)}
            >
              Part 3
            </button>
          </div>

          <div className="drawer-search-row">
            <input
              aria-label="搜索讨论题目"
              type="text"
              className="drawer-search-input"
              placeholder="搜索题目关键词 (如 study, hometown)..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            <button
              type="button"
              className="secondary-button random-pick-btn"
              onClick={() => void handlePickRandom()}
              disabled={loading}
              title="随机抽一道题目"
            >
              🎲 随机抽题
            </button>
          </div>
        </div>

        {/* Question List */}
        <div className="topic-drawer-list">
          {loading && questions.length === 0 ? (
            <div className="drawer-loading-tip">正在加载雅思题库...</div>
          ) : questions.length === 0 ? (
            <div className="drawer-empty-tip">未找到匹配的题目，尝试换个关键词或筛选选项。</div>
          ) : (
            questions.map((q) => {
              const isSelected = selectedId === q.id;
              return (
                <div
                  key={q.id}
                  className={`topic-question-item ${isSelected ? "is-selected" : ""}`}
                  onClick={() => setSelectedId(q.id)}
                >
                  <div className="topic-item-header">
                    <span className={`part-badge part-${q.part}`}>Part {q.part}</span>
                    {q.topicTitleZh ? (
                      <span className="topic-name-badge">{q.topicTitleZh}</span>
                    ) : null}
                  </div>
                  <p className="topic-item-en" lang="en">
                    {q.textEn}
                  </p>
                  {q.textZh ? <p className="topic-item-zh">{q.textZh}</p> : null}

                  <div className="topic-item-footer">
                    <button
                      type="button"
                      className="primary-button start-topic-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelectTopic(q);
                        onClose();
                      }}
                    >
                      🗣️ 开始讨论这道题
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

