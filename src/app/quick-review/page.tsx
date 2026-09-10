import Link from 'next/link';
import {QuickReview} from '@/components/expressions/QuickReview';
import {expressionScope} from '@/lib/light-study/scope-links';
import {LegacyModeGate,extensionHref} from '@/components/sentence-study/LegacyModeGate';
export default async function QuickReviewPage({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){
  const params=await searchParams;
  if(params.extension!=='1')return <LegacyModeGate title="快速回顾" href={extensionHref('/quick-review',params)}/>;
  const parsed=expressionScope(params);
  return parsed.success?<QuickReview key={JSON.stringify(parsed.data)} scope={parsed.data}/>:<div className="page-content"><p role="alert">回顾范围不正确，请从我的表达重新进入。</p><Link href="/expressions">我的表达</Link></div>;
}
