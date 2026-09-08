import type { Db } from "@db/client";
import { authoredMaterialSchema, authorHash, type RecoverySource, type OfflineReview } from "@/lib/four-step/offline-contracts";

/** 仅隔离测试的合成资料；通过真实编译器生成完整审核链，不写生产。 */
export async function publishLightFixture(db:Db,id:string,target:string,chinese:string,questionId=`light-q-${id}`) {
  const schema=await import("@db/schema");
  const question="What would you like to do?",english="I want to do that.",meaning=`我想${chinese}。`;
  await db.insert(schema.questions).values({id:questionId,bookId:"retired",part:1,text:question,textZh:"你想做什么？",normText:questionId}).onConflictDoNothing();
  await db.insert(schema.speakingQuestionAttempts).values({id,questionId,mode:"practice",answerText:english,intendedMeaningZh:meaning,status:"processing"});
  const source:RecoverySource={index:0,key:id,kind:"attempt",hash:`fixture-${id}`,createdAt:new Date().toISOString(),mode:"practice",questionId,questionEn:question,questionZh:"你想做什么？",part:1,
    english,chinese:meaning,en:[{index:0,start:0,end:english.length,text:english}],zh:[{index:0,start:0,end:meaning.length,text:meaning}]};
  const author=authoredMaterialSchema.parse({index:0,sourceHash:source.hash,contextId:`synthetic-author-${id}`,model:"synthetic fixture author",
    units:[{en:[0],zh:[0],intent:meaning,status:"repair",reason:"合成样例：原文that没有说出中文动作",english:`I want to ${target}.`,gaps:[{cue:chinese,target,quote:english,why:"合成回归中的明确动作替换",surface:target}]}]});
  const review:OfflineReview={authorHash:authorHash(author),contextId:`synthetic-reviewer-${id}`,model:"synthetic fixture reviewer",
    selection:{approved:true,reasonZh:"合成测试审核",units:[{unitId:"u0",status:"repair",evidenceQuote:english,reasonZh:"补足中文已给动作"}],gaps:[{gapId:"g0_0",decision:"train",evidenceQuote:english,reasonZh:"合成样例动作"}]},
    review:{approved:true,reasonZh:"合成测试四列对应",rows:[{gapId:"g0_0",approved:true,evidenceQuote:english,reasonZh:"按中文动作编译",repairNeeded:true,meaningPreserved:true,minimalRepair:true,cueUnambiguous:true,sentenceAligned:true,clozeValid:true}]}};
  const result=await(await import("@/lib/four-step/offline-apply")).applyOfflineMaterial(source,author,review);
  return {materialId:result.id,questionId,attemptId:id};
}
