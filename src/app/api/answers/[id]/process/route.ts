import { NextResponse } from "next/server";
import { processAnswerSchema } from "@/lib/answers/schemas";
import { processPersonalAnswer } from "@/lib/answers/processor";
import { safeErrorSummary } from "@/lib/ai/errors";
import { AnswerServiceError } from "@/lib/answers/service";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const parsed = processAnswerSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "重新处理请求不合法" }, { status: 400 });
  try {
    const answer = await processPersonalAnswer(id, parsed.data.clientRequestId, parsed.data.force);
    if (!answer) return NextResponse.json({ error: "答案不存在" }, { status: 404 });
    return NextResponse.json({ answer });
  } catch (error) {
    if (error instanceof AnswerServiceError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    return NextResponse.json({ error: safeErrorSummary(error), code: "ai_processing_failed" }, { status: 502 });
  }
}
