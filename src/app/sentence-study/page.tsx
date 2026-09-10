import {SentenceStudyPanel} from '@/components/sentence-study/SentenceStudyPanel';
import {sentenceScopeSchema,type SentenceCreate} from '@/lib/sentence-study/contracts';
export const dynamic='force-dynamic';
export default async function SentenceStudyPage({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){
  const params=await searchParams,scope=params.scope??'all';
  const candidate=scope==='all'?{type:'all'}:scope==='collection'?{type:scope,id:params.id,...Object.fromEntries(['questionId','topicId','seasonId'].flatMap(key=>typeof params[key]==='string'?[[key,params[key]]]:[]))}:{type:scope,id:params.id};
  const parsed=sentenceScopeSchema.safeParse(candidate),sessionId=typeof params.session==='string'?params.session:undefined;
  const input:SentenceCreate={scope:parsed.success?parsed.data:{type:'all'},mode:params.mode==='review'?'review':'learn',clientRequestId:crypto.randomUUID(),selection:params.selection==='random'?'random':params.selection==='due'?'due':'scope'};
  return <SentenceStudyPanel key={sessionId??JSON.stringify(input.scope)} sessionId={sessionId} resumeOnLoad={params.resume==='1'} input={input} initialError={parsed.success?undefined:'学习范围不正确，请返回选题。'}/>;
}
