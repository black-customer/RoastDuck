import {NextResponse} from 'next/server';
import {z} from 'zod';
import {syncManager} from '@/lib/device-sync/node/manager';
export const dynamic='force-dynamic';
export const runtime='nodejs';
function local(request:Request){
  const url=new URL(request.url),origin=request.headers.get('origin');
  const forwarded=request.headers.get('x-forwarded-for');
  return ['localhost','127.0.0.1','[::1]'].includes(url.hostname)&&(!origin||origin===url.origin)&&(!forwarded||['127.0.0.1','::1','::ffff:127.0.0.1'].includes(forwarded));
}
export async function GET(request:Request){if(!local(request))return NextResponse.json({error:'仅可在电脑本机管理同步'},{status:403});return NextResponse.json({enabled:false,status:'paused',message:'当前优先验证网页版，设备同步暂停'},{headers:{'Cache-Control':'no-store'}});}
export async function POST(request:Request){
  if(!local(request)||!request.headers.get('content-type')?.startsWith('application/json'))return NextResponse.json({error:'仅允许本机明确操作'},{status:403});
  try{const value=z.object({type:z.enum(['start','stop','approve','revoke','renew']),host:z.string().optional(),id:z.string().optional()}).strict().parse(await request.json());if(value.type!=='stop')return NextResponse.json({error:'设备同步已暂停',code:'feature_paused'},{status:409});await syncManager(value);return NextResponse.json({enabled:false,status:'paused'});}
  catch(error){return NextResponse.json({error:error instanceof Error?error.message:'同步服务未启动'},{status:400});}
}
