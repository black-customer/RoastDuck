import {NextResponse} from 'next/server';
import {ZodError} from 'zod';
import {TrainingError} from '@/lib/four-step/shared';
import {LocalWriteError} from './local-write';
import {RuntimeRequestError} from '@/lib/ai/runtime-ledger';
import {AiProviderError} from '@/lib/ai/errors';
export function webError(error:unknown){
  if(error instanceof TrainingError)return NextResponse.json({error:error.message,code:error.code},{status:error.status});
  if(error instanceof RuntimeRequestError)return NextResponse.json({error:error.message,code:error.code},{status:409});
  if(error instanceof AiProviderError)return NextResponse.json({error:'AI 服务暂时未能完成，原内容已保存，请检查服务配置后重试',code:error.code},{status:503});
  if(error instanceof LocalWriteError)return NextResponse.json({error:error.message},{status:error.status});
  if(error instanceof ZodError)return NextResponse.json({error:'提交格式不正确，请检查输入'},{status:400});
  return NextResponse.json({error:'暂时无法保存或读取，输入请保留后重试'},{status:503});
}
