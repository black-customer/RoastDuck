import { createHash,randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { and, eq,inArray } from "drizzle-orm";
import { getDbReady } from "@db/client";
import { audioAssets } from "@db/schema";
import { readSpeechEnvironment } from "./config";
import { MIMO_TTS_VERSION, SpeechProviderError, type SpeechSynthesisInput, type SpeechSynthesisResult } from "./contracts";
import { MimoTtsProvider } from "./mimo-provider";
import {createSpeechRequests,WEB_AUDIO_VERSION} from './request-service';
import {nodeDatabase} from '@/lib/platform/node/database';
import {buildMimoBody} from './wire';

function contentHash(input: SpeechSynthesisInput, model: string, voice: string): string {
  return createHash("sha256").update(JSON.stringify({
    text: input.text,
    purpose: input.purpose,
    accent: input.accent,
    rate: input.rate,
    model,
    voice,
    version: MIMO_TTS_VERSION,
  })).digest("hex");
}

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
  // Reuse compatible pre-v2 cache entries; changed cache-key rules alone must not cost another synthesis.
  const purposes:SpeechSynthesisInput["purpose"][]=["example","chunk","question","teacher_message","learning_context"];
  const rates=[...new Set([input.rate,.95,1])].filter(rate=>JSON.stringify(buildMimoBody({...input,rate},voice))===JSON.stringify(buildMimoBody(input,voice)));
  const keys=purposes.flatMap(purpose=>rates.map(rate=>contentHash({...input,purpose,rate},config.model,voice)));
  const db=await getDbReady();
  const legacy=await db.select().from(audioAssets).where(and(inArray(audioAssets.contentHash,keys),eq(audioAssets.status,"ready"),eq(audioAssets.version,MIMO_TTS_VERSION)));
  for(const asset of legacy){try{const file=safeAssetPath(asset.relativePath),stat=await fs.stat(file);if(stat.size<44||stat.size>20*1024*1024)continue;const bytes=await fs.readFile(file);if(bytes.subarray(0,4).toString()!=="RIFF"||bytes.subarray(8,12).toString()!=="WAVE")continue;return {assetId:asset.id,audioUrl:`/api/speech/assets/${asset.id}`,provider:"mimo",model:config.model,voice,accent:input.accent,format:"wav",cached:true};}catch{/* Keep unavailable legacy files intact. */}}
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
