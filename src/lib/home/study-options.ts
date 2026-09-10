import {nodeDatabase} from '@/lib/platform/node/database';
import {query as sql} from '@/lib/platform/sql';
import {createLightCatalogue} from '@/lib/light-study/core-catalogue';
import type {LightMode} from '@/lib/light-study/contracts';

export interface StudyQuestionOption {id:string;text:string;textZh:string;part:number;topic:string;topicId:string|null;seasons:Array<{id:string;name:string}>;newCount:number;dueCount:number;totalCount:number;materialStatus:string|null;materialId:string|null;sourceId:string|null}
export async function studyQuestionOptions(mode:LightMode,now=new Date()):Promise<StudyQuestionOption[]>{
  return nodeDatabase.read(async db=>{
    const {cards,progress}=await createLightCatalogue(db,process.env.NODE_ENV==='test'||process.env.ROASTDUCK_E2E==='1').readLightCatalogue({type:'all'});
    const rows=await db.all<{id:string;text:string;text_zh:string;part:number;topic_id:string|null;topic:string}>(sql`SELECT q.id,q.text,q.text_zh,q.part,q.topic_id,COALESCE(t.name_zh,t.name_en,'未标注') AS topic FROM questions q LEFT JOIN topics t ON t.id=q.topic_id WHERE q.part IN(1,2,3) ORDER BY q.part,q.id`);
    const seasons=await db.all<{question_id:string;id:string;name:string}>(sql`SELECT DISTINCT l.question_id,s.id,s.name_zh AS name FROM question_set_links l JOIN question_sets s ON s.id=l.question_set_id`);
    const materials=await db.all<{question_id:string;id:string;source_id:string;status:string}>(sql`SELECT question_id,id,source_id,status FROM practice_materials WHERE question_id IS NOT NULL ORDER BY julianday(created_at) DESC,id DESC`);
    const byQuestion=new Map<string,Set<string>>();
    for(const card of cards)for(const source of card.sources??[]){
      if(!source.questionId)continue;
      if(!byQuestion.has(source.questionId))byQuestion.set(source.questionId,new Set());
      byQuestion.get(source.questionId)!.add(card.itemId);
    }
    const result=rows.map(q=>{
      const ids=[...byQuestion.get(q.id)??[]],material=materials.find(m=>m.question_id===q.id);
      return {id:q.id,text:q.text,textZh:q.text_zh,part:q.part,topic:q.topic,topicId:q.topic_id,
        seasons:seasons.filter(s=>s.question_id===q.id).map(s=>({id:s.id,name:s.name})),
        newCount:ids.filter(id=>!progress.has(id)).length,dueCount:ids.filter(id=>Date.parse(progress.get(id)?.due_at??'')<=now.getTime()).length,totalCount:ids.length,
        materialStatus:material?.status??null,materialId:material?.id??null,sourceId:material?.source_id??null};
    });
    return result.filter(q=>mode==='learn'||q.dueCount>0).sort((a,b)=>(mode==='learn'?b.newCount-a.newCount:b.dueCount-a.dueCount)||a.part-b.part||a.id.localeCompare(b.id));
  });
}
