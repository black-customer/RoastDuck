import { nodeDatabase } from "@/lib/platform/node/database";
import { createLightCatalogue } from "./core-catalogue";
import type { LightScope,LightCard } from "./contracts";
export {materialFingerprint,type ProgressRow} from "./core-catalogue";
const allowMock=()=>process.env.NODE_ENV==="test"||process.env.ROASTDUCK_E2E==="1";
export const readLightCatalogue=(scope:LightScope)=>nodeDatabase.read(db=>createLightCatalogue(db,allowMock()).readLightCatalogue(scope));
export const snapshotAvailability=(card:LightCard)=>nodeDatabase.read(db=>createLightCatalogue(db,allowMock()).snapshotAvailability(card));
