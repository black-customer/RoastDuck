import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { QuestionDetailView } from "@/components/QuestionDetailView";
import { getQuestionLearningPack } from "@/lib/questions/learning-pack-service";
import { getQuestionDetail } from "@/lib/questions/service";
import { lightStudyEnabled } from "@/lib/light-study/enabled";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "IELTS 题目详情｜鱼块学英语" };

export default async function QuestionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [question, learningPack] = await Promise.all([
    getQuestionDetail(id),
    getQuestionLearningPack(id),
  ]);
  if (!question) notFound();
  return <QuestionDetailView question={question} learningPack={learningPack} allowLightStudy={lightStudyEnabled()} />;
}
