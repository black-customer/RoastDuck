import {NextResponse} from 'next/server';
import {sentenceHighlights} from '@/lib/sentence-study/highlights-web';
import {sentenceError} from '@/lib/sentence-study/http';
import {localJson} from '@/lib/http/local-write';
export async function GET(request:Request){try{return NextResponse.json(await sentenceHighlights.list(Object.fromEntries(new URL(request.url).searchParams)),{headers:{'Cache-Control':'no-store'}});}catch(error){return sentenceError(error);}}
export async function POST(request:Request){try{return NextResponse.json(await sentenceHighlights.add(await localJson(request,12000)));}catch(error){return sentenceError(error);}}
