import {NextResponse} from 'next/server';
import {webCompanion} from '@/lib/app-services/web';
import {coachingSubmitSchema} from '@/lib/coaching/contracts';
import {webError} from '@/lib/http/web-error';
import {localJson} from '@/lib/http/local-write';
export const dynamic='force-dynamic';
export async function POST(request:Request){
  try{return NextResponse.json(await webCompanion().coaching.submit(coachingSubmitSchema.parse(await localJson(request,98304))));}
  catch(error){return webError(error);}
}
