import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { QuestionDetailView } from "@/components/QuestionDetailView";
import {getWebQuestionDetail as getQuestionDetail} from '@/lib/questions/sentence-service';
import {sentenceOverview} from '@/lib/sentence-study/service';
import {getQuestionLearningPack} from '@/lib/questions/learning-pack-service';
import {getQuestionDetail as getLegacyQuestionDetail} from '@/lib/questions/service';
import { lightStudyEnabled } from "@/lib/light-study/enabled";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "IELTS 题目详情｜鱼块学英语" };

export default async function QuestionDetailPage({ params,searchParams }: { params: Promise<{ id: string }>;searchParams:Promise<{extension?:string}> }) {
  const { id } = await params;
  if((await searchParams).extension==='1'){
    const [question,pack]=await Promise.all([getLegacyQuestionDetail(id),getQuestionLearningPack(id)]);if(!question)notFound();
    return <QuestionDetailView question={question} learningPack={pack}/>;
  }
  const [question, sentenceInfo] = await Promise.all([
    getQuestionDetail(id),
    sentenceOverview({type:'question',id}),
  ]);
  if (!question) notFound();
  return <QuestionDetailView question={question} learningPack={null} initialSentenceInfo={sentenceInfo} allowLightStudy={lightStudyEnabled()} />;
}
