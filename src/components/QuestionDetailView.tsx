"use client";

import Link from "next/link";
import { useState, useEffect } from "react";
import type { QuestionLearningPack } from "@/lib/questions/learning-pack-service";
import type { QuestionDetail } from "@/lib/questions/service";
import { InteractiveEnglishText } from "./InteractiveEnglishText";
import { LookupCard } from "./LookupCard";
import {SpeakButton} from './SpeakButton';

const GAP_LABELS: Record<string, string> = {
  lexical_gap: "词汇与搭配",
  grammar_construction: "语法构式",
  discourse_gap: "组织与连贯",
  question_understanding: "题意理解",
  content_gap: "内容展开",
  asr_uncertain: "转写待确认",
  pronunciation_unknown: "发音未知",
};

export function QuestionDetailView({ question, learningPack }: { question: QuestionDetail; learningPack: QuestionLearningPack | null;allowLightStudy?:boolean }) {
  const currentPractice=learningPack?.currentPractice;
  const [lookupId, setLookupId] = useState<string | null>(null);
  const [favorite, setFavorite] = useState(question.favorite);
  const [favoriteBusy, setFavoriteBusy] = useState(false);
  const [error, setError] = useState("");
  const [speakingAttempts, setSpeakingAttempts] = useState<Array<{
    id: string;
    mode: "practice" | "exam_style";
    gapCount: number;
    attemptNumber: number;
    createdAt: string;
    naturalVersion: string;
  }>>([]);

  useEffect(() => {
    void fetch(`/api/speaking-practice/questions/${encodeURIComponent(question.id)}/attempts`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.attempts) setSpeakingAttempts(data.attempts);
      })
      .catch(() => {});
  }, [question.id]);

  async function toggleFavorite() {
    setFavoriteBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/questions/${encodeURIComponent(question.id)}/favorite`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ favorite: !favorite }),
      });
      const body = (await response.json()) as { favorite?: boolean; error?: string };
      if (!response.ok || typeof body.favorite !== "boolean") throw new Error(body.error || "收藏状态保存失败");
      setFavorite(body.favorite);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "收藏状态保存失败");
    } finally {
      setFavoriteBusy(false);
    }
  }

  return (
    <div className="question-shell">
      <div className="question-detail-frame">
        <header className="question-header">
          <Link href="/questions" className="exit-button">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="h-5 w-5"><path d="m15 18-6-6 6-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
            返回题库
          </Link>
          <button type="button" className="question-favorite-button" aria-pressed={favorite} disabled={favoriteBusy} onClick={() => void toggleFavorite()}>
            <svg viewBox="0 0 24 24" fill={favorite ? "currentColor" : "none"} aria-hidden="true" className="h-5 w-5"><path d="m12 4 2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.5-4.8 2.5.9-5.4-3.9-3.8 5.4-.8L12 4Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /></svg>
            {favorite ? "已收藏" : "收藏"}
          </button>
        </header>

        {error ? <div className="error-banner" role="alert"><span>{error}</span><button type="button" onClick={() => setError("")}>关闭</button></div> : null}

        <article className="question-detail-hero">
          <div className="question-detail-meta">
            <span>IELTS Speaking · Part {question.part}</span>
            <span>{question.topicZh || question.topicEn || "未分类话题"}</span>
            <span>{learningPack?.summary.answerCount ? `已保存 ${learningPack.summary.answerCount} 次回答` : "还没答过"}</span>
          </div>
          {question.textEn.trim() ? <InteractiveEnglishText content={question.interactiveQuestion} onLookup={setLookupId} className="question-detail-title" role="heading" aria-level={1} /> : <h1 className="question-detail-title">历史回答 · 原始问句缺失</h1>}
          <p className="question-detail-translation">{question.textZh || "中文题干正在补全；你仍可直接使用英文原题开始回答。"}</p>
          <div className="question-detail-actions">
            {learningPack?.primaryAction.href ? (
              <Link href={learningPack.primaryAction.href} className="primary-button">{learningPack.primaryAction.label}</Link>
            ) : question.answerHistory.length ? (
              <span className="primary-button is-disabled" aria-disabled="true">{learningPack?.primaryAction.label ?? "分析中"}</span>
            ) : (
              <Link href={`/questions/${encodeURIComponent(question.id)}/practice`} className="primary-button">开始回答这道题</Link>
            )}
            {currentPractice&&!learningPack?.primaryAction.href?.includes('kind=independent')&&<Link href={`/questions/${question.id}/practice?kind=independent&source=${currentPractice.attemptId}`} className="secondary-button">不看提示，重新回答</Link>}
            {!!learningPack?.summary.requiredTotal&&!learningPack.primaryAction.href?.startsWith('/light-study')&&<Link href={`/light-study?scope=question&id=${question.id}`} className="secondary-button">轻松学本题</Link>}
            {currentPractice&&<Link href={`/quick-review?scope=question&id=${question.id}`} className="secondary-button">快速回顾本题</Link>}
            {!!learningPack?.summary.dueCount&&<Link href={`/light-study?scope=question&id=${question.id}&mode=review`} className="secondary-button">复习本题到期表达（{learningPack.summary.dueCount}）</Link>}
            {speakingAttempts.length > 0 ? (
              <Link href={`/questions/${encodeURIComponent(question.id)}/attempts/${encodeURIComponent(speakingAttempts[0].id)}`} className="secondary-button">
                查看最近回答材料
              </Link>
            ) : null}
            <SpeakButton text={question.textEn} label="播放题目"/>
          </div>
        </article>

        {speakingAttempts.length > 0 || learningPack?.answers.length ? (
          <nav className="question-section-nav" aria-label="题目学习包目录">
            {speakingAttempts.length > 0 ? <a href="#speaking-attempts">作答尝试 ({speakingAttempts.length})</a> : null}
            <a href="#my-answers">我的回答</a>
            <a href="#gap-ledger">问题账本</a>
            <a href="#learning-units">本题要学</a>
            <a href="#reattempt-history">重答与对比</a>
            <a href="#question-sources">题目与来源</a>
          </nav>
        ) : null}

        <div className="question-detail-grid">
          {speakingAttempts.length > 0 ? (
            <section id="speaking-attempts" className="question-detail-section question-detail-personal">
              <div className="question-section-heading">
                <div>
                  <h2>作答尝试记录 (Speaking Attempts)</h2>
                  <p>每次重答生成独立尝试，不覆盖历史，逐步消灭 Gap。</p>
                </div>
                <span>{speakingAttempts.length} 次尝试</span>
              </div>
              <ol className="question-answer-history">
                {speakingAttempts.map((att) => (
                  <li key={att.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px" }}>
                    <div>
                      <strong>
                        #{att.attemptNumber} {att.mode === "exam_style" ? "考场模拟 (Exam-style)" : "练习模式 (Practice)"}
                      </strong>
                      <span style={{ marginLeft: "12px", color: att.gapCount === 0 ? "var(--success, #16a34a)" : "var(--primary)" }}>
                        {att.gapCount} gaps
                      </span>
                      <small style={{ display: "block", color: "var(--muted)", marginTop: "4px" }}>
                        {new Date(att.createdAt).toLocaleString("zh-CN")}
                      </small>
                    </div>
                    <Link
                      href={`/questions/${encodeURIComponent(question.id)}/attempts/${encodeURIComponent(att.id)}`}
                      className="question-open-link"
                    >
                      查看诊断与训练 →
                    </Link>
                  </li>
                ))}
              </ol>
            </section>
          ) : null}
          {learningPack && (["analysis_pending", "analysis_failed", "materials_pending"] as string[]).includes(learningPack.state as string) ? (
            <section id="processing-status" className="question-detail-section question-detail-personal" role="status">
              <h2>{question.stateLabel}</h2>
              <p>{(learningPack.state as string) === "analysis_pending" ? "回答已保存，正在处理学习材料。可以稍后刷新查看。"
                : (learningPack.state as string) === "analysis_failed" ? "材料处理没有完成，原始回答仍完整保留。回到处理位置可以查看原因并重试。"
                : "回答已保留，相关表达仍在整理或复核中。通过后可以直接轻松学，不需要逐条批准。"}</p>
              {(learningPack.state as string) === "analysis_failed" && learningPack.processing.retryHref ? <Link className="secondary-button" href={learningPack.processing.retryHref}>返回处理位置</Link> : null}
            </section>
          ) : null}
          <section id="question-sources" className="question-detail-section">
            <h2>题目来源</h2>
            <p>{question.sources.length ? "来源链接指向原始文件与页码，同题跨季度时完整保留。" : "当前没有可验证的原始文件页码。历史导入材料保存在本机，不冒充公开题库来源。"}</p>
            <ul className="question-source-list">
              {question.sources.map((source) => (
                <li key={`${source.slug}-${source.page}`}>
                  <div><strong>{source.setName}</strong><span>{source.file}</span></div>
                  <a href={`/api/question-sources/${encodeURIComponent(source.slug)}#page=${source.page}`} target="_blank" rel="noreferrer">打开第 {source.page} 页</a>
                </li>
              ))}
            </ul>
          </section>

          {!currentPractice && question.publicChunks.length>0 && <section className="question-detail-section">
            <h2>可借用的公共表达</h2>
            <p>只展示已经通过独立审核并与这道题建立关联的内容。</p>
            {question.publicChunks.length ? (
              <ul className="question-chunk-list">
                {question.publicChunks.map((chunk) => (
                  <li key={chunk.id}>
                    <Link href={`/chunks/${encodeURIComponent(chunk.id)}`} lang="en">{chunk.display}</Link>
                    <span>{chunk.meaningZh}</span>
                    {chunk.ipa ? <small lang="en">/{chunk.ipa.replace(/^\/+|\/+$/g, "")}/</small> : null}
                  </li>
                ))}
              </ul>
            ) : (
              <div className="question-inline-empty">这道题关联的公共 Chunk 尚未通过发布闸门；不会用未审核内容凑数。</div>
            )}
          </section>}

          <section id="my-answers" className="question-detail-section question-detail-personal">
            <div className="question-section-heading">
              <div><h2>我的回答</h2><p>每次回答独立保存；原始转写不会被覆盖。</p></div>
              {learningPack ? <span>{learningPack.summary.answerCount} 次</span> : null}
            </div>
            {currentPractice ? <p>上方作答记录保留每次尝试。<Link href={currentPractice.href} className="question-open-link">查看本次原回答与四列材料 →</Link></p> : learningPack?.answers.length ? (
              <ol className="question-answer-history">
                {learningPack.answers.map((answer) => (
                  <li key={answer.id}>
                    <details>
                      <summary>
                        <span><strong>第 {answer.attemptOrder} 次 · {answer.inputLanguage === "zh" ? "中文" : answer.inputLanguage === "en" ? "英文" : "中英混合"}</strong><small>{new Date(answer.createdAt).toLocaleString("zh-CN")} · {answer.gapCount} 个问题</small></span>
                        <span>展开原文</span>
                      </summary>
                      <p lang={answer.inputLanguage === "zh" ? "zh-CN" : "en"}>{answer.rawText}</p>
                    </details>
                    <Link href={`/answer-studio/${encodeURIComponent(answer.id)}`} className="question-open-link">查看版本</Link>
                  </li>
                ))}
              </ol>
            ) : (
              <div className="question-personal-empty"><div><strong>从第一版答案开始</strong><span>中文、英文或中英混合都可以，系统先保存原文再分析。</span></div><Link href={`/answer-studio?question=${encodeURIComponent(question.id)}`} className="question-open-link">去回答</Link></div>
            )}
          </section>

          <section id="gap-ledger" className="question-detail-section question-detail-personal">
            <div className="question-section-heading">
              <div><h2>问题账本</h2><p>记录所有可确认问题；只有适合训练的高价值表达才进入学习队列。</p></div>
              {learningPack ? <span>{learningPack.summary.openGapCount} 个待处理</span> : null}
            </div>
            {currentPractice ? (currentPractice.ledger.length ? <ol className="question-gap-list">{currentPractice.ledger.map(unit=><li key={unit.id}>
              <strong>{unit.status==="uncertain"?"待确认（不训练）":"本次表达问题"} · {unit.intentZh}</strong>
              {unit.evidence && <p className="question-gap-evidence" lang="en">{unit.evidence}</p>}<p>{unit.reasonZh}</p>
            </li>)}</ol> : <p>{currentPractice.status==="ready"?"本次没有确认需要强化的问题；这不代表已经长期掌握。":"本次诊断尚未完成，原回答已保存。"}</p>) : learningPack?.gaps.length ? (
              <ol className="question-gap-list">
                {learningPack.gaps.map((gap) => (
                  <li key={gap.id}>
                    <div className="question-gap-meta"><span>{GAP_LABELS[gap.type] ?? gap.type}</span><span>{gap.impactLevel === "high" ? "高影响" : gap.impactLevel === "medium" ? "中影响" : "低影响"}</span>{gap.occurrenceCount > 1 ? <span>已出现 {gap.occurrenceCount} 次</span> : null}</div>
                    <p className="question-gap-evidence" lang="en">{gap.evidenceText}</p>
                    {gap.recommendedExpression ? <p><strong lang="en">{gap.recommendedExpression}</strong><span>{gap.explanationZh}</span></p> : <p><span>{gap.explanationZh}</span></p>}
                    {!gap.learningFit ? <small>由 AI 老师追问或讲解，不制作成 Chunk。</small> : null}
                  </li>
                ))}
              </ol>
            ) : <div className="question-inline-empty">还没有可展示的诊断；分析完成后会在这里展示经过复核的问题。</div>}
          </section>

          <section id="learning-units" className="question-detail-section question-detail-personal">
            <div className="question-section-heading">
              <div><h2>本题要学</h2><p>来自当前回答的真实缺口。轻松学后安排复习；四步强化是可选练习。</p></div>
              {learningPack ? <span>{learningPack.summary.requiredCompleted} / {learningPack.summary.requiredTotal} 已完成首轮</span> : null}
            </div>
            {currentPractice ? (currentPractice.rows.length ? <ol className="question-learning-list">{currentPractice.rows.map((row,index)=><li key={row.gapId??index}>
              <div><Link href={currentPractice.href} lang="en">{row.englishChunk}</Link><span>{row.chineseChunk}</span></div>
              <div className="question-unit-status"><span>{currentPractice.completed?"已过首轮，等待复习":"按你的节奏学几个"}</span></div>
            </li>)}</ol> : <div className="question-inline-empty">{currentPractice.status==="ready"?"本次审核没有确认必练项，可以继续作答；未确认片段不会被强行制卡。":"本次材料处理尚未完成，请通过上方入口查看状态。"}</div>) : learningPack?.units.length ? (
              <ol className="question-learning-list">
                {learningPack.units.map((unit) => (
                  <li key={unit.id}>
                    <div><Link href={`/chunks/${encodeURIComponent(unit.chunkId)}`} lang="en">{unit.display}</Link><span>{unit.meaningZh}</span>{unit.ipa ? <small lang="en">/{unit.ipa.replace(/^\/+|\/+$/g, "")}/</small> : null}</div>
                    <div className="question-unit-status"><span>{unit.requirement === "required" ? "必学" : "提升"}</span><span>{unit.firstRoundCompletedAt ? "首轮完成" : "待学习"}</span><small>{unit.scenarioKinds.includes("common_usage") && unit.scenarioKinds.includes("question_repair") ? "双语境就绪" : "语境待补"}</small></div>
                  </li>
                ))}
              </ol>
            ) : <div className="question-inline-empty">{learningPack?.summary.answerCount?"历史回答材料尚未接通。":"先保存英文回答和中文原意，再生成本次学习材料。"}</div>}
            {learningPack?.primaryAction.href ? <Link href={learningPack.primaryAction.href} className="primary-button question-pack-action">{learningPack.primaryAction.label}</Link> : null}
          </section>
          <section id="reattempt-history" className="question-detail-section question-detail-personal">
            <h2>重答与前后对比</h2>
            <p>已完成 {learningPack?.reattemptCount ?? 0} 次重答。没有再次提到旧错误，不代表已经掌握。</p>
            {learningPack?.reattempts.length ? learningPack.reattempts.map((attempt) => (
              <article key={attempt.id} className="question-reattempt">
                <h3>{new Date(attempt.completedAt).toLocaleString("zh-CN")} 的回答</h3>
                <details><summary>展开本次原文</summary><p>{attempt.rawText}</p></details>
                {attempt.comparisons.length ? <ul className="question-gap-list">{attempt.comparisons.map((comparison, index) => (
                  <li key={index}>
                    <strong>{{ improved: "已改善", repeated: "仍重复", new: "新出现", uncertain: "不确定" }[comparison.comparison] ?? "待确认"}</strong>
                    {comparison.previousEvidence ? <p>之前：{comparison.previousEvidence}</p> : null}
                    <p>证据：{comparison.evidence}</p><p>{comparison.reason}</p>
                    {comparison.expression ? <p lang="en">{comparison.expression}</p> : null}
                  </li>
                ))}</ul> : <p>本次没有可展示的差异结论，可先回看回答版本。</p>}
                <Link href={`/answer-studio/${encodeURIComponent(attempt.answerId)}`} className="text-button">查看回答版本</Link>
              </article>
            )) : <p>学完本题的必学表达后，回来试着独立回答一次。</p>}
          </section>
        </div>
      </div>
      <LookupCard annotationId={lookupId} onClose={() => setLookupId(null)} />
    </div>
  );
}
