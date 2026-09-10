import { NextResponse } from "next/server";
import { questionFiltersSchema } from "@/lib/questions/schemas";
import { randomSentenceQuestion } from "@/lib/questions/sentence-service";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const parsed = questionFiltersSchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return NextResponse.json({ error: "随机题筛选参数不合法", issues: parsed.error.issues }, { status: 400 });
  const question = await randomSentenceQuestion(parsed.data);
  if (!question) return NextResponse.json({ error: "当前筛选范围内没有可随机的题目" }, { status: 404 });
  return NextResponse.json({ question });
}
