import {redirect} from 'next/navigation';
import {LegacyModeGate,extensionHref} from '@/components/sentence-study/LegacyModeGate';

export const dynamic = "force-dynamic";

export default async function LearnPage({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string; question?: string;extension?:string }>;
}) {
  const query=await searchParams;
  if(query.extension!=='1')return <LegacyModeGate title="旧学习入口" href={extensionHref('/learn',query)}/>;
  const {mode,question}=query;
  const params=new URLSearchParams({mode:mode==='review'?'review':'learn'});
  params.set('extension','1');
  if(question){params.set('scope','question');params.set('id',question);}
  redirect(`/light-study?${params}`);
}
