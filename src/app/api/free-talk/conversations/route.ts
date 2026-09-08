import {NextResponse} from 'next/server';
import {z} from 'zod';
import {webCompanion,conversationView} from '@/lib/app-services/web';
import {localJson} from '@/lib/http/local-write';
import {webError} from '@/lib/http/web-error';
export const dynamic='force-dynamic';
export async function GET(){try{return NextResponse.json({conversations:(await webCompanion().chat.list()).map(conversationView)});}catch(error){return webError(error);}}
export async function POST(request:Request){try{const input=z.object({clientRequestId:z.string().min(8),title:z.string().optional(),mode:z.enum(['relaxed','strict']).optional()}).parse(await localJson(request));return NextResponse.json({conversation:conversationView(await webCompanion().chat.create(input))},{status:201});}catch(error){return webError(error);}}
