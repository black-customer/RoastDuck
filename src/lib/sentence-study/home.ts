import {nodeDatabase} from '@/lib/platform/node/database';
import {query as sql} from '@/lib/platform/sql';
import {readHomeActivity,projectHomeActivity} from '@/lib/home/activity';
import {sentenceStudy} from './service';
import type {SentenceMode,SentenceScope} from './contracts';
export async function getSentenceHomeOverview(){
  const now=new Date(),overview=await sentenceStudy.overview();
  const stats=await nodeDatabase.read(async db=>{
    const legacy=await readHomeActivity(db,now);
    const rows=await db.all<{day:string;count:number}>(sql`SELECT strftime('%Y-%m-%d',created_at,'+8 hours') day,COUNT(DISTINCT sentence_id) count FROM sentence_study_events WHERE kind='rate' GROUP BY day`);
    const counts=new Map(legacy.days.map(d=>[d.date,d.count]));
    // Streak can extend beyond the visible twelve weeks: read both histories, never infer missing dates.
    const legacyRows=await db.all<{day:string;count:number}>(sql`SELECT strftime('%Y-%m-%d',created_at,'+8 hours') day,COUNT(DISTINCT learning_item_id) count FROM light_study_events WHERE outcome IN ('exposure','diagnostic_exposure','self_report','consolidation') AND kind IN ('rate','advance') GROUP BY day`);
    for(const r of legacyRows)counts.set(r.day,r.count);for(const r of rows)counts.set(r.day,(counts.get(r.day)??0)+r.count);
    const activity=projectHomeActivity(counts,now,legacy.dailyIncomplete);
    const [{count}]=await db.all<{count:number}>(sql`SELECT COUNT(*) count FROM light_study_progress`);
    return {activity:{...activity,days:activity.days.map(d=>({...d,sentenceCount:rows.find(r=>r.day===d.date)?.count??0,legacyCount:legacyRows.find(r=>r.day===d.date)?.count??0}))},legacyStudiedCount:Number(count)};
  });
  const resumeByMode:Partial<Record<SentenceMode,{id:string;index:number;total:number;scope:SentenceScope;title:string}>>={};
  for(const mode of ['learn','review'] as const){const r=overview.resumable[mode];if(r){const v=await sentenceStudy.get(r.id);resumeByMode[mode]={...r,scope:v.scope};}}
  return {...stats,studiedSentenceCount:overview.studiedCount,sentence:{newCount:overview.newCount,dueCount:overview.dueCount,totalCount:overview.totalCount},resumeByMode};
}
export async function sentenceStudyQuestionOptions(mode:SentenceMode){const overview=await sentenceStudy.overview();return overview.sources.filter(s=>s.type==='question'&&(mode!=='review'||s.dueCount>0));}
export type SentenceHomeOverview=Awaited<ReturnType<typeof getSentenceHomeOverview>>;
