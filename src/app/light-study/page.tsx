import { LightStudy } from "@/components/light-study/LightStudy";
import {expressionScope} from '@/lib/light-study/scope-links';
import {getLightView} from "@/lib/light-study/service";
import {LegacyModeGate,extensionHref} from '@/components/sentence-study/LegacyModeGate';
export const dynamic="force-dynamic";
export default async function LightStudyPage({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}) {
  const params=await searchParams;
  if(params.extension!=='1')return <LegacyModeGate title="语块轻学习" href={extensionHref('/light-study',params)}/>;
  const parsed=expressionScope({...params,scope:params.scope||'all'});
  let scope=parsed.success?parsed.data:{type:"all" as const};
  let error=parsed.success?undefined:"学习范围不正确，请返回首页重新进入。";
  const sessionId=typeof params.session==="string"?params.session:undefined;
  if(sessionId)try{scope=(await getLightView(sessionId)).scope;error=undefined;}catch{error="暂时无法恢复这组学习，原记录没有被清空。";}
  return <LightStudy scope={scope} initialError={error} initialSessionId={sessionId} initialMode={params.mode==='review'?'review':params.mode==='learn'?'learn':undefined} />;
}
