import type { Metadata } from "next";
import Link from "next/link";
import { SpeakingArena } from "@/components/SpeakingArena";
import { getPersonalAnswer } from "@/lib/answers/service";
import { getQuestionDetail } from "@/lib/questions/service";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "口语输出训练｜鱼块学英语" };

export default async function SpeakingArenaPage({ searchParams }: { searchParams: Promise<{ question?: string; answer?: string; session?: string }> }) {
  const params = await searchParams;
  const answer = params.answer ? await getPersonalAnswer(params.answer) : null;
  const questionId = answer?.questionId ?? params.question;
  const question = questionId ? await getQuestionDetail(questionId) : null;
  if (!question) return <div className="studio-shell"><div className="studio-frame"><section className="studio-missing"><span>SPEAKING ARENA</span><h1>先选择一道题</h1><p>输出训练会提供分级提示、结构化纠错和逐句重说。</p><Link href="/questions" className="primary-button">进入 IELTS 题库</Link></section></div></div>;
  return <SpeakingArena question={question} answerId={answer?.id ?? null} resumeSessionId={params.session} />;
}
