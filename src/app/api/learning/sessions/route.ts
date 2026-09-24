import { NextResponse } from "next/server";
import { localJsonBody } from "@/lib/http/local-write";
import { createOrResumeSession, LearningSessionError } from "@/lib/learning/session-service";
import { createSessionSchema } from "@/lib/learning/types";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const localBody = await localJsonBody(request);
  if (!localBody.ok) return localBody.response;
  const parsed = createSessionSchema.safeParse(localBody.body ?? {});
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
