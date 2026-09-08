import Link from 'next/link';
import {QuickReview} from '@/components/expressions/QuickReview';
import {expressionScope} from '@/lib/light-study/scope-links';
export default async function QuickReviewPage({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){
  const parsed=expressionScope(await searchParams);
  return parsed.success?<QuickReview key={JSON.stringify(parsed.data)} scope={parsed.data}/>:<div className="page-content"><p role="alert">回顾范围不正确，请从我的表达重新进入。</p><Link href="/expressions">我的表达</Link></div>;
}
