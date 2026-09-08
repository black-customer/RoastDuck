import {NextResponse} from 'next/server';
import path from 'node:path';
import {credentialInputSchema,saveServerCredential} from '@/lib/settings-credentials';
import {localJson,LocalWriteError} from '@/lib/http/local-write';
export const dynamic='force-dynamic';
export async function POST(request:Request){
  let input:unknown;try{input=await localJson(request,4096);}catch(error){return NextResponse.json({error:error instanceof Error?error.message:'请求不合法'},{status:error instanceof LocalWriteError?error.status:400});}
  const parsed=credentialInputSchema.safeParse(input);if(!parsed.success)return NextResponse.json({error:'请输入完整有效的 Key；不含空格或换行'},{status:400});
  try{
    const testing=process.env.ROASTDUCK_E2E==='1'||process.env.NODE_ENV==='test'||!!process.env.VITEST;
    const root=testing?path.resolve('test-results/web-credentials'):process.cwd();
    await saveServerCredential(root,parsed.data);
    const name=parsed.data.provider==='mimo'?'MIMO_API_KEY':'DEEPSEEK_API_KEY';
    process.env[name]=parsed.data.key??'';
    return NextResponse.json({configured:parsed.data.key!==null},{headers:{'Cache-Control':'no-store'}});
  }catch{return NextResponse.json({error:'本机配置未保存成功，原配置保留，请重试'},{status:503});}
}
