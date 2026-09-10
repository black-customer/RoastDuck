import {NextResponse} from 'next/server';
import {getMaterialSentences} from '@/lib/sentence-study/service';
import {sentenceError} from '@/lib/sentence-study/http';
export async function GET(_request:Request,{params}:{params:Promise<{id:string}>}){try{const lesson=await getMaterialSentences((await params).id);return NextResponse.json({lesson},{headers:{'Cache-Control':'no-store'}});}catch(e){return sentenceError(e);}}
