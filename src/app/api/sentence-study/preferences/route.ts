import {NextResponse} from 'next/server';
import {sentencePreferences} from '@/lib/sentence-study/preferences-web';
import {sentenceError,sentenceScopeFromUrl} from '@/lib/sentence-study/http';
import {localJson} from '@/lib/http/local-write';
export async function GET(request:Request){try{return NextResponse.json(await sentencePreferences.list(sentenceScopeFromUrl(request.url)),{headers:{'Cache-Control':'no-store'}});}catch(error){return sentenceError(error);}}
export async function POST(request:Request){try{return NextResponse.json(await sentencePreferences.set(await localJson(request,24000)));}catch(error){return sentenceError(error);}}
