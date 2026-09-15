import {ExpressionLibrary} from '@/components/ExpressionLibrary';
import {PageHeader} from '@/components/ui/PageHeader';
import {SentenceLibrary} from '@/components/expressions/SentenceLibrary';
import {sentenceOverview} from '@/lib/sentence-study/service';
import {sentenceScopeSchema} from '@/lib/sentence-study/contracts';
import Link from 'next/link';
export const dynamic='force-dynamic';
export default async function SearchPage({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){
  const params=await searchParams;
  if(params.extension==='1')return <div className="page-content"><PageHeader title="搜索旧表达" description="这里保留拓展功能中的旧表达和记录。"/><ExpressionLibrary/></div>;
  const value=(key:string)=>typeof params[key]==='string'?params[key] as string:undefined,type=value('scope')??'all';
  const parsed=sentenceScopeSchema.safeParse(type==='all'?{type}:{type,id:value('id'),...(type==='collection'?{questionId:value('questionId'),topicId:value('topicId'),seasonId:value('seasonId')}:{})});
  if(!parsed.success)return <div className="page-content"><p role="alert">搜索范围不正确。</p><Link href="/search">重新搜索当前材料</Link></div>;
  return <div className="page-content"><PageHeader title="搜索我的表达" description="查找当前句子、用法、收藏和备注，再回到完整回答中练习。"/><SentenceLibrary overview={await sentenceOverview({type:'all'})} initialScope={parsed.data} initialQuery={value('q')??''} search/></div>;
}
