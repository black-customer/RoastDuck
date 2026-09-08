import {Capacitor,registerPlugin,type PluginListenerHandle} from "@capacitor/core";
import {z} from "zod";
import type {DatabasePort} from "../database";
import {query as sql} from "../sql";
import {audioDescriptor,buildMimoBody,speechContentHash} from "@/lib/speech/wire";
import {MIMO_TTS_MODEL,MIMO_TTS_VERSION,speechSynthesisInputSchema,VOICE_PRESETS,type SpeechSynthesisInput,type VoicePresetId} from "@/lib/speech/contracts";
import type {SpeechPort} from "@/lib/speech/ports";
import type {SpeakOptions,TTSProvider} from "@/lib/tts";
const resultSchema=z.object({available:z.boolean(),cached:z.boolean().optional(),asset:z.object({contentHash:z.string(),fileHash:z.string().regex(/^[a-f0-9]{64}$/),uri:z.string(),bytes:z.number().int().min(44)}).optional()});
interface AudioBridge {lookup(input:{contentHash:string}):Promise<unknown>;synthesize(input:{contentHash:string;descriptor:string;body:string;retry:boolean}):Promise<unknown>}
const audio=registerPlugin<AudioBridge>("RoastDuckSpeech");
export function createAndroidSpeech(database:DatabasePort,bridge:AudioBridge=audio):SpeechPort {
  const waiting=new Map<string,Promise<Awaited<ReturnType<SpeechPort["prepare"]>>>>();
  async function prepare(input:SpeechSynthesisInput,options:{regenerateMissing?:boolean}={}){
    const value=speechSynthesisInputSchema.parse(input),voice=value.voice??"Chloe",key=speechContentHash(value,voice),assetId=`audio_${key.slice(0,32)}`;
    let result:z.infer<typeof resultSchema>;
    try{result=resultSchema.parse(await bridge.lookup({contentHash:key}));}catch(error){if(!options.regenerateMissing)throw error;result={available:false};}
    if(!result.available){
      const existing=await database.read(tx=>tx.all(sql`SELECT id FROM audio_assets WHERE content_hash=${key} AND status='ready'`));
      if(existing.length&&!options.regenerateMissing)throw new Error("这段缓存声音尚未同步到本机，可先用设备声音");
      result=resultSchema.parse(await bridge.synthesize({contentHash:key,descriptor:JSON.stringify(audioDescriptor(value,voice)),body:JSON.stringify(buildMimoBody(value,voice)),retry:!!options.regenerateMissing}));
    }
    const asset=result.asset;
    if(!result.available||!asset||asset.contentHash!==key||!asset.uri.startsWith("file:")||!new URL(asset.uri).pathname.endsWith(`/audio-media/${asset.fileHash}.wav`))throw new Error("声音缓存校验失败");
    await database.write(tx=>tx.run(sql`INSERT INTO audio_assets(id,content_hash,purpose,provider,model,voice,accent,speed,format,relative_path,status,version)
      VALUES(${assetId},${key},${value.purpose},'mimo',${MIMO_TTS_MODEL},${voice},${value.accent},${value.rate},'wav',${`data/audio/cache/${key}.wav`},'ready',${MIMO_TTS_VERSION})
      ON CONFLICT(content_hash,provider,model,voice,speed,version) DO UPDATE SET status='ready',relative_path=excluded.relative_path`));
    return {assetId,url:Capacitor.convertFileSrc(asset.uri),provider:"mimo" as const,cached:!!result.cached};
  }
  return {prepare(input,options){const key=JSON.stringify([input,options?.regenerateMissing??false]);const old=waiting.get(key);if(old)return old;const task=prepare(input,options);waiting.set(key,task);void task.finally(()=>waiting.delete(key)).catch(()=>undefined);return task;}};
}

const device=registerPlugin<{speak(input:{id:string;text:string;locale:string}):Promise<void>;stop(input:{id:string}):Promise<void>;addListener(name:"finished",listener:(event:{id:string;success:boolean})=>void):Promise<PluginListenerHandle>}>("RoastDuckDeviceSpeech");
export function createDeviceSpeech():TTSProvider{
  let voice:VoicePresetId="us-female",current:{id:string;options?:SpeakOptions;listening?:Promise<PluginListenerHandle>}|null=null;
  const stop=()=>{const old=current;current=null;if(old){void old.listening?.then(handle=>handle.remove()).catch(()=>undefined);void device.stop({id:old.id}).catch(()=>undefined);}};
  return {name:"android_tts",getVoice:()=>voice,setVoice:id=>{voice=id;},
    speak(text,options){
      stop();const id=crypto.randomUUID();current={id,options};
      const listening=device.addListener("finished",event=>{if(event.id!==id)return;void listening.then(handle=>handle.remove());if(current?.id===id){current=null;if(event.success)options?.onEnd?.();else options?.onError?.(new Error("设备声音不可用"));}});
      current.listening=listening;
      void listening.then(async()=>{if(current?.id!==id){(await listening).remove();return;}const preset=VOICE_PRESETS.find(p=>p.id===(options?.voiceId??voice))!;await device.speak({id,text,locale:options?.lang??preset.accent});}).catch(error=>{if(current?.id===id){current=null;options?.onError?.(error);}void listening.then(handle=>handle.remove()).catch(()=>undefined);});
    },
    stop,
  };
}
