import {NextResponse} from 'next/server';
import {ZodError} from 'zod';
import {SentenceStudyError,sentenceScopeSchema,type SentenceScope} from './contracts';
import {LocalWriteError} from '@/lib/http/local-write';
export function sentenceScopeFromUrl(url:string):SentenceScope {
  const p=new URL(url).searchParams,type=p.get('scope')??'all';
  return sentenceScopeSchema.parse(type==='all'?{type}:{type,id:p.get('id'),...(type==='collection'?{questionId:p.get('questionId')??undefined,topicId:p.get('topicId')??undefined,seasonId:p.get('seasonId')??undefined}:{})});
}
export function sentenceError(error:unknown){
  if(error instanceof LocalWriteError)return NextResponse.json({error:error.message,code:'invalid_request'},{status:error.status});
  if(error instanceof ZodError||error instanceof SyntaxError)return NextResponse.json({error:'请求格式不正确，请恢复页面后再试',code:'invalid_request'},{status:400});
  if(error instanceof SentenceStudyError)return NextResponse.json({error:error.message,code:error.code},{status:error.status});
  return NextResponse.json({error:'暂时无法读取或保存，原记录仍保留，请重试',code:'sentence_service_unavailable'},{status:503});
}
export function assertSentenceOrigin(request:Request){const origin=request.headers.get('origin');if(origin&&origin!==new URL(request.url).origin)throw new SentenceStudyError('请求来源不匹配',403,'invalid_origin');}
