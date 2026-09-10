import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {nodeDatabase} from '@/lib/platform/node/database';
import {prepareMaterialIn} from '@/lib/four-step/core-materials';
import {createAnswerService} from './answers';
import {createExpressionService} from './expressions';
import {createAiProvider} from '@/lib/ai/provider-factory';
import type {AiProvider} from '@/lib/ai/contracts';
import {createRuntimeCalls} from '@/lib/ai/runtime-ledger';
import {createMaterialService} from '@/lib/four-step/core-materials';
import {fourStepMockResolver,prompt} from '@/lib/four-step/materials';
import {createMemoryService} from './memory';
import {createChatService,type AppConversation,type AppMessage} from './chat';
import {createPracticeComparison,assertComparisonOutput} from './answer-comparison';
import {createCoachingService} from '@/lib/coaching/service';
import {getMaterialSentences} from '@/lib/sentence-study/service';
import {TrainingError} from '@/lib/four-step/shared';
import {coachingMock} from '@/lib/coaching/mock';
import {assertCoachingFeedback} from '@/lib/coaching/contracts';
const webMockAllowed=()=>{
  if(process.env.VITEST)return true;
  const url=process.env.ROASTDUCK_DB??'';if(process.env.AI_PROVIDER!=='mock'||!url.startsWith('file:'))return false;
  const relative=path.relative(path.resolve('test-results'),path.resolve(url.slice(5)));
  return !!relative&&!relative.startsWith('..')&&!path.isAbsolute(relative);
};
/** Web adapters construct no device/sync state and perform no Runtime calls on reads. */
export const webAnswers=createAnswerService(nodeDatabase,{prepareIn:(tx,input)=>prepareMaterialIn(tx,input,new Date().toISOString())},{now:()=>new Date(),newId:randomUUID,allowMock:webMockAllowed()});
export const webExpressions=createExpressionService(nodeDatabase,webMockAllowed());
function buildCompanion(){
  const factory=()=>createAiProvider({mockResolver:request=>{
    if(['sentence_coaching_v1','coaching_error_reviewer_v1'].includes(request.schemaName))return coachingMock(request);
    if(request.schemaName==='practice_reanswer_comparison_v1'){const p=JSON.parse(request.input);return {comparisons:p.oldItems.map((r:{index:number})=>({index:r.index,state:'uncertain',evidenceQuote:'',reasonZh:'隔离模拟：没有足够证据判断修复。'})),newItemIndexes:[]};}
    if(request.schemaName==='companion_dialogue_v2')return {messages:[{text:'That sounds interesting. What do you enjoy most about it?',translationZh:'听起来很有意思，你最喜欢它的哪一点？',purpose:'follow_up'}],usedLearningItemIds:[],glossary:[]};
    return fourStepMockResolver(request);
  }});
  const provider:AiProvider={get providerName(){return factory().providerName;},get model(){return factory().model;},generate:async(request,context)=>{const result=await factory().generate(request,context);if(request.schemaName==='practice_reanswer_comparison_v1')assertComparisonOutput(result.data,JSON.parse(request.input));if(request.schemaName==='sentence_coaching_v1')assertCoachingFeedback(result.data,JSON.parse(request.input));return result;}};
  const platform={now:()=>new Date(),newId:randomUUID,bootId:randomUUID(),loadPrompt:prompt,allowMock:webMockAllowed()};
  const runtime=createRuntimeCalls(nodeDatabase,provider,platform),materials=createMaterialService({database:nodeDatabase,runtime,...platform}),memory=createMemoryService(nodeDatabase,runtime,platform);
  return {runtime,materials,memory,coaching:createCoachingService(nodeDatabase,runtime,memory,{...platform,loadMaterial:async context=>{
    const material=await getMaterialSentences(context.materialId);
    if(!material||!material.sentences.length)throw new TrainingError('本次句子材料尚未准备好或已移除，原输出保留',409,'coaching_material_unavailable');
    return {...material,questionEn:material.questionEn||'Retell the idea from this conversation in your own words.',questionZh:material.questionZh||'用自己的话表达这段对话想说的意思。'};
  }}),comparison:createPracticeComparison(nodeDatabase,runtime,prompt),chat:createChatService(nodeDatabase,runtime,memory,materials,platform)};
}
const globalWeb=globalThis as typeof globalThis&{roastduckWebCompanion?:ReturnType<typeof buildCompanion>};
export function webCompanion(){return globalWeb.roastduckWebCompanion??=buildCompanion();}
export const conversationView=(c:AppConversation)=>({id:c.id,title:c.title,mode:c.mode,status:c.status,createdAt:c.created_at,updatedAt:c.updated_at});
export const messageView=(m:AppMessage)=>({id:m.id,conversationId:m.conversation_id,sequenceNo:m.sequence_no,role:m.role,text:m.text,metadata:JSON.parse(m.metadata_json),teachingState:m.teaching_state,targetRepetition:m.target_repetition,gapCount:m.gap_count,createdAt:m.created_at});
