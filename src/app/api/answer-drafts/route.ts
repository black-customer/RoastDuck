import {NextResponse} from 'next/server';
import {z} from 'zod';
import {webAnswers} from '@/lib/app-services/web';
import {localJson} from '@/lib/http/local-write';
import {webError} from '@/lib/http/web-error';
export const dynamic='force-dynamic';
export async function GET(request:Request){try{return NextResponse.json({drafts:await webAnswers.drafts(new URL(request.url).searchParams.get('questionId')??undefined)},{headers:{'Cache-Control':'no-store'}});}catch(error){return webError(error);}}
export async function POST(request:Request){try{const input=z.object({questionId:z.string(),clientId:z.string(),sourceAttemptId:z.string().nullable().default(null),kind:z.enum(['practice','independent','edit']).default('practice')}).strict().parse(await localJson(request));return NextResponse.json({draft:await webAnswers.start(input.questionId,input.clientId,input.sourceAttemptId,input.kind)});}catch(error){return webError(error);}}
