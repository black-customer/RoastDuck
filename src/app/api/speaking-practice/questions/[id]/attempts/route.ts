import { after, NextResponse } from "next/server";
import { localJson } from "@/lib/http/local-write";
import { webError } from "@/lib/http/web-error";
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
    return webError(error);
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const json = (await localJson(request)) as unknown;
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
    return webError(error);
  }
}
