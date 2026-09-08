import type { Metadata } from "next";
import Link from "next/link";
import { AnswerStudio } from "@/components/AnswerStudio";
import { getQuestionDetail } from "@/lib/questions/service";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "回答工作台｜鱼块学英语" };

export default async function AnswerStudioPage({ searchParams }: { searchParams: Promise<{ question?: string }> }) {
  const { question: questionId } = await searchParams;
  const question = questionId ? await getQuestionDetail(questionId) : null;
  if (!question) {
    return (
      <div className="studio-shell"><div className="studio-frame"><section className="studio-missing">
        <span>ANSWER STUDIO</span><h1>先选择一道题</h1><p>工作台会把你的中文、英文或中英混合回答保存为个人材料。</p>
        <Link href="/questions" className="primary-button">进入 IELTS 题库</Link>
      </section></div></div>
    );
  }
  return <AnswerStudio question={question} />;
}
