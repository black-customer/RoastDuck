import { LightStudy } from "@/components/light-study/LightStudy";
import { scopeSchema } from "@/lib/light-study/contracts";
import {getLightView} from "@/lib/light-study/service";
export const dynamic="force-dynamic";
export default async function LightStudyPage({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}) {
  const params=await searchParams;
  const parsed=scopeSchema.safeParse(!params.scope||params.scope==="all"?{type:"all"}:{type:params.scope,id:params.id});
  let scope=parsed.success?parsed.data:{type:"all" as const};
  let error=parsed.success?undefined:"学习范围不正确，请返回首页重新进入。";
  const sessionId=typeof params.session==="string"?params.session:undefined;
  if(sessionId)try{scope=(await getLightView(sessionId)).scope;error=undefined;}catch{error="暂时无法恢复这组学习，原记录没有被清空。";}
  return <LightStudy key={JSON.stringify(scope)+sessionId} scope={scope} initialError={error} initialSessionId={sessionId} initialMode={params.mode==='review'?'review':undefined} />;
}
