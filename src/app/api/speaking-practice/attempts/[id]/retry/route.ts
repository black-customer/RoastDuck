import { after, NextResponse } from "next/server";
import { prepareAttemptReanalysis, processSpeakingAttempt, SpeakingPracticeError } from "@/lib/speaking-practice/service";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const attempt = await prepareAttemptReanalysis(id);
    after(async () => { await processSpeakingAttempt(id); });
    return NextResponse.json({ attempt }, { status: 202 });
  } catch (error) {
    if(error instanceof SpeakingPracticeError) return NextResponse.json({error:error.message,code:error.code},{status:error.status});
    return NextResponse.json({error:"分析暂时无法启动，原回答仍已保存"},{status:503});
  }
}
