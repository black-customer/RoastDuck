import {NextResponse} from 'next/server';
import {z} from 'zod';
import {webCompanion} from '@/lib/app-services/web';
import {coachingContextSchema} from '@/lib/coaching/contracts';
import {webError} from '@/lib/http/web-error';
import {localJson} from '@/lib/http/local-write';
export const dynamic='force-dynamic';
export async function GET(request:Request){
  try{const p=new URL(request.url).searchParams;
    const context=coachingContextSchema.parse({materialId:p.get('materialId'),sentenceId:p.get('sentenceId')??undefined,questionId:p.get('questionId')??undefined,mode:p.get('mode'),practiceId:p.get('practiceId')});
    return NextResponse.json(await webCompanion().coaching.view(context));
  }catch(error){return webError(error);}
}
export async function PATCH(request:Request){
  try{const body=z.discriminatedUnion('action',[
    z.object({context:coachingContextSchema,clientMessageId:z.string().min(8).max(160),action:z.literal('skip')}),
    z.object({context:coachingContextSchema,action:z.literal('retry_reviews'),retryUnknown:z.boolean().default(false)}),
  ]).parse(await localJson(request));
    if(body.action==='retry_reviews')return NextResponse.json(await webCompanion().coaching.retryReviews(body.context,{retryFailed:true,retryUnknown:body.retryUnknown}));
    return NextResponse.json(await webCompanion().coaching.skip(body.context,body.clientMessageId));
  }catch(error){return webError(error);}
}
