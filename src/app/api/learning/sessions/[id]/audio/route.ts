import { NextResponse } from "next/server";
import { getSessionAudioSpec, LearningSessionError } from "@/lib/learning/session-service";
import { SpeechProviderError } from "@/lib/speech/contracts";
import { synthesizeSpeech } from "@/lib/speech/service";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const stepVersion = Number(new URL(request.url).searchParams.get("stepVersion"));
  if (!Number.isInteger(stepVersion) || stepVersion < 1) {
    return NextResponse.json({ error: "音频步骤版本无效" }, { status: 400 });
  }
  try {
    const { id } = await params;
    const spec = await getSessionAudioSpec(id, stepVersion);
    const asset = await synthesizeSpeech({
      text: spec.text,
      purpose: "learning_context",
      accent: spec.accent === "en-GB" ? "en-GB" : "en-US",
      rate: 0.95,
    });
    return NextResponse.redirect(new URL(asset.audioUrl, request.url), 307);
  } catch (error) {
    if (error instanceof LearningSessionError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    if (error instanceof SpeechProviderError) {
      return NextResponse.json({ error: error.message, code: error.code, fallback: "text_after_rating" }, { status: error.httpStatus });
    }
    throw error;
  }
}
