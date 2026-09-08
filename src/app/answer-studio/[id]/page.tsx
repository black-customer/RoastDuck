import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { sql } from "drizzle-orm";
import { getDbReady } from "@db/client";
import { AnswerWorkspace } from "@/components/AnswerWorkspace";
import { getPersonalAnswer } from "@/lib/answers/service";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "个人答案｜鱼块学英语" };

export default async function AnswerWorkspacePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db=await getDbReady();
  const [mapped]=await db.all<{attempt_id:string;question_id:string}>(sql`SELECT m.attempt_id,a.question_id FROM practice_answer_sources m JOIN speaking_question_attempts a ON a.id=m.attempt_id WHERE m.answer_id=${id}`);
  if(mapped)redirect(`/questions/${encodeURIComponent(mapped.question_id)}/attempts/${encodeURIComponent(mapped.attempt_id)}`);
  const answer = await getPersonalAnswer(id);
  if (!answer) notFound();
  return <AnswerWorkspace initialAnswer={answer} />;
}
