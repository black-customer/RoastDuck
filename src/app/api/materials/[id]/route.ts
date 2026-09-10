import {after,NextResponse} from 'next/server';
import {webCompanion} from '@/lib/app-services/web';
import {localJson} from '@/lib/http/local-write';
import {webError} from '@/lib/http/web-error';
import {z} from 'zod';
import {TrainingError} from '@/lib/four-step/shared';
import {nodeDatabase} from '@/lib/platform/node/database';
import {prepareCurrentMaterialRetry,resolveCurrentMaterial} from '@/lib/four-step/current-revision';
type Context={params:Promise<{id:string}>};
export async function GET(_request:Request,context:Context){try{
  const resolved=await resolveCurrentMaterial(nodeDatabase,(await context.params).id);
  return NextResponse.json({...await webCompanion().materials.inspect(resolved.material.id),requestedMaterialId:resolved.requestedMaterialId,successorMaterialId:resolved.transition?.toMaterialId??null,transition:resolved.transition});
}catch(error){return webError(error);}}
export async function POST(request:Request,context:Context){try{
  const options=z.object({retryUnknown:z.boolean().default(false)}).parse(await localJson(request)),id=(await context.params).id;
  const resolved=await resolveCurrentMaterial(nodeDatabase,id),current=await webCompanion().materials.inspect(resolved.material.id);
  if(current.diagnostic?.canRetry===false)throw new TrainingError(current.diagnostic.message,409,'request_configuration_required');
  if(current.diagnostic?.requiresConfirmation&&!options.retryUnknown)throw new TrainingError('上次结果未知，请确认可能再次计费后继续',409,'result_unknown');
  const prepared=await prepareCurrentMaterialRetry(nodeDatabase,id,new Date(),options);
  after(async()=>{await webCompanion().materials.process(prepared.material.id,{retry:true,...options});});
  return NextResponse.json({accepted:true,materialId:prepared.material.id,successorMaterialId:prepared.transition?.toMaterialId??null,transition:prepared.transition},{status:202});
}catch(error){return webError(error);}}
