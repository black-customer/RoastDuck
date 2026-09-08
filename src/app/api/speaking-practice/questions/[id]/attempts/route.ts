import { after, NextResponse } from "next/server";
import { createAttemptInputSchema } from "@/lib/speaking-practice/schemas";
import {
  prepareSpeakingAttempt,
  processSpeakingAttempt,
  listQuestionAttempts,
  SpeakingPracticeError,
} from "@/lib/speaking-practice/service";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const attempts = await listQuestionAttempts(id);
    return NextResponse.json({ attempts });
  } catch (error) {
    const message = error instanceof Error ? error.message : "获取历史回答失败";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const json = (await request.json()) as unknown;
    const parsed = createAttemptInputSchema.safeParse({
      ...(typeof json === "object" && json !== null ? json : {}),
      questionId: id,
    });

    if (!parsed.success) {
      return NextResponse.json(
        { error: "输入数据格式不正确", details: parsed.error.format() },
        { status: 400 },
      );
    }

    const attempt = await prepareSpeakingAttempt(parsed.data);
    after(async () => { await processSpeakingAttempt(attempt.id); });
    return NextResponse.json({ attempt }, { status: 202 });
  } catch (error) {
    if (error instanceof SpeakingPracticeError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    const message = error instanceof Error ? error.message : "创建答题失败";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
