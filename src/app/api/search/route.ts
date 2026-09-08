import {NextResponse} from 'next/server';
import {webExpressions} from '@/lib/app-services/web';
import {webError} from '@/lib/http/web-error';
export const dynamic='force-dynamic';
export async function GET(request:Request){try{const q=new URL(request.url).searchParams.get('q')??'',items=q.trim()?await webExpressions.list(q):[];return NextResponse.json({results:items.slice(0,100).map(item=>({id:item.itemId,display:item.english,meaningZh:item.chinese,sourceHref:item.sourceHref,materialId:item.materialId}))});}catch(error){return webError(error);}}
