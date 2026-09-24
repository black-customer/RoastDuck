import { NextResponse } from "next/server";
import { localJsonBody } from "@/lib/http/local-write";
import { applySessionEvent, LearningSessionError } from "@/lib/learning/session-service";
import { learningEventSchema } from "@/lib/learning/types";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const localBody = await localJsonBody(request);
  if (!localBody.ok) return localBody.response;
  const parsed = learningEventSchema.safeParse(localBody.body);
  if (!parsed.success) return NextResponse.json({ error: "学习事件参数无效", issues: parsed.error.issues }, { status: 400 });
  try {
    const { id } = await params;
    return NextResponse.json(await applySessionEvent(id, parsed.data));
  } catch (error) {
    if (error instanceof LearningSessionError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    throw error;
  }
}
