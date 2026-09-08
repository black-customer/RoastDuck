"use client";

import { useEffect, useState } from "react";
import type { InteractiveText } from "@/lib/learning/types";
import { InteractiveEnglishText } from "./InteractiveEnglishText";

type ContextData =
  | {
      kind: "source_neighbors";
      generated: false;
      source: string;
      currentSentenceId: string;
      sentences: Array<{ id: string; seq: number; textZh: string; interactive: InteractiveText }>;
    }
  | {
      kind: "ielts_association";
      generated: true;
      label: "生成例句";
      topics: Array<{ id: string; nameZh: string; nameEn: string }>;
      questions: Array<{
        id: string;
        textZh: string;
        part: number;
        relation: string;
        answerDimensionId: string;
        interactive: InteractiveText;
      }>;
    };

export function ContextPanel({
  contextId,
  onLookup,
  onClose,
}: {
  contextId: string;
  onLookup: (annotationId: string) => void;
  onClose: () => void;
}) {
  const [data, setData] = useState<ContextData | null>(null);
  const [error, setError] = useState("");
  const [loadVersion, setLoadVersion] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setError("");
    fetch(`/api/contexts/${encodeURIComponent(contextId)}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const body = (await response.json()) as ContextData & { error?: string };
        if (!response.ok) throw new Error(body.error || "上下文加载失败");
        setData(body);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "上下文加载失败");
      });
    return () => controller.abort();
  }, [contextId, loadVersion]);

  return (
    <section className="context-panel" aria-label="例句上下文">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-base font-semibold">{data?.kind === "source_neighbors" ? "真实原句上下文" : "IELTS 关联信息"}</h3>
          <p className="mt-1 text-sm text-[var(--muted)]">
            {data?.kind === "source_neighbors"
              ? `来源：${data.source}`
              : "生成例句只展示关联关系，不伪造前后文。"}
          </p>
        </div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="收起上下文">
          <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden="true">
            <path d="m7 7 10 10M17 7 7 17" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {!data && !error ? <div className="mt-5 h-28 animate-pulse rounded-xl bg-white/70" /> : null}
      {error ? (
        <div className="mt-4 text-sm text-[var(--danger)]" role="alert">
          <p>{error}</p>
          <button type="button" className="text-button mt-2" onClick={() => setLoadVersion((value) => value + 1)}>重新加载上下文</button>
        </div>
      ) : null}

      {data?.kind === "source_neighbors" ? (
        <div className="mt-5 space-y-3">
          {data.sentences.map((sentence) => (
            <div
              key={sentence.id}
              className={sentence.id === data.currentSentenceId ? "context-sentence context-sentence-current" : "context-sentence"}
            >
              <InteractiveEnglishText content={sentence.interactive} onLookup={onLookup} className="leading-7" />
              {sentence.textZh ? <p className="mt-1 text-sm text-[var(--muted)]">{sentence.textZh}</p> : null}
            </div>
          ))}
        </div>
      ) : null}

      {data?.kind === "ielts_association" ? (
        <div className="mt-5 space-y-5">
          <div className="flex flex-wrap gap-2">
            <span className="status-chip">生成例句</span>
            {data.topics.map((topic) => <span key={topic.id} className="status-chip">{topic.nameZh || topic.nameEn}</span>)}
          </div>
          {data.questions.length ? (
            <div className="space-y-3">
              {data.questions.slice(0, 4).map((question) => (
                <div key={`${question.id}-${question.relation}`} className="context-sentence">
                  <p className="mb-1 text-xs font-semibold text-[var(--primary-strong)]">IELTS Part {question.part} · 关联题目</p>
                  <InteractiveEnglishText content={question.interactive} onLookup={onLookup} className="leading-7" />
                  {question.answerDimensionId ? (
                    <p className="mt-2 text-xs text-[var(--muted)]">Answer Dimension：{question.answerDimensionId}</p>
                  ) : null}
                </div>
              ))}
            </div>
          ) : <p className="text-sm text-[var(--danger)]">这条例句尚未建立可展示的 IELTS 题目关联。</p>}
        </div>
      ) : null}
    </section>
  );
}
