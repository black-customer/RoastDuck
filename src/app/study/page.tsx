import {getHomeOverview} from '@/lib/home/overview';
import {studyQuestionOptions} from '@/lib/home/study-options';
import {StudyChoices} from '@/components/home/StudyChoices';
export const dynamic='force-dynamic';
export default async function StudyPage({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){
  const params=await searchParams,mode=params.mode==='review'?'review':'learn';
  const [overview,questions]=await Promise.all([getHomeOverview(),params.choose==='questions'?studyQuestionOptions(mode):Promise.resolve(undefined)]);
  return <StudyChoices mode={mode} overview={overview.light} questions={questions}/>;
}
