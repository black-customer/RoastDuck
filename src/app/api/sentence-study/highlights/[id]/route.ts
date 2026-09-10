import {NextResponse} from 'next/server';
import {sentenceHighlights} from '@/lib/sentence-study/highlights-web';
import {sentenceError} from '@/lib/sentence-study/http';
import {localJson} from '@/lib/http/local-write';
export async function DELETE(request:Request,{params}:{params:Promise<{id:string}>}){try{return NextResponse.json(await sentenceHighlights.remove((await params).id,await localJson(request,2000)));}catch(error){return sentenceError(error);}}
