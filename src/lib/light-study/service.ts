import { randomUUID } from "node:crypto";
import { nodeDatabase } from "@/lib/platform/node/database";
import { createLightService } from "./core-service";
import { lightStudyEnabled } from "./enabled";
const service=createLightService(nodeDatabase,{now:()=>new Date(),newId:randomUUID,enabled:lightStudyEnabled,
  allowMock:process.env.NODE_ENV==="test"||process.env.ROASTDUCK_E2E==="1"});
export const {getLightView,lightOverview,createLightSession,applyLightEvent}=service;
