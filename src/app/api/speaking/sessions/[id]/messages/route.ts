import { NextResponse } from "next/server";
import { localJsonBody } from "@/lib/http/local-write";
import { safeErrorSummary } from "@/lib/ai/errors";
import { createSpeakingMessageSchema } from "@/lib/speaking/schemas";
import { getSpeakingSession, sendSpeakingMessage, SpeakingServiceError } from "@/lib/speaking/service";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const localBody = await localJsonBody(request);
  if (!localBody.ok) return localBody.response;
  const parsed = createSpeakingMessageSchema.safeParse(localBody.body);
  if (!parsed.success) {
    return NextResponse.json({ error: "老师消息参数不合法", issues: parsed.error.issues }, { status: 400 });
  }
  try {
    return NextResponse.json({ session: await sendSpeakingMessage(id, parsed.data) });
  } catch (error) {
    if (error instanceof SpeakingServiceError) {
      return NextResponse.json({ error: error.message, code: error.code, session: await getSpeakingSession(id) }, { status: error.status });
    }
    return NextResponse.json({
      error: safeErrorSummary(error),
      code: "teacher_response_failed",
      session: await getSpeakingSession(id),
    }, { status: 502 });
  }
}
