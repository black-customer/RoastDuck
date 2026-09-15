import {NextResponse} from 'next/server';
import {z} from 'zod';
import {webCompanion} from '@/lib/app-services/web';
import {localJson} from '@/lib/http/local-write';
import {webError} from '@/lib/http/web-error';
import {contextPracticeCreateSchema} from '@/lib/context-practice/contracts';
export const dynamic='force-dynamic';
export async function GET(request:Request){try{const materialId=z.string().min(1).max(160).parse(new URL(request.url).searchParams.get('materialId'));return NextResponse.json(await webCompanion().contextPractice.list(materialId),{headers:{'Cache-Control':'no-store'}});}catch(error){return webError(error);}}
export async function POST(request:Request){try{
  const body=await localJson(request,24000);
  if(body&&typeof body==='object'&&'action'in body&&body.action==='retry'){
    const input=z.object({action:z.literal('retry'),taskId:z.string().min(1).max(160),retryUnknown:z.boolean().default(false)}).parse(body);
    return NextResponse.json({task:await webCompanion().contextPractice.retry(input.taskId,{retryFailed:true,retryUnknown:input.retryUnknown})});
  }
  const input=contextPracticeCreateSchema.parse(body);return NextResponse.json({task:await webCompanion().contextPractice.create(input)});
}catch(error){return webError(error);}}
