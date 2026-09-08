import { createHash,randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { getDbReady } from "@db/client";
import { audioAssets } from "@db/schema";
import { readSpeechEnvironment } from "./config";
import { SpeechProviderError, type SpeechSynthesisInput, type SpeechSynthesisResult } from "./contracts";
import { MimoTtsProvider } from "./mimo-provider";
import {createSpeechRequests,WEB_AUDIO_VERSION} from './request-service';
import {nodeDatabase} from '@/lib/platform/node/database';

function safeAssetPath(relativePath: string): string {
  const root = path.resolve("data/audio/cache");
  const target = path.resolve(relativePath);
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error("音频缓存路径越界");
  return target;
}

type SpeechOptions={priority?:number;retryUnknown?:boolean;signal?:AbortSignal};
type SpeechState={requests:ReturnType<typeof createSpeechRequests>};
const globalSpeech=globalThis as typeof globalThis&{roastduckWebSpeech?:SpeechState};
function requests(){
  if(!globalSpeech.roastduckWebSpeech)globalSpeech.roastduckWebSpeech={requests:createSpeechRequests({
    database:nodeDatabase,root:path.resolve("data/audio/cache"),now:()=>new Date(),newId:randomUUID,bootId:randomUUID(),
    configurationId:()=>createHash('sha256').update(readSpeechEnvironment().apiKey).digest('hex'),
    generate:async input=>{const config=readSpeechEnvironment();return new MimoTtsProvider({apiKey:config.apiKey,baseUrl:config.baseUrl}).synthesize(input);},
  })};
  return globalSpeech.roastduckWebSpeech.requests;
}
/** Test environments never open production caches or make real speech requests. */
export async function synthesizeSpeech(input:SpeechSynthesisInput,options:SpeechOptions={}):Promise<SpeechSynthesisResult>{
  if(process.env.ROASTDUCK_E2E==="1"||process.env.AI_PROVIDER==="mock"||process.env.NODE_ENV==="test"||process.env.VITEST)throw new SpeechProviderError("测试模式不调用真实语音服务","invalid_configuration",false,503);
  const config=readSpeechEnvironment(),voice=input.voice??config.voice;
  // The old teaching prompt is not equivalent to the approved conversational styles.
  // Old assets remain available by ID; new synthesis only reuses the exact request hash.
  return requests().synthesize({...input,voice},options);
}

export async function findAudioAsset(assetId: string): Promise<{ absolutePath: string; format: string } | null> {
  if (!/^audio_[a-f0-9]{32}$/.test(assetId)) return null;
  const db = await getDbReady();
  const [asset] = await db.select().from(audioAssets).where(and(eq(audioAssets.id, assetId), eq(audioAssets.status, "ready"))).limit(1);
  if (!asset) return null;
  const absolutePath = safeAssetPath(asset.relativePath);
  try {
    if(asset.version===WEB_AUDIO_VERSION&&!await requests().cached(asset.contentHash))return null;
    await fs.access(absolutePath);
    return { absolutePath, format: asset.format };
  } catch {
    return null;
  }
}
