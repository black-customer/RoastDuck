import { NextResponse } from "next/server";
import {getWebQuestionDetail as getQuestionDetail} from '@/lib/questions/sentence-service';

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const question = await getQuestionDetail(id);
  if (!question) return NextResponse.json({ error: "题目不存在" }, { status: 404 });
  return NextResponse.json({ question });
}
