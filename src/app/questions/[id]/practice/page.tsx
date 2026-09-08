import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SpeakingPracticeStudio } from "@/components/SpeakingPracticeStudio";
import { getQuestionDetail } from "@/lib/questions/service";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "口语答题练习｜鱼块学英语" };

export default async function SpeakingPracticePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ mode?: string;source?:string;kind?:string }>;
}) {
  const { id } = await params;
  const { mode,source,kind } = await searchParams;
  const question = await getQuestionDetail(id);
  if (!question) notFound();

  const validMode = mode === "exam_style" ? "exam_style" : "practice";

  return <SpeakingPracticeStudio question={question} initialMode={validMode} sourceAttemptId={source} kind={kind==='independent'?'independent':kind==='edit'?'edit':'practice'} />;
}
