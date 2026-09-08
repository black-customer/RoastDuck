import {after,NextResponse} from 'next/server';
import {z} from 'zod';
import {webAnswers} from '@/lib/app-services/web';
import {localJson} from '@/lib/http/local-write';
import {webError} from '@/lib/http/web-error';
import {processSpeakingAttempt} from '@/lib/speaking-practice/service';
export const dynamic='force-dynamic';
type Context={params:Promise<{id:string}>};
export async function GET(_request:Request,context:Context){try{return NextResponse.json({draft:await webAnswers.getDraft((await context.params).id)},{headers:{'Cache-Control':'no-store'}});}catch(error){return webError(error);}}
export async function PATCH(request:Request,context:Context){try{return NextResponse.json({draft:await webAnswers.saveDraft((await context.params).id,await localJson(request,150000))});}catch(error){return webError(error);}}
export async function POST(request:Request,context:Context){try{
  const {action,version}=z.object({action:z.enum(['commitEnglish','submit']),version:z.number().int().nonnegative()}).parse(await localJson(request)),id=(await context.params).id;
  if(action==='commitEnglish')return NextResponse.json({draft:await webAnswers.commitEnglish(id,version)});
  const result=await webAnswers.submit(id,version);after(async()=>{await processSpeakingAttempt(result.attemptId);});return NextResponse.json(result,{status:202});
}catch(error){return webError(error);}}
