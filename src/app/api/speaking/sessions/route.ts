import { NextResponse } from "next/server";
import { createSpeakingSessionSchema } from "@/lib/speaking/schemas";
import { createSpeakingSession, SpeakingServiceError } from "@/lib/speaking/service";
import { safeErrorSummary } from "@/lib/ai/errors";

export async function POST(request: Request) {
  const parsed = createSpeakingSessionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "输出会话参数不合法", issues: parsed.error.issues }, { status: 400 });
  try {
    return NextResponse.json({ session: await createSpeakingSession(parsed.data) }, { status: 201 });
  } catch (error) {
    if (error instanceof SpeakingServiceError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    return NextResponse.json({ error: safeErrorSummary(error), code: "ai_hint_failed" }, { status: 502 });
  }
}
