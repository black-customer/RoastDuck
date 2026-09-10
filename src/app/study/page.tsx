import {sentenceOverview} from '@/lib/sentence-study/service';
import {StudyChoices} from '@/components/home/StudyChoices';
export const dynamic='force-dynamic';
export default async function StudyPage({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){
  const params=await searchParams,mode=params.mode==='review'?'review':'learn';
  const overview=await sentenceOverview({type:'all'});
  return <StudyChoices mode={mode} overview={overview} chooseQuestions={params.choose==='questions'}/>;
}
