import { NextResponse } from "next/server";
import { assertAudioLocal } from "@/lib/answer-audio/http";
import { getSessionAudioSpec, LearningSessionError } from "@/lib/learning/session-service";
import { lookupCachedSpeech } from "@/lib/speech/service";
import { webError } from "@/lib/http/web-error";

export const dynamic = "force-dynamic";

// GET 只重定向到已缓存音频，不写 speech_requests、不触发付费合成；
// 新生成仍走受本机写保护的 POST /api/speech/synthesis。
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const stepVersion = Number(new URL(request.url).searchParams.get("stepVersion"));
  if (!Number.isInteger(stepVersion) || stepVersion < 1) {
    return NextResponse.json({ error: "音频步骤版本无效" }, { status: 400 });
  }
  try {
    assertAudioLocal(request);
    const { id } = await params;
    const spec = await getSessionAudioSpec(id, stepVersion);
    const asset = await lookupCachedSpeech({
      text: spec.text,
      purpose: "learning_context",
      accent: spec.accent === "en-GB" ? "en-GB" : "en-US",
      rate: 0.95,
    });
    if (!asset) {
      return NextResponse.json({ error: "这段学习音频还没有缓存，请先在本机页面播放一次生成", code: "audio_not_cached" }, { status: 404 });
    }
    return NextResponse.redirect(new URL(asset.audioUrl, request.url), 307);
  } catch (error) {
    if (error instanceof LearningSessionError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    return webError(error);
  }
}
