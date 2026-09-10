"use client";

import Link from "next/link";
import { useState, useEffect } from "react";
import type { QuestionLearningPack } from "@/lib/questions/learning-pack-service";
import type { QuestionDetail } from "@/lib/questions/service";
import { InteractiveEnglishText } from "./InteractiveEnglishText";
import { LookupCard } from "./LookupCard";
import {SpeakButton} from './SpeakButton';
import styles from './QuestionViews.module.css';

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
  const [historyError, setHistoryError] = useState("");
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyReload, setHistoryReload] = useState(0);
  const [speakingAttempts, setSpeakingAttempts] = useState<Array<{
    id: string;
    mode: "practice" | "exam_style";
    gapCount: number;
    attemptNumber: number;
    createdAt: string;
    naturalVersion: string;
  }>>([]);

  useEffect(() => {
    const controller = new AbortController();
    setHistoryLoading(true); setHistoryError("");
    void fetch(`/api/speaking-practice/questions/${encodeURIComponent(question.id)}/attempts`, {signal:controller.signal})
      .then(async response => { if (!response.ok) throw new Error("历史回答暂时无法读取"); return response.json(); })
      .then(data => { if (!controller.signal.aborted && data?.attempts) setSpeakingAttempts(data.attempts); })
      .catch(() => { if (!controller.signal.aborted) setHistoryError("历史回答暂时无法读取，已保存的内容仍保留。"); })
      .finally(() => { if (!controller.signal.aborted) setHistoryLoading(false); });
    return () => controller.abort();
  }, [question.id, historyReload]);

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

  const primaryAction=learningPack?.primaryAction??question.primaryAction;
  const latestAttempt=speakingAttempts[0];
  const latestHref=currentPractice?.href??(latestAttempt?`/questions/${encodeURIComponent(question.id)}/attempts/${encodeURIComponent(latestAttempt.id)}`:null);
  const answerCount=learningPack?.summary.answerCount??question.answerCount;
  const questionHref=`/questions/${encodeURIComponent(question.id)}`;
  const hasSecondaryActions=!!currentPractice||!!learningPack?.summary.requiredTotal||!!learningPack?.summary.dueCount;

  return (
    <div className="question-shell">
      <div className="question-detail-frame">
        <header className="question-header">
          <Link href="/questions" className="exit-button"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="h-5 w-5"><path d="m15 18-6-6 6-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>返回题库</Link>
          <button type="button" className={`question-favorite-button ${styles.favoriteButton}`} aria-pressed={favorite} disabled={favoriteBusy} onClick={()=>void toggleFavorite()}><svg viewBox="0 0 24 24" fill={favorite?"currentColor":"none"} aria-hidden="true" className="h-5 w-5"><path d="m12 4 2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.5-4.8 2.5.9-5.4-3.9-3.8 5.4-.8L12 4Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /></svg>{favorite?"已收藏":"收藏"}</button>
        </header>
        {error&&<div className="error-banner" role="alert"><span>{error}</span><button type="button" onClick={()=>setError("")}>关闭提示</button></div>}

        <article className={`question-detail-hero ${styles.hero}`}>
          <div className="question-detail-meta"><span>Part {question.part}</span><span>{question.topicZh||question.topicEn||"未标注话题"}</span><span>{question.stateLabel}</span></div>
          {question.textEn.trim()?<InteractiveEnglishText content={question.interactiveQuestion} onLookup={setLookupId} className={`question-detail-title ${styles.title}`} role="heading" aria-level={1}/>:<h1 className={`question-detail-title ${styles.title}`}>历史回答 · 原始问句缺失</h1>}
          <p className="question-detail-translation">{question.textZh||"此题暂缺中文题干，可以直接使用英文原题。"}</p>
          <div className={styles.primaryActions}>
            {primaryAction.href?<Link href={primaryAction.href} className="primary-button">{primaryAction.label}</Link>:<span className={styles.inactiveAction}>{primaryAction.label}</span>}
            <SpeakButton text={question.textEn} label="播放题目"/>
          </div>
          {hasSecondaryActions&&<details className={styles.moreActions}><summary>更多练习与回顾</summary><div className={styles.secondaryActions}>
            {currentPractice&&!primaryAction.href?.includes('kind=independent')&&<Link href={`${questionHref}/practice?kind=independent&source=${encodeURIComponent(currentPractice.attemptId)}`} className="secondary-button">不看提示，重新回答</Link>}
            {!!learningPack?.summary.requiredTotal&&!primaryAction.href?.startsWith('/light-study')&&<Link href={`/light-study?scope=question&id=${encodeURIComponent(question.id)}&mode=learn`} className="secondary-button">轻松学本题</Link>}
            {currentPractice&&<Link href={`/quick-review?scope=question&id=${encodeURIComponent(question.id)}`} className="secondary-button">快速回顾本题</Link>}
            {!!learningPack?.summary.dueCount&&<Link href={`/light-study?scope=question&id=${encodeURIComponent(question.id)}&mode=review`} className="secondary-button">复习本题到期表达（{learningPack.summary.dueCount}）</Link>}
          </div></details>}
        </article>

        <div className={styles.detailSections}>
          <section id="my-answers" className="question-detail-section">
            <div className="question-section-heading"><div><h2>{answerCount?"最近的回答":"从第一版回答开始"}</h2><p>{answerCount?`已保存 ${answerCount} 次回答，原回答与旧版本都保留。`:"中文、英文或混合都可以，先写下你想表达的意思。"}</p></div></div>
            {latestHref?<div className={styles.recentAnswer}>
              {currentPractice&&<p>{currentPractice.status==="ready"?`最近一份材料整理了 ${currentPractice.rows.length} 个表达。`:"原回答已保存，可以查看材料的处理进度。"}</p>}
              <Link href={latestHref} className="secondary-button">查看原回答与材料</Link>
            </div>:!answerCount?<Link href={primaryAction.href??`${questionHref}/practice`} className="question-open-link">开始回答</Link>:<p>{historyLoading?"正在读取最近的回答…":"展开下方记录，查看已保存的原回答。"}</p>}
            {historyError&&<div className={styles.historyError} role="alert"><p>{historyError}</p><button type="button" className="secondary-button" onClick={()=>setHistoryReload(value=>value+1)}>重新读取历史</button></div>}
          </section>

          {learningPack&&["analysis_pending","analysis_failed","materials_pending"].includes(learningPack.state)&&<section id="processing-status" className="question-detail-section" role="status">
            <h2>{question.stateLabel}</h2><p>{learningPack.state==="analysis_pending"?"回答已保存，正在处理学习材料。可以稍后回来查看。":learningPack.state==="analysis_failed"?"材料处理没有完成，原回答仍完整保留。可以回到处理位置查看原因并重试。":"回答已保留，相关表达仍在整理或审核。通过后可以直接轻松学。"}</p>
            {learningPack.state==="analysis_failed"&&learningPack.processing.retryHref&&<Link className="secondary-button" href={learningPack.processing.retryHref}>返回处理位置</Link>}
          </section>}

          {answerCount>0&&<section id="learning-units" className="question-detail-section">
            <div className="question-section-heading"><div><h2>本题的学习表达</h2><p>来自当前已审核材料。可以先轻松学，四步强化按需选择。</p></div>{learningPack&&<span>{learningPack.summary.requiredCompleted} / {learningPack.summary.requiredTotal} 已过首轮</span>}</div>
            {currentPractice?(currentPractice.rows.length?<ol className="question-learning-list">{currentPractice.rows.map((row,index)=><li key={row.gapId??index}><div><Link href={currentPractice.href} lang="en">{row.englishChunk}</Link><span>{row.chineseChunk}</span></div></li>)}</ol>:<div className="question-inline-empty">{currentPractice.status==="ready"?"本次没有确认的学习表达，可以继续聊新的内容。未确认的意思仍保留在说明里。":"这份材料还未准备好，请通过上方入口查看状态。"}</div>):learningPack?.units.length?<ol className="question-learning-list">{learningPack.units.map(unit=><li key={unit.id}><div><Link href={`/chunks/${encodeURIComponent(unit.chunkId)}`} lang="en">{unit.display}</Link><span>{unit.meaningZh}</span>{unit.ipa&&<small lang="en">/{unit.ipa.replace(/^\/+|\/+$/g,"")}/</small>}</div><div className="question-unit-status"><span>{unit.requirement==="required"?"原学习项":"可选提升"}</span><span>{unit.firstRoundCompletedAt?"历史首轮已完成":"待学习"}</span></div></li>)}</ol>:<div className="question-inline-empty">已有回答材料尚未准备好，请先查看最近的回答。</div>}
          </section>}

          {(speakingAttempts.length>0||!!learningPack?.answers.length)&&<details id="speaking-attempts" className={`question-detail-section ${styles.fold}`}><summary>全部回答记录</summary>
            {speakingAttempts.length>0&&<ol className="question-answer-history">{speakingAttempts.map(attempt=><li key={attempt.id} className={styles.attemptRow}><div><strong>第 {attempt.attemptNumber} 次 · {attempt.mode==="exam_style"?"独立作答":"练习回答"}</strong><span className={styles.attemptCount}>{attempt.gapCount} 条表达说明</span><small>{new Date(attempt.createdAt).toLocaleString("zh-CN")}</small></div><Link href={`${questionHref}/attempts/${encodeURIComponent(attempt.id)}`} className="question-open-link">查看回答与材料</Link></li>)}</ol>}
            {!currentPractice&&!!learningPack?.answers.length&&<ol className="question-answer-history">{learningPack.answers.map(answer=><li key={answer.id}><details><summary><span><strong>第 {answer.attemptOrder} 次 · {answer.inputLanguage==="zh"?"中文":answer.inputLanguage==="en"?"英文":"中英混合"}</strong><small>{new Date(answer.createdAt).toLocaleString("zh-CN")} · {answer.gapCount} 个表达说明</small></span><span>展开原文</span></summary><p lang={answer.inputLanguage==="zh"?"zh-CN":"en"}>{answer.rawText}</p></details><Link href={`/answer-studio/${encodeURIComponent(answer.id)}`} className="question-open-link">查看版本</Link></li>)}</ol>}
          </details>}

          {answerCount>0&&<details id="gap-ledger" className={`question-detail-section ${styles.fold}`}><summary>表达说明与问题账本</summary>
            <p>保留入选依据和待确认的意思；待确认部分不影响已审核表达的学习。</p>
            {currentPractice?(currentPractice.ledger.length?<ol className="question-gap-list">{currentPractice.ledger.map(unit=><li key={unit.id}><strong>{unit.status==="uncertain"?"意思待确认（暂不制卡）":"表达依据"} · {unit.intentZh}</strong>{unit.evidence&&<p className="question-gap-evidence" lang="en">{unit.evidence}</p>}<p>{unit.reasonZh}</p></li>)}</ol>:<p>{currentPractice.status==="ready"?"本次没有确认需要修复的问题；这不代表长期掌握。":"这次说明尚未完成，原回答已保存。"}</p>):learningPack?.gaps.length?<ol className="question-gap-list">{learningPack.gaps.map(gap=><li key={gap.id}><div className="question-gap-meta"><span>{GAP_LABELS[gap.type]??"表达说明"}</span><span>{gap.impactLevel==="high"?"高影响":gap.impactLevel==="medium"?"中影响":"低影响"}</span>{gap.occurrenceCount>1&&<span>已出现 {gap.occurrenceCount} 次</span>}</div><p className="question-gap-evidence" lang="en">{gap.evidenceText}</p>{gap.recommendedExpression?<p><strong lang="en">{gap.recommendedExpression}</strong><span>{gap.explanationZh}</span></p>:<p>{gap.explanationZh}</p>}{!gap.learningFit&&<small>保留这条说明，暂不制成学习表达。</small>}</li>)}</ol>:<p>还没有可展示的表达说明，处理完成后会在这里保留复核依据。</p>}
          </details>}

          {answerCount>0&&<details id="reattempt-history" className={`question-detail-section ${styles.fold}`}><summary>重答与前后对比 · {learningPack?.reattemptCount??0} 次</summary>
            <p>独立重答可以留下新的表达证据。没有再次提到旧问题，不代表已经掌握。</p>
            {learningPack?.reattempts.length?learningPack.reattempts.map(attempt=><article key={attempt.id} className="question-reattempt"><h3>{new Date(attempt.completedAt).toLocaleString("zh-CN")} 的回答</h3><details><summary>展开本次原文</summary><p>{attempt.rawText}</p></details>{attempt.comparisons.length?<ul className="question-gap-list">{attempt.comparisons.map((comparison,index)=><li key={index}><strong>{{improved:"已改善",repeated:"仍重复",new:"新出现",uncertain:"不确定"}[comparison.comparison]??"待确认"}</strong>{comparison.previousEvidence&&<p>之前：{comparison.previousEvidence}</p>}<p>证据：{comparison.evidence}</p><p>{comparison.reason}</p>{comparison.expression&&<p lang="en">{comparison.expression}</p>}</li>)}</ul>:<p>这次没有可展示的差异结论，可以先回看回答版本。</p>}<Link href={`/answer-studio/${encodeURIComponent(attempt.answerId)}`} className="text-button">查看回答版本</Link></article>):<p>想试试时，可以从上方“更多练习与回顾”进入无提示重答。</p>}
          </details>}

          <details id="question-sources" className={`question-detail-section ${styles.fold}`}><summary>题目与来源</summary>
            <p>{question.sources.length?"来源链接指向原始文件与页码，同题跨季度的记录完整保留。":"暂缺可核实的原文件页码；这不影响使用英文题目和已审核的学习材料。"}</p>
            {!!question.sources.length&&<ul className="question-source-list">{question.sources.map(source=><li key={`${source.slug}-${source.page}`}><div><strong>{source.setName}</strong><span>{source.file}</span></div><a href={`/api/question-sources/${encodeURIComponent(source.slug)}#page=${source.page}`} target="_blank" rel="noreferrer">打开第 {source.page} 页</a></li>)}</ul>}
          </details>
          {!currentPractice&&question.publicChunks.length>0&&<details className={`question-detail-section ${styles.fold}`}><summary>已有来源表达</summary><p>这里保留已审核、与这道题相关联的表达。</p><ul className="question-chunk-list">{question.publicChunks.map(chunk=><li key={chunk.id}><Link href={`/chunks/${encodeURIComponent(chunk.id)}`} lang="en">{chunk.display}</Link><span>{chunk.meaningZh}</span>{chunk.ipa&&<small lang="en">/{chunk.ipa.replace(/^\/+|\/+$/g,"")}/</small>}</li>)}</ul></details>}
        </div>
      </div>
      <LookupCard annotationId={lookupId} onClose={()=>setLookupId(null)}/>
    </div>
  );
}
