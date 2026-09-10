import { NextResponse } from "next/server";
import { questionFiltersSchema } from "@/lib/questions/schemas";
import {listSentenceQuestions} from '@/lib/questions/sentence-service';

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const parsed = questionFiltersSchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return NextResponse.json({ error: "题库筛选参数不合法", issues: parsed.error.issues }, { status: 400 });
  return NextResponse.json(await listSentenceQuestions(parsed.data));
}
