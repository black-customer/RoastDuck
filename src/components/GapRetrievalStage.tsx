"use client";

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { LearningStep, RetrievalVerdict } from "@/lib/learning/types";
import { SpeakButton } from "./SpeakButton";

const retrievalTypes = new Set([
  "retrieval_prompt",
  "review_prompt",
  "retrieval_judgement",
  "review_judgement",
  "comparison",
  "adaptive_instruction",
  "repair_instruction",
  "active_recall",
  "transfer_recall",
  "repair_recall",
  "transfer_retry",
]);

export function isGapRetrievalStep(step: LearningStep): boolean {
  return retrievalTypes.has(step.type);
}

const verdictCopy: Record<RetrievalVerdict, { title: string; tone: string }> = {
  natural_equivalent: { title: "你已经能表达这个意思", tone: "success" },
  context_difference: { title: "意思接近，但场景有差异", tone: "context" },
  incorrect: { title: "先修复一个最关键的问题", tone: "repair" },
  uncertain: { title: "这次不确定，不会按错误结算", tone: "neutral" },
  unknown: { title: "不会也没关系，现在把它学会", tone: "repair" },
};

function SceneCue({ scene, transfer = false }: {
  scene: { settingZh: string; relationshipZh: string; purposeZh: string; promptZh: string; intentZh: string };
  transfer?: boolean;
}) {
  return (
    <div className="retrieval-cue">
      <div className="retrieval-cue-heading">
        <span aria-hidden="true">{transfer ? <svg viewBox="0 0 24 24"><path d="M6 17 17 6m-7 0h7v7" /></svg> : <svg viewBox="0 0 24 24"><path d="M7 9h4v4H7V9Zm6 0h4v4h-4V9Z" /></svg>}</span>
        <strong>{transfer ? "换一个场景" : "具体语境"}</strong>
      </div>
      <h2>{scene.settingZh}</h2>
      <dl>
        <div><dt>你和谁说</dt><dd>{scene.relationshipZh}</dd></div>
        <div><dt>为什么说</dt><dd>{scene.purposeZh}</dd></div>
      </dl>
      <blockquote>{scene.promptZh}</blockquote>
      <p><strong>你想表达：</strong>{scene.intentZh}</p>
    </div>
  );
}

function RetrievalComposer({
  step,
  busy,
  onEvent,
}: {
  step: Extract<LearningStep, { type: "retrieval_prompt" | "review_prompt" | "active_recall" | "transfer_recall" | "repair_recall" | "transfer_retry" }>;
  busy: boolean;
  onEvent: (event: Record<string, unknown>) => Promise<unknown>;
}) {
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const transfer = step.type === "transfer_recall" || step.type === "transfer_retry";
  const submitType = transfer ? "submit_transfer" : "submit_retrieval";
  const isReview = step.type === "review_prompt";

  useEffect(() => { inputRef.current?.focus(); }, []);

  const submit = () => {
    if (!draft.trim() || busy) return;
    void onEvent({ type: submitType, input: draft.trim() });
  };

  return (
    <>
      <SceneCue scene={step.scene} transfer={transfer} />
      {"feedbackZh" in step && step.feedbackZh ? (
        <div className="retrieval-feedback" role="alert">
          <strong>还没有完全匹配这个场景</strong>
          <p>{step.feedbackZh}</p>
        </div>
      ) : null}
      {"assistText" in step && step.assistText ? <div className="retrieval-assist" role="status">{step.assistText}</div> : null}
      <div className="retrieval-composer">
        <label htmlFor={`retrieval-input-${step.sessionId}-${step.stepVersion}`}>
          {isReview ? "先从记忆里写出英文" : transfer ? "在这个新场景里，你会怎么说？" : "你会怎么用英文表达？"}
        </label>
        <textarea
          ref={inputRef}
          id={`retrieval-input-${step.sessionId}-${step.stepVersion}`}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
              event.preventDefault();
              submit();
            }
          }}
          placeholder="放心写完整句，也可以只写你想提取的表达"
          rows={4}
          disabled={busy}
          autoComplete="off"
          spellCheck
          lang="en"
        />
        <div className="retrieval-input-meta">
          <span>{step.inputHint}</span>
          <kbd>Ctrl + Enter</kbd>
        </div>
        <div className="retrieval-actions">
          <button type="button" className="text-button" disabled={busy} onClick={() => void onEvent({ type: "mark_unknown" })}>不会，直接教我</button>
          {"assistLevel" in step ? (
            <button type="button" className="secondary-button" disabled={busy || step.assistLevel >= 4} onClick={() => void onEvent({ type: "request_assist", assist: "hint" })}>
              {step.assistLevel >= 4 ? "已显示完整答案" : "给我一点提示"}
            </button>
          ) : null}
          <button type="button" className="primary-button" disabled={busy || !draft.trim()} onClick={submit}>{busy ? "正在判断…" : isReview ? "检查这次复习" : "看看是否自然"}</button>
        </div>
      </div>
    </>
  );
}

export function GapRetrievalStage({
  step,
  busy,
  headingRef,
  onEvent,
}: {
  step: LearningStep;
  busy: boolean;
  headingRef: RefObject<HTMLHeadingElement | null>;
  onEvent: (event: Record<string, unknown>) => Promise<unknown>;
}) {
  const title = useMemo(() => {
    if (step.type === "review_prompt") return "先测试，不要先看答案";
    if (step.type === "retrieval_prompt") return "把你真正想说的话提取出来";
    if (step.type === "active_recall" || step.type === "repair_recall") return "遮住英文，再提取一次";
    if (step.type === "transfer_recall" || step.type === "transfer_retry") return "换个场景，确认你真的会用";
    return "正在判断你的表达";
  }, [step.type]);

  if (["retrieval_prompt", "review_prompt", "active_recall", "transfer_recall", "repair_recall", "transfer_retry"].includes(step.type)) {
    const inputStep = step as Extract<LearningStep, { type: "retrieval_prompt" | "review_prompt" | "active_recall" | "transfer_recall" | "repair_recall" | "transfer_retry" }>;
    return (
      <section className="stage-content retrieval-stage stage-enter" aria-labelledby="retrieval-stage-title">
        <div className="stage-copy">
          <h1 ref={headingRef} tabIndex={-1} id="retrieval-stage-title" className="stage-title">{title}</h1>
          <p className="stage-description">{step.type === "review_prompt" ? "每次复习都从真实提取开始。答对会快速结束；只有失败才重新教学。" : step.type.includes("transfer") ? "不要求背同一句话；请在新情境中自然完成同一个表达功能。" : "这里没有错误英文或标准答案。先试着说，想不起来可以直接点“不会，直接教我”。"}</p>
        </div>
        <RetrievalComposer key={`${inputStep.type}-${inputStep.stepVersion}`} step={inputStep} busy={busy} onEvent={onEvent} />
      </section>
    );
  }

  if (step.type === "retrieval_judgement" || step.type === "review_judgement") {
    return (
      <section className="stage-content retrieval-stage retrieval-waiting stage-enter" aria-labelledby="retrieval-judgement-title" aria-busy={step.status === "judging"}>
        <div className={step.status === "failed" ? "retrieval-status-mark is-error" : "retrieval-status-mark"} aria-hidden="true">
          {step.status === "failed" ? <svg viewBox="0 0 24 24"><path d="M12 7v6m0 4h.01" /></svg> : <span><i /><i /><i /></span>}
        </div>
        <h1 ref={headingRef} tabIndex={-1} id="retrieval-judgement-title" className="stage-title text-center">{step.status === "failed" ? "这次没有判定结果" : "Chloe 正在听懂你真正想说什么"}</h1>
        <p className="retrieval-submitted" lang="en">{step.userExpression}</p>
        <p className="stage-description text-center" role={step.status === "failed" ? "alert" : "status"}>{step.message}</p>
        {step.status === "failed" ? (
          <div className="retrieval-actions is-centered">
            <button type="button" className="secondary-button" disabled={busy} onClick={() => void onEvent({ type: "retry_judgement" })}>重试判定</button>
            <button type="button" className="primary-button" disabled={busy} onClick={() => void onEvent({ type: "continue_instruction" })}>先看教学，不把这次判错</button>
          </div>
        ) : null}
      </section>
    );
  }

  if (step.type === "comparison") {
    const copy = verdictCopy[step.verdict];
    return (
      <section className="stage-content retrieval-stage stage-enter" aria-labelledby="retrieval-comparison-title">
        <div className="retrieval-verdict" data-tone={copy.tone}>
          <span aria-hidden="true">{step.verdict === "natural_equivalent" ? <svg viewBox="0 0 24 24"><path d="m6.5 12.5 3.5 3.5 7.5-8" /></svg> : step.verdict === "context_difference" ? <svg viewBox="0 0 24 24"><path d="M5 9h14M5 15h14" /></svg> : <svg viewBox="0 0 24 24"><path d="M5 12h14m-5-5 5 5-5 5" /></svg>}</span>
          <h1 ref={headingRef} tabIndex={-1} id="retrieval-comparison-title" className="stage-title">{copy.title}</h1>
          <p>{step.explanationZh}</p>
        </div>
        <div className="retrieval-comparison">
          <div>
            <span>你的表达</span>
            <p lang="en">{step.userExpression || "这次选择了“不会”"}</p>
            {step.userExpression ? <SpeakButton text={step.userExpression} lang="en-US" size="md" /> : null}
          </div>
          <div>
            <span>推荐表达</span>
            <p lang="en">{step.recommendedExpression}</p>
            <SpeakButton text={step.recommendedExpression} lang="en-US" size="md" />
          </div>
        </div>
        {step.registerDifference || step.frequencyDifference ? (
          <div className="retrieval-nuance">
            {step.registerDifference ? <p><strong>使用场合：</strong>{step.registerDifference}</p> : null}
            {step.frequencyDifference ? <p><strong>常用程度：</strong>{step.frequencyDifference}</p> : null}
          </div>
        ) : null}
        <button type="button" className="primary-button w-full" disabled={busy} onClick={() => void onEvent({ type: "continue_comparison" })}>{step.detailCollapsed ? "看一眼用法，再去迁移" : "把这个表达学明白"}</button>
      </section>
    );
  }

  if (step.type === "adaptive_instruction" || step.type === "repair_instruction") {
    return (
      <section className="stage-content retrieval-stage stage-enter" aria-labelledby="retrieval-instruction-title">
        <div className="stage-copy">
          <h1 ref={headingRef} tabIndex={-1} id="retrieval-instruction-title" className="stage-title">{step.detailMode === "compact" ? "精简确认一下用法" : "只修复现在最需要的一点"}</h1>
          <p className="stage-description">理解后马上重新提取，不把时间花在被动浏览上。跟读是可选的，不影响完成。</p>
        </div>
        <div className="retrieval-expression">
          <div><p lang="en">{step.chunk.display}</p><span>{step.chunk.ipa ? `/${step.chunk.ipa.replace(/^\/+|\/+$/g, "")}/` : "音标待补充"} · {step.chunk.accent}</span></div>
          <SpeakButton text={step.chunk.display} lang="en-US" size="lg" />
          <strong>{step.chunk.meaningZh}</strong>
          {step.chunk.pattern ? <p><span>Pattern</span>{step.chunk.pattern}</p> : null}
        </div>
        <details className="retrieval-teaching" open={step.detailMode === "expanded"}>
          <summary>{step.detailMode === "compact" ? "查看完整讲解（可选）" : "为什么这样表达"}</summary>
          <p>{step.keyExplanationZh}</p>
          <div><span>原回答中暴露的问题</span><p lang="en">{step.commonMistake}</p></div>
        </details>
        <div className="retrieval-scene-pair">
          <article><span>回到原题</span><p>{step.originalScene.settingZh} · {step.originalScene.purposeZh}</p><strong lang="en">{step.originalScene.targetTextEn}</strong><small>{step.originalScene.targetTextZh}</small></article>
          <article><span>日常迁移</span><p>{step.transferScene.settingZh} · {step.transferScene.purposeZh}</p><strong lang="en">{step.transferScene.targetTextEn}</strong><small>{step.transferScene.targetTextZh}</small></article>
        </div>
        <details className="retrieval-shadowing">
          <summary>想先跟读一次？（完全可选）</summary>
          <div><SpeakButton text={step.chunk.display} lang="en-US" size="md" /><p>只播放自然美式英语；此处不请求麦克风，也不影响学习结算。</p></div>
        </details>
        <button type="button" className="primary-button w-full" disabled={busy} onClick={() => void onEvent({ type: "continue_instruction" })}>{step.next === "transfer_recall" ? "直接换场景试用" : "遮住英文，马上再说一次"}</button>
      </section>
    );
  }

  return null;
}
