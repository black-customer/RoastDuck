import { NextResponse } from "next/server";
import { safeErrorSummary } from "@/lib/ai/errors";
import { speakingEventSchema } from "@/lib/speaking/schemas";
import { applySpeakingEvent, getSpeakingSession, SpeakingServiceError } from "@/lib/speaking/service";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const parsed = speakingEventSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "输出事件不合法", issues: parsed.error.issues }, { status: 400 });
  try {
    return NextResponse.json({ session: await applySpeakingEvent(id, parsed.data) });
  } catch (error) {
    if (error instanceof SpeakingServiceError) return NextResponse.json({ error: error.message, code: error.code, session: await getSpeakingSession(id) }, { status: error.status });
    return NextResponse.json({ error: safeErrorSummary(error), code: "ai_processing_failed", session: await getSpeakingSession(id) }, { status: 502 });
  }
}
