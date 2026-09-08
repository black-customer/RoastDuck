"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import type { HomeOverview } from "@/lib/home/overview";
import type { QuestionListItem } from "@/lib/questions/service";
import { InteractiveEnglishText } from "@/components/InteractiveEnglishText";
import { LookupCard } from "@/components/LookupCard";
import styles from "./HomeDashboard.module.css";

import { Icon } from "@/components/ui/Icon";
import { HomeLearningAction } from "./HomeLearningAction";
import { HomeExpressionCollections } from "./HomeExpressionCollections";

export function HomeDashboard({ overview,allowLightStudy=true }: { overview: HomeOverview | null;allowLightStudy?:boolean }) {
  const [question, setQuestion] = useState<QuestionListItem | null>(overview?.question ?? null);
  const [randomLoading, setRandomLoading] = useState(false);
  const [randomError, setRandomError] = useState("");
  const [annotationId, setAnnotationId] = useState<string | null>(null);
  const randomLock = useRef(false);
  const lookupTrigger = useRef<HTMLElement | null>(null);
  const lookup = (id: string) => {
    lookupTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setAnnotationId(id);
  };
  const closeLookup = () => {
    setAnnotationId(null);
    const trigger=lookupTrigger.current;
    requestAnimationFrame(()=>{if(trigger?.isConnected)trigger.focus();});
  };
  const changeQuestion = async () => {
    if (randomLock.current) return;
    randomLock.current = true;
    setRandomLoading(true);
    setRandomError("");
    try {
      const response = await fetch("/api/questions/random", { cache: "no-store" });
      const body = await response.json() as { question?: QuestionListItem; error?: string };
      if (!response.ok || !body.question) throw new Error(body.error || "随机题加载失败，请再试一次。");
      setQuestion(body.question);
    } catch (reason) {
      setRandomError(reason instanceof Error ? reason.message : "随机题加载失败，请再试一次。");
    } finally {
      randomLock.current = false;
      setRandomLoading(false);
    }
  };

  return (
    <div className={styles.shell}>
        <header className={styles.header}>
          <div><h1>今日学习</h1><p>从你想说的意思开始。</p></div>
          <div className={styles.headerTools}>{overview && <span className={styles.date}>{overview.dateLabel}</span>}<Link href="/search" className={styles.searchLink} aria-label="搜索表达"><Icon name="search" /><span>搜索表达</span></Link></div>
        </header>

        {!overview ? (
          <section className={styles.loadError} role="alert">
            <h2>学习概览暂时没有加载出来</h2><p>你的学习记录没有被重置。可以刷新重试，或从导航进入题库和对话。</p>
            <button type="button" className={styles.primaryButton} onClick={() => window.location.reload()}>重新加载</button>
          </section>
        ) : (
          <div className={styles.columns}>
            <div className={styles.workArea}>
              <section className={styles.focusPanel} aria-labelledby="learning-title">
                <h2 id="learning-title">花几分钟，<br className={styles.mobileBreak} />回想几个表达。</h2>
                <p className={styles.focusDescription}>先看中文，在心里想一下。揭晓后听听表达，按自己的感觉继续。</p>
                {allowLightStudy||overview.lightAction.kind==="resume"?<HomeLearningAction action={overview.lightAction} />:<Link href="/questions" className={styles.primaryButton}>选择一道题</Link>}
                <div className={styles.learningSteps} aria-label="轻松学流程"><span>回想意思</span><span>揭晓表达</span><span>自评后继续</span></div>
                <details className={styles.optionalTraining}><summary>可选强化练习</summary>
                  <Link href={overview.newGapHref} className={styles.textLink}>继续四步强化<Icon name="arrow" /></Link>
                  <Link href={overview.reviewHref} className={styles.textLink}>复习题目／对话<Icon name="arrow" /></Link>
                </details>
              </section>

              <HomeExpressionCollections />
              <section className={styles.packs} aria-labelledby="packs-title">
                <div className={styles.sectionHeading}>
                  <div><h2 id="packs-title">最近的回答</h2><p>材料和历史都在这里，按自己的节奏继续。</p></div>
                  <Link href="/questions?status=has_history" className={styles.textLink}>全部题目<Icon name="arrow" /></Link>
                </div>
                {overview.packs.length ? (
                  <div className={styles.packList}>{overview.packs.map((pack) => <article key={pack.id} className={styles.pack}>
                    <div className={styles.packTop}><span className={styles.part}>Part {pack.part}</span><span>{pack.topicZh || "个人题目"}</span><span className={styles.packState}>{pack.stateLabel}</span></div>
                    <InteractiveEnglishText content={pack.interactiveQuestion} onLookup={lookup} className={styles.packQuestion} />
                    <div className={styles.packBottom}>
                      <span>{pack.answerCount} 次回答{pack.learningUnitCount > 0 ? ` · ${pack.learningUnitCount} 个学习表达` : " · 回答已保留"}</span>
                      <Link className={styles.textLink} href={pack.primaryAction.href ?? `/questions/${encodeURIComponent(pack.id)}`}>{pack.primaryAction.label}<Icon name="arrow" /></Link>
                    </div>
                  </article>)}</div>
                ) : <div className={styles.emptyPacks}><Icon name="answers" /><h3>让自己的回答成为学习材料</h3><p>去题库选一道题，用中文、英文或中英混合表达想法。完成分析后，相关表达会汇集在这里。</p><Link href="/questions" className={styles.textLink}>选择第一道题<Icon name="arrow" /></Link></div>}
                {overview.historyCount > 0 && <p className={styles.packFootnote}>已有 {overview.historyCount} 道题保留了你的回答。只有通过内容审核的表达才会进入学习。</p>}
              </section>

              <section className={styles.librarySummary} aria-label="开始新作答">
                <div><Icon name="answers" /><span>想聊点新的？</span></div>
                <Link href="/questions" className={styles.textLink}>选择雅思题目<Icon name="arrow" /></Link>
                <Link href="/free-talk" className={styles.textLink}>与 Chloe 自由聊天<Icon name="arrow" /></Link>
              </section>
            </div>

            <aside className={styles.rightRail} aria-label="复习与口语练习">
              <section className={styles.reviewPanel} aria-labelledby="review-title">
                <h2 id="review-title">材料与复习</h2>
                <p>{overview.light.dueCount>0?`${overview.light.dueCount} 个表达到期，可以先回想一下。`:"暂时没有到期表达，可以学一点新的。"}</p>
                <Link href="/light-study" className={styles.textLink}>查看轻松学<Icon name="arrow" /></Link>
                {overview.materialTasks.length>0&&<ul className={styles.taskList}>{overview.materialTasks.map(task=><li key={task.id}>
                  <span>{task.status==="failed"?"材料需要重试":"材料处理中"}</span>
                  <Link className={styles.textLink} href={task.href}>{task.title}<Icon name="arrow" /></Link>
                </li>)}</ul>}
              </section>
              <section className={styles.randomPanel} aria-labelledby="random-title">
                <div className={styles.sectionHeading}><h2 id="random-title">来聊一道题</h2><Icon name="questions" /></div>
                <p className={styles.randomIntro}>不必想好完美的英文，先表达你的想法。</p>
                <div aria-live="polite" aria-busy={randomLoading}>
                  {question ? <>
                    <div className={styles.questionMeta}><span className={styles.part}>Part {question.part}</span><span>{question.topicZh || "雅思口语"}</span></div>
                    <InteractiveEnglishText content={question.interactiveQuestion} onLookup={lookup} className={styles.randomQuestion} />
                    <p className={styles.questionTranslation}>{question.textZh || "可进入题目查看详情和来源。"}</p>
                    <p className={styles.questionSource}>{question.setNames.length ? question.setNames.join(" / ") : "题目来源见详情"}</p>
                  </> : <p className={styles.questionTranslation}>当前没有可预览的题目，可进入题库查看或重新抽取。</p>}
                </div>
                {randomError && <p className={styles.randomError} role="alert">{randomError}</p>}
                <div className={styles.randomActions}>
                  {question && <Link href={`/questions/${encodeURIComponent(question.id)}?from=random`} className={styles.secondaryButton}>去回答<Icon name="arrow" /></Link>}
                  <button type="button" className={styles.shuffleButton} onClick={() => void changeQuestion()} disabled={randomLoading}><Icon name="shuffle" />{randomLoading ? "抽取中…" : randomError ? "重新抽取" : "换一题"}</button>
                </div>
              </section>
              <p className={styles.privacyNote}>学习记录保存在本机。<br />录音和 AI 使用方式可在<Link href="/settings">设置</Link>中查看。</p>
            </aside>
          </div>
        )}
      <LookupCard annotationId={annotationId} onClose={closeLookup} />
    </div>
  );
}
