import { after, NextResponse } from "next/server";
import { getSpeakingAttempt,prepareAttemptReanalysis, processSpeakingAttempt, SpeakingPracticeError } from "@/lib/speaking-practice/service";
import {localJson} from '@/lib/http/local-write';
import {z} from 'zod';
import {webError} from '@/lib/http/web-error';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const body=z.object({retryUnknown:z.boolean().default(false)}).parse(await localJson(request));
    const current=await getSpeakingAttempt(id);
    if(current?.materialDiagnostic?.canRetry===false)throw new SpeakingPracticeError(current.materialDiagnostic.message,409,'request_configuration_required');
    if(current?.materialDiagnostic?.requiresConfirmation&&!body.retryUnknown)throw new SpeakingPracticeError('上次结果未知，请确认可能再次计费后继续',409,'result_unknown');
    const attempt = await prepareAttemptReanalysis(id,{retryUnknown:body.retryUnknown});
    after(async () => { await processSpeakingAttempt(id,{retry:true,retryUnknown:body.retryUnknown}); });
    return NextResponse.json({ attempt,materialId:attempt.materialId,transition:attempt.materialTransition??null }, { status: 202 });
  } catch (error) {
    if(error instanceof SpeakingPracticeError) return NextResponse.json({error:error.message,code:error.code},{status:error.status});
    return webError(error);
  }
}
