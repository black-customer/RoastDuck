import {randomUUID} from "node:crypto";
import {nodeDatabase} from "@/lib/platform/node/database";
import {executeAuditedAiCall} from "@/lib/ai/job-service";
import {createAiProvider} from "@/lib/ai/provider-factory";
import {fourStepMockResolver,prompt} from "./materials";
import {createTrainingService} from "./core-training";
const service=createTrainingService({database:nodeDatabase,now:()=>new Date(),newId:randomUUID,bootId:randomUUID(),loadPrompt:prompt,allowMock:process.env.NODE_ENV==="test"||process.env.ROASTDUCK_E2E==="1",
  runtime:{call:request=>executeAuditedAiCall(createAiProvider({mockResolver:fourStepMockResolver}),null,request,{maxAttempts:1})}});
export const {trainingView,createTraining,applyTrainingEvent,saveDraft:saveTrainingDraft}=service;
