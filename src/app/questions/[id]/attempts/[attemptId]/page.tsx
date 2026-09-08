import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SpeakingAttemptResult } from "@/components/SpeakingAttemptResult";
import { getSpeakingAttempt } from "@/lib/speaking-practice/service";
import { lightStudyEnabled } from "@/lib/light-study/enabled";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "口语尝试诊断与训练｜鱼块学英语" };

export default async function SpeakingAttemptResultPage({
  params,
}: {
  params: Promise<{ id: string; attemptId: string }>;
}) {
  const { attemptId } = await params;
  const attempt = await getSpeakingAttempt(attemptId);
  if (!attempt) notFound();

  return <SpeakingAttemptResult attempt={attempt} allowLightStudy={lightStudyEnabled()} />;
}
