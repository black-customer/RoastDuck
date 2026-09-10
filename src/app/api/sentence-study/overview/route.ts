import {NextResponse} from 'next/server';
import {sentenceStudy} from '@/lib/sentence-study/service';
import {sentenceError,sentenceScopeFromUrl} from '@/lib/sentence-study/http';
export async function GET(request:Request){try{return NextResponse.json({overview:await sentenceStudy.overview(sentenceScopeFromUrl(request.url))});}catch(e){return sentenceError(e);}}
