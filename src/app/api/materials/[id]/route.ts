import {after,NextResponse} from 'next/server';
import {webCompanion} from '@/lib/app-services/web';
import {localJson} from '@/lib/http/local-write';
import {webError} from '@/lib/http/web-error';
import {z} from 'zod';
type Context={params:Promise<{id:string}>};
export async function GET(_request:Request,context:Context){try{return NextResponse.json(await webCompanion().materials.inspect((await context.params).id));}catch(error){return webError(error);}}
export async function POST(request:Request,context:Context){try{const options=z.object({retryUnknown:z.boolean().default(false)}).parse(await localJson(request)),id=(await context.params).id;after(async()=>{await webCompanion().materials.process(id,{retry:true,...options});});return NextResponse.json({accepted:true},{status:202});}catch(error){return webError(error);}}
