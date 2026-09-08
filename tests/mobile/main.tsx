import {createRoot} from "react-dom/client";
import {createNativeDatabaseManager} from "@/lib/platform/android/database";
import {installQuestionBank} from "@/lib/platform/android/question-bank";
import {createAppServices} from "@/lib/app-services";
import {selectionMockResolver} from "@/lib/four-step/selection-mock";
import {normalizeExpression} from "@/lib/four-step/contracts";
import type {AiProvider} from "@/lib/ai/contracts";
import bank from "@public-question-bank";
import {MobileApp} from "../../mobile/src/App";
import {loadPrompt} from "../../mobile/src/prompts";
import "../../mobile/src/styles.css";
declare const __NATIVE_TEST_DB__:string;
declare global {interface Window {roastduckQaSnapshot?:()=>Promise<unknown>}}
const provider:AiProvider={providerName:"mock",model:"deepseek-v4-flash",async generate(request){
  const input=JSON.parse(request.input);let data:unknown;
  if(request.schemaName==="companion_dialogue_v2")data={messages:[{text:"That makes sense. Tell me a little more.",translationZh:"我明白了，再多说一点吧。",purpose:"natural_response"},{text:"You can take your time.",translationZh:"可以慢慢来。",purpose:"follow_up"}],usedLearningItemIds:[],glossary:[]};
  else if(request.schemaName==="companion_memory_extractor_v1")data={memories:[]};
  else if(request.schemaName==="four_step_judge_v1")data={verdict:normalizeExpression(input.input)===normalizeExpression(input.answer)?"correct":"incorrect",meaningPreserved:normalizeExpression(input.input)===normalizeExpression(input.answer),feedbackZh:"合成判定，仅供界面测试。"};
  else data=await selectionMockResolver(request);
  return {data:request.schema.parse(data),responseId:`mock-${crypto.randomUUID()}`,latencyMs:1,usage:{inputTokens:0,outputTokens:0,cachedTokens:0,reasoningTokens:0}};
}};
async function main(){
  const {database}=await createNativeDatabaseManager(__NATIVE_TEST_DB__)();await installQuestionBank(database,bank);
  await database.write(async tx=>{
    await tx.run({sql:"INSERT INTO questions(id,book_id,part,text,text_zh,norm_text) VALUES('native-ui-question','removed',1,'Do you live alone?','你一个人住吗？','native-ui-question') ON CONFLICT DO NOTHING"});
    await tx.run({sql:"INSERT INTO user_settings(id,auto_play,default_accent) VALUES(1,0,'en-US') ON CONFLICT DO NOTHING"});
  });
  const services=await createAppServices({database,provider,allowMock:true,now:()=>new Date(),newId:()=>crypto.randomUUID(),bootId:crypto.randomUUID(),loadPrompt,
    speech:{prepare:async()=>({assetId:"synthetic-audio",url:"/synthetic-tone.wav",provider:"mimo",cached:true})}});
  window.roastduckQaSnapshot=()=>database.read(async tx=>{
    const result:Record<string,unknown>={database:__NATIVE_TEST_DB__};
    for(const table of ['speaking_question_attempts','practice_materials','light_study_progress','light_study_events','four_step_sessions','free_talk_messages'])result[table]=(await tx.all<{n:number}>({sql:`SELECT count(*) n FROM ${table}`}))[0].n;
    result.schema=(await tx.all<{schema_version:number}>({sql:'SELECT schema_version FROM _native_schema_bootstrap'}))[0].schema_version;return result;
  });
  if((await services.recent()).materials.length)localStorage.setItem('roastduck_mobile_setup','1');
  createRoot(document.getElementById("root")!).render(<MobileApp services={services}/>);
}
void main().catch(error=>{document.getElementById("root")!.textContent=String(error);});
