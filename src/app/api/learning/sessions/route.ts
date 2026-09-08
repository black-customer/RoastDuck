import { NextResponse } from "next/server";
import { createOrResumeSession, LearningSessionError } from "@/lib/learning/session-service";
import { createSessionSchema } from "@/lib/learning/types";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const parsed = createSessionSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "会话参数无效", issues: parsed.error.issues }, { status: 400 });
  try {
    return NextResponse.json(await createOrResumeSession(parsed.data));
  } catch (error) {
    if (error instanceof LearningSessionError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    throw error;
  }
}
