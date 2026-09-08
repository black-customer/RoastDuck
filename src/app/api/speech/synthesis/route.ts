import { NextResponse } from "next/server";
import { speechSynthesisInputSchema, SpeechProviderError } from "@/lib/speech/contracts";
import { synthesizeSpeech } from "@/lib/speech/service";
import {z} from 'zod';
import {localJson,LocalWriteError} from '@/lib/http/local-write';

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let input:unknown;try{input=await localJson(request);}catch(error){return NextResponse.json({error:error instanceof Error?error.message:'请求不合法'},{status:error instanceof LocalWriteError?error.status:400});}
  const parsed = speechSynthesisInputSchema.extend({priority:z.number().int().min(0).max(1).default(1),retryUnknown:z.boolean().default(false)}).safeParse(input);
  if (!parsed.success) return NextResponse.json({ error: "语音合成参数不合法", issues: parsed.error.issues }, { status: 400 });
  try {
    return NextResponse.json({ audio: await synthesizeSpeech(parsed.data,{priority:parsed.data.priority,retryUnknown:parsed.data.retryUnknown,signal:request.signal}) });
  } catch (reason) {
    if (reason instanceof SpeechProviderError) {
      return NextResponse.json({ error: reason.message, code: reason.code, fallback: "web_speech" }, { status: reason.httpStatus });
    }
    return NextResponse.json({ error: "语音暂时不可用", code: "upstream_unavailable", fallback: "web_speech" }, { status: 503 });
  }
}
