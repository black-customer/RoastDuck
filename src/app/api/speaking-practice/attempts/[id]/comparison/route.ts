import {after,NextResponse} from 'next/server';
import {z} from 'zod';
import {webCompanion} from '@/lib/app-services/web';
import {localJson} from '@/lib/http/local-write';
import {webError} from '@/lib/http/web-error';
type Context={params:Promise<{id:string}>};
export async function GET(_r:Request,c:Context){try{return NextResponse.json({comparison:await webCompanion().comparison.get((await c.params).id)});}catch(error){return webError(error);}}
export async function POST(r:Request,c:Context){try{const input=z.object({retryUnknown:z.boolean().default(false)}).parse(await localJson(r)),id=(await c.params).id;after(async()=>{await webCompanion().comparison.process(id,{retryFailed:true,...input});});return NextResponse.json({accepted:true},{status:202});}catch(error){return webError(error);}}
