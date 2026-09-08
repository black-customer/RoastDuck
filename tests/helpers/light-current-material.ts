import type {Db} from '@db/client';
import {sql} from 'drizzle-orm';
import {authoredMaterialSchema,authorHash,type OfflineReview,type RecoverySource} from '@/lib/four-step/offline-contracts';

/** Synthetic, isolated source with two independently compiled material snapshots. */
export async function currentMaterialFixture(db:Db,id:string,actions:ReadonlyArray<readonly [string,string]>){
  const questionId=`current-material-q-${id}`,questionEn='What would you like to do?',questionZh='你想做什么？';
  const english='I want to do those things.',chinese=`我想${actions.map(action=>action[1]).join('和')}。`;
  const target=actions.map(action=>action[0]).join(' and '),natural=`I want to ${target}.`;
  const schema=await import('@db/schema');
  await db.insert(schema.questions).values({id:questionId,bookId:'retired',part:1,text:questionEn,textZh:questionZh,normText:questionId});
  await db.insert(schema.speakingQuestionAttempts).values({id,questionId,mode:'practice',answerText:english,intendedMeaningZh:chinese,status:'processing'});
  const source:RecoverySource={index:0,key:id,kind:'attempt',hash:`synthetic-current-${id}`,createdAt:'2026-08-01T00:00:00.000Z',mode:'practice',questionId,questionEn,questionZh,part:1,
    english,chinese,en:[{index:0,start:0,end:english.length,text:english}],zh:[{index:0,start:0,end:chinese.length,text:chinese}]};

  async function publish(version:'old'|'new'){
    // Same source and full meaning, with two legal analysis modes producing distinct input snapshots.
    // The old reviewed version groups the actions; the new reviewed version has individual targets.
    const mode=version==='old'?'practice':'exam_style';
    const targets=version==='old'?[[target,actions.map(action=>action[1]).join('和')] as const]:actions;
    const author=authoredMaterialSchema.parse({index:0,sourceHash:source.hash,contextId:`synthetic-author-${id}-${version}`,model:'synthetic current-material author',
      units:[{en:[0],zh:[0],intent:chinese,status:'repair',reason:'合成原文没有表达两个明确动作。',english:natural,
        gaps:targets.map(([en,zh])=>({cue:zh,target:en,quote:english,why:'根据本次中文原意补足动作。',surface:en}))}]});
    const review:OfflineReview={authorHash:authorHash(author),contextId:`synthetic-reviewer-${id}-${version}`,model:'synthetic current-material reviewer',
      selection:{approved:true,reasonZh:'合成审核保留两个动作及其原意。',units:[{unitId:'u0',status:'repair',evidenceQuote:english,reasonZh:'两个动作均来自原文。'}],
        gaps:targets.map((_,index)=>({gapId:`g0_${index}`,decision:'train',evidenceQuote:english,reasonZh:'合成动作与中文原意对应。'}))},
      review:{approved:true,reasonZh:'合成材料与完整原意对应。',rows:targets.map((_,index)=>({gapId:`g0_${index}`,approved:true,evidenceQuote:english,reasonZh:'保留动作原意与对应表达。',repairNeeded:true,meaningPreserved:true,minimalRepair:true,cueUnambiguous:true,sentenceAligned:true,clozeValid:true}))}};
    const material=await(await import('@/lib/four-step/offline-apply')).applyOfflineMaterial({...source,mode},author,review);
    const {nodeDatabase}=await import('@/lib/platform/node/database');
    const {auditPracticeMaterials}=await import('@/lib/four-step/audit');
    const audit=await nodeDatabase.read(tx=>auditPracticeMaterials({execute:async statement=>({rows:await tx.all<Record<string,unknown>>(typeof statement==='string'?{sql:statement}:statement)})},true,[material.id]));
    if(!audit.ok||audit.checked!==1)throw new Error(`Synthetic material failed evidence audit: ${JSON.stringify(audit.issues)}`);
    const items=await db.all<{learning_item_id:string}>(sql`SELECT learning_item_id FROM practice_material_items WHERE material_id=${material.id} ORDER BY row_index`);
    return {materialId:material.id,itemIds:items.map(item=>item.learning_item_id)};
  }

  async function pending(){
    // Additional raw-input metadata creates an unprocessed snapshot; no processing service is called.
    return (await import('@/lib/four-step/materials')).prepareMaterial({sourceType:'ielts_practice',sourceId:id,question:{id:questionId,textEn:questionEn,textZh:questionZh,part:1},
      mode:'practice',actualAnswer:english,intendedMeaningZh:chinese,rawInput:english});
  }
  return {sourceId:id,questionId,publish,pending};
}
