import { Suspense } from "react";
import type { Metadata } from "next";
import { QuestionLibrary } from "@/components/QuestionLibrary";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "IELTS 口语题库｜鱼块学英语" };

export default function QuestionsPage() {
  return (
    <Suspense fallback={<div className="question-shell"><div className="question-frame"><div className="question-page-skeleton" aria-label="题库加载中" /></div></div>}>
      <QuestionLibrary />
    </Suspense>
  );
}
