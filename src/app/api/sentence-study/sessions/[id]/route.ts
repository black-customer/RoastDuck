import {NextResponse} from 'next/server';
import {sentenceStudy} from '@/lib/sentence-study/service';
import {sentenceError} from '@/lib/sentence-study/http';
export async function GET(_request:Request,{params}:{params:Promise<{id:string}>}){try{return NextResponse.json({session:await sentenceStudy.get((await params).id)});}catch(e){return sentenceError(e);}}
