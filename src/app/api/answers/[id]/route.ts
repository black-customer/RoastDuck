import { NextResponse } from "next/server";
import { localJsonBody } from "@/lib/http/local-write";
import { updateAnswerSchema } from "@/lib/answers/schemas";
import { AnswerServiceError, appendUserAnswerVersion, getPersonalAnswer } from "@/lib/answers/service";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const answer = await getPersonalAnswer(id);
  if (!answer) return NextResponse.json({ error: "答案不存在" }, { status: 404 });
  return NextResponse.json({ answer });
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const localBody = await localJsonBody(request);
  if (!localBody.ok) return localBody.response;
  const parsed = updateAnswerSchema.safeParse(localBody.body);
  if (!parsed.success) return NextResponse.json({ error: "答案版本不合法", issues: parsed.error.issues }, { status: 400 });
  try {
    return NextResponse.json({ answer: await appendUserAnswerVersion(id, parsed.data.textEn, parsed.data.baseVersionNo) });
  } catch (error) {
    if (error instanceof AnswerServiceError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    throw error;
  }
}
