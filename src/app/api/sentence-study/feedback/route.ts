import {NextResponse} from 'next/server';
import {sentencePreferences} from '@/lib/sentence-study/preferences-web';
import {sentenceError} from '@/lib/sentence-study/http';
import {localJson} from '@/lib/http/local-write';
export async function POST(request:Request){try{return NextResponse.json(await sentencePreferences.feedback(await localJson(request,24000)));}catch(error){return sentenceError(error);}}
