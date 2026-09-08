import {NextResponse} from 'next/server';
import {webExpressions} from '@/lib/app-services/web';
import {expressionScope} from '@/lib/light-study/scope-links';
import {localJson} from '@/lib/http/local-write';
import {webError} from '@/lib/http/web-error';
export const dynamic='force-dynamic';
export async function GET(request:Request){
  try{
    const params=new URL(request.url).searchParams,parsed=expressionScope({scope:'all',...Object.fromEntries(params)});
    if(!parsed.success)throw parsed.error;
    const scope=parsed.data;
    const [items,summary]=await Promise.all([
      params.get('summaryOnly')==='1'?Promise.resolve([]):webExpressions.list(params.get('q')??'',scope,params.get('includeHidden')==='1'),
      webExpressions.summary(scope),
    ]);
    return NextResponse.json({items,summary},{headers:{'Cache-Control':'no-store'}});
  }catch(error){
    const response=webError(error);
    response.headers.set('Cache-Control','no-store');
    return response;
  }
}
export async function PATCH(request:Request){try{return NextResponse.json({preference:await webExpressions.update(await localJson(request))});}catch(error){return webError(error);}}
