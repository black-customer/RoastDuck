import {after,NextResponse} from 'next/server';
import {z} from 'zod';
import {webCompanion} from '@/lib/app-services/web';
import {localJson} from '@/lib/http/local-write';
import {webError} from '@/lib/http/web-error';
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){try{
  const {startId,endId}=z.object({startId:z.string(),endId:z.string()}).parse(await localJson(request)),services=webCompanion();
  const material=await services.chat.recap((await params).id,startId,endId);after(async()=>{await services.materials.process(material.id);});
  return NextResponse.json({materialId:material.id,status:material.status},{status:material.status==='ready'?200:202});
}catch(error){return webError(error);}}
