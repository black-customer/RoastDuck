import { NextResponse } from "next/server";
import { questionAttemptInputSchema } from "@/lib/questions/schemas";
import { recordQuestionAttempt } from "@/lib/questions/service";

export async function POST(request: Request) {
  const parsed = questionAttemptInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "题目练习事件不合法", issues: parsed.error.issues }, { status: 400 });
  const exists = await recordQuestionAttempt({
    id: parsed.data.eventId,
    questionId: parsed.data.questionId,
    status: parsed.data.status,
    origin: parsed.data.origin,
  });
  if (!exists) return NextResponse.json({ error: "题目不存在" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
