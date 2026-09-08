import {redirect} from 'next/navigation';

export const dynamic = "force-dynamic";

export default async function LearnPage({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string; question?: string }>;
}) {
  const { mode, question } = await searchParams;
  const params=new URLSearchParams({mode:mode==='review'?'review':'learn'});
  if(question){params.set('scope','question');params.set('id',question);}
  redirect(`/light-study?${params}`);
}
