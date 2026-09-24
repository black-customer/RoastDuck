import { NextResponse } from "next/server";
import { localJsonBody } from "@/lib/http/local-write";
import { safeErrorSummary } from "@/lib/ai/errors";
import { createCompanionMessageSchema } from "@/lib/companion/schemas";
import { CompanionServiceError, getCompanionThread, sendCompanionMessage } from "@/lib/companion/service";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const thread = await getCompanionThread(id);
  if (!thread) return NextResponse.json({ error: "Chloe 线程不存在" }, { status: 404 });
  return NextResponse.json({ thread });
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const localBody = await localJsonBody(request);
  if (!localBody.ok) return localBody.response;
  const parsed = createCompanionMessageSchema.safeParse(localBody.body);
  if (!parsed.success) return NextResponse.json({ error: "消息参数无效", issues: parsed.error.issues }, { status: 400 });
  try {
    return NextResponse.json(await sendCompanionMessage(id, parsed.data));
  } catch (error) {
    if (error instanceof CompanionServiceError) {
      return NextResponse.json({ error: error.message, code: error.code, thread: await getCompanionThread(id) }, { status: error.status });
    }
    return NextResponse.json({ error: safeErrorSummary(error), code: "companion_response_failed", thread: await getCompanionThread(id) }, { status: 502 });
  }
}
