import {NextResponse} from 'next/server';
import {webExpressions} from '@/lib/app-services/web';
import {scopeSchema} from '@/lib/light-study/contracts';
import {localJson} from '@/lib/http/local-write';
import {webError} from '@/lib/http/web-error';
export const dynamic='force-dynamic';
export async function GET(request:Request){try{const p=new URL(request.url).searchParams,scope=scopeSchema.parse(p.get('scope')?{type:p.get('scope'),id:p.get('id')}:{type:'all'});return NextResponse.json({items:await webExpressions.list(p.get('q')??'',scope,p.get('includeHidden')==='1')},{headers:{'Cache-Control':'no-store'}});}catch(error){return webError(error);}}
export async function PATCH(request:Request){try{return NextResponse.json({preference:await webExpressions.update(await localJson(request))});}catch(error){return webError(error);}}
