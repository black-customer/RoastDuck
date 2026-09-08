import { NextResponse } from "next/server";
import { questionFiltersSchema } from "@/lib/questions/schemas";
import { listQuestions, listQuestionTopics } from "@/lib/questions/service";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const parsed = questionFiltersSchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return NextResponse.json({ error: "题库筛选参数不合法", issues: parsed.error.issues }, { status: 400 });
  const [result, topics] = await Promise.all([listQuestions(parsed.data), listQuestionTopics(parsed.data)]);
  return NextResponse.json({ ...result, topics });
}
