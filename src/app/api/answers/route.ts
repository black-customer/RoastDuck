import { NextResponse } from "next/server";
import { localJsonBody } from "@/lib/http/local-write";
import { createAnswerSchema } from "@/lib/answers/schemas";
import { AnswerServiceError, createPersonalAnswer } from "@/lib/answers/service";

export async function POST(request: Request) {
  const localBody = await localJsonBody(request);
  if (!localBody.ok) return localBody.response;
  const parsed = createAnswerSchema.safeParse(localBody.body);
  if (!parsed.success) return NextResponse.json({ error: "回答内容不合法", issues: parsed.error.issues }, { status: 400 });
  try {
    return NextResponse.json(await createPersonalAnswer(parsed.data), { status: 201 });
  } catch (error) {
    if (error instanceof AnswerServiceError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    throw error;
  }
}
