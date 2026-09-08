import { NextResponse } from "next/server";
import { evaluateTranslationInputSchema } from "@/lib/speaking-practice/schemas";
import {
  evaluateTranslation,
  SpeakingPracticeError,
} from "@/lib/speaking-practice/service";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const json = (await request.json()) as unknown;
    const parsed = evaluateTranslationInputSchema.safeParse(json);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "输入数据格式不正确", details: parsed.error.format() },
        { status: 400 },
      );
    }

    const evaluation = await evaluateTranslation(id, parsed.data.userEnglish);
    return NextResponse.json({ evaluation });
  } catch (error) {
    if (error instanceof SpeakingPracticeError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    const message = error instanceof Error ? error.message : "评估翻译失败";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
