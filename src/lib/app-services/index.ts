import type {DatabasePort} from "@/lib/platform/database";
import {query as sql} from "@/lib/platform/sql";
import type {AiProvider} from "@/lib/ai/contracts";
import {createRuntimeCalls} from "@/lib/ai/runtime-ledger";
import {createLightService} from "@/lib/light-study/core-service";
import {createMaterialService} from "@/lib/four-step/core-materials";
import {createAnswerService} from "./answers";
import {createQuestionService} from "./queries";
import {createAppSettings} from "./settings";
import {createMemoryService} from "./memory";
import {createChatService} from "./chat";
import type {SpeechPort} from "@/lib/speech/ports";
import {createTrainingService} from "@/lib/four-step/core-training";
import {createExpressionService} from './expressions';
import {createDeviceSync} from '@/lib/device-sync/service';
import {localOwnerFilter} from '@/lib/device-sync/ownership';
export interface AppPlatform {database:DatabasePort;provider:AiProvider;speech?:SpeechPort;now:()=>Date;newId:()=>string;bootId:string;loadPrompt:(name:string)=>string|Promise<string>;allowMock?:boolean}
/** Construct once per application boot. Initializing device metadata is explicit, not a question GET side effect. */
export async function createAppServices(platform:AppPlatform){
  const {database}=platform;
  const identity=await database.write(async tx=>{
    await tx.run(sql`INSERT INTO app_device(singleton,device_id,dataset_id,created_at) VALUES(1,${`device_${platform.newId()}`},${`dataset_${platform.newId()}`},${platform.now().toISOString()}) ON CONFLICT DO NOTHING`);
    return (await tx.all<{device_id:string;dataset_id:string}>(sql`SELECT * FROM app_device WHERE singleton=1`))[0];
  });
  const runtime=createRuntimeCalls(database,platform.provider,platform),materials=createMaterialService({...platform,runtime});
  const memory=createMemoryService(database,runtime,platform);
  const light=createLightService(database,{...platform,enabled:()=>true});
  const settings=createAppSettings(database,platform.now);
  const recent=()=>database.read(async tx=>({
    sessions:await tx.all<{id:string;mode:"learn"|"review";scope_json:string;status:string}>(sql`SELECT id,mode,scope_json,status FROM light_study_sessions WHERE status IN ('active','paused') AND ${localOwnerFilter('light_study_sessions','light_study_sessions.id')} ORDER BY julianday(updated_at) DESC,id LIMIT 1`),
    materials:await tx.all<{id:string;source_type:string;source_id:string;question_id:string|null;status:string;error_code:string|null;title:string}>(sql`SELECT m.id,m.source_type,m.source_id,m.question_id,m.status,m.error_code,COALESCE(q.text_zh,q.text,c.title,'我的表达') title FROM practice_materials m LEFT JOIN questions q ON q.id=m.question_id LEFT JOIN free_talk_conversations c ON c.id=m.source_id
      ORDER BY julianday(m.updated_at) DESC,m.id DESC LIMIT 8`),
  }));
  return {identity,runtime,light,materials,settings,memory,recent,sync:createDeviceSync(database,identity,platform),speech:platform.speech,expressions:createExpressionService(database,platform.allowMock),training:createTrainingService({...platform,runtime}),
    questions:createQuestionService(database),answers:createAnswerService(database,materials,platform),chat:createChatService(database,runtime,memory,materials,platform)};
}
export type AppServices=Awaited<ReturnType<typeof createAppServices>>;
