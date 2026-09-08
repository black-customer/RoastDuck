import {after,NextResponse} from 'next/server';
import {z} from 'zod';
import {webCompanion,messageView} from '@/lib/app-services/web';
import {localJson} from '@/lib/http/local-write';
import {webError} from '@/lib/http/web-error';
export const dynamic='force-dynamic';
type Context={params:Promise<{id:string}>};
export async function GET(_request:Request,context:Context){try{return NextResponse.json({messages:(await webCompanion().chat.messages((await context.params).id)).map(messageView)});}catch(error){return webError(error);}}
export async function POST(request:Request,context:Context){try{
  const input=z.object({text:z.string().min(1).max(8000),clientMessageId:z.string().min(8),retry:z.boolean().default(false),retryUnknown:z.boolean().default(false)}).parse(await localJson(request)),id=(await context.params).id,services=webCompanion();
  const user=await services.chat.prepare(id,input),messages=(await services.chat.process(id,user.id,{retryFailed:input.retry,retryUnknown:input.retryUnknown})).map(messageView);
  after(async()=>{const c=await services.chat.get(id);if(c.thread_id)await services.memory.extract(c.thread_id).catch(()=>undefined);});
  return NextResponse.json({messages,userMessageId:user.id,assistantMessage:messages.filter(m=>m.role==='assistant').at(-1)});
}catch(error){return webError(error);}}
