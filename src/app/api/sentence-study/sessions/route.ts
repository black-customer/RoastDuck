import {NextResponse} from 'next/server';
import {sentenceStudy} from '@/lib/sentence-study/service';
import {sentenceError} from '@/lib/sentence-study/http';
import {localJson} from '@/lib/http/local-write';
export async function POST(request:Request){try{return NextResponse.json({session:await sentenceStudy.create(await localJson(request))});}catch(e){return sentenceError(e);}}
