import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import type {DatabasePort} from '@/lib/platform/database';
import {query as sql} from '@/lib/platform/sql';
import {buildMimoBody} from './wire';
import {MIMO_TTS_MODEL,SpeechProviderError,type SpeechSynthesisInput,type SpeechSynthesisResult,type SpeechErrorCode} from './contracts';
export const WEB_AUDIO_VERSION='mimo-web-cache-v2';
type Input=SpeechSynthesisInput&{voice:NonNullable<SpeechSynthesisInput['voice']>};
type Row={id:string;status:string;error_code:string|null;owner_boot_id:string;asset_id:string|null;updated_at:string};
type Options={priority?:number;retryUnknown?:boolean;signal?:AbortSignal};
type Platform={database:DatabasePort;root:string;now:()=>Date;newId:()=>string;bootId:string;configurationId?:()=>string;generate:(input:Input)=>Promise<{bytes:Buffer;responseId:string|null}>};
const digest=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
export const webAudioKey=(input:Input)=>digest(JSON.stringify([WEB_AUDIO_VERSION,buildMimoBody(input,input.voice)]));
const validWave=(bytes:Buffer)=>bytes.length>=44&&bytes.length<=20*1024*1024&&bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WAVE';

/** A single synthesis lane; queued work can be reprioritized/cancelled without cancelling paid in-flight work. */
export function createSpeechRequests(platform:Platform){
  const {database}=platform;
  type Slot={priority:number;signals:Set<AbortSignal|undefined>;promise:Promise<SpeechSynthesisResult>};
  const inFlight=new Map<string,Slot>(),queue:Array<{slot:Slot;run:()=>Promise<void>}>=[],received=new Map<string,Buffer>();let pumping=false;
  let circuit:{code:SpeechErrorCode;configuration:string;until:number}|null=null;
  function checkCircuit(options:Options){if(circuit&&circuit.configuration===(platform.configurationId?.()??'')&&circuit.until>platform.now().getTime()&&!options.retryUnknown)throw new SpeechProviderError('MiMo暂不可用，短时间内不反复请求；先使用备用声音',circuit.code,false,503);}
  const timestamp=()=>platform.now().toISOString();
  async function acquireLane(slot:Slot,owner:string){
    const started=Date.now();
    for(;;){
      if([...slot.signals].every(signal=>signal?.aborted))throw new SpeechProviderError('已取消排队声音','cancelled',false,409);
      const claimed=await database.write(async tx=>{
        const result=await tx.run(sql`INSERT INTO speech_lane(singleton,owner,expires_at) VALUES(1,${owner},${new Date(Date.now()+120000).toISOString()}) ON CONFLICT(singleton) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE speech_lane.expires_at<=${new Date().toISOString()}`);
        return result.changes>0;
      });
      if(claimed)return;
      if(Date.now()-started>65000)throw new SpeechProviderError('其他声音仍在合成，请稍后再试','timeout',false,503);
      await new Promise(resolve=>setTimeout(resolve,100));
    }
  }
  async function atomic(file:string,bytes:Buffer){const temp=file+'.'+platform.newId()+'.tmp';try{const handle=await fs.open(temp,'wx',0o600);try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}await fs.rename(temp,file);}finally{await fs.unlink(temp).catch(error=>{if(error.code!=='ENOENT')throw error;});}}
  async function cached(key:string){
    const file=path.join(platform.root,key+'.wav'),metaFile=file+'.json';
    try{
      if((await fs.stat(metaFile)).size>4096)return null;
      const meta=JSON.parse(await fs.readFile(metaFile,'utf8')) as {hash:string;bytes:number;key:string};
      const stat=await fs.stat(file);if(stat.size>20*1024*1024||stat.size!==meta.bytes||meta.key!==key)return null;
      const bytes=await fs.readFile(file);return validWave(bytes)&&digest(bytes)===meta.hash?file:null;
    }catch{return null;}
  }
  const response=(input:Input,key:string,cache:boolean):SpeechSynthesisResult=>({assetId:`audio_${key.slice(0,32)}`,audioUrl:`/api/speech/assets/audio_${key.slice(0,32)}`,provider:'mimo',model:MIMO_TTS_MODEL,voice:input.voice,accent:input.accent,format:'wav',cached:cache});
  async function publish(input:Input,key:string,requestId:string|null,bytes?:Buffer){
    const result=response(input,key,!bytes);
    if(bytes){
      if(!validWave(bytes))throw new SpeechProviderError('音频格式无效','invalid_audio',false);
      await fs.mkdir(platform.root,{recursive:true});
      await atomic(path.join(platform.root,key+'.wav'),bytes);
      await atomic(path.join(platform.root,key+'.wav.json'),Buffer.from(JSON.stringify({key,hash:digest(bytes),bytes:bytes.length})));
    }
    await database.write(async tx=>{
      await tx.run(sql`INSERT INTO audio_assets(id,content_hash,purpose,provider,model,voice,accent,speed,format,relative_path,status,version) VALUES(${result.assetId},${key},${input.purpose},'mimo',${MIMO_TTS_MODEL},${input.voice},${input.accent},${input.rate},'wav',${`data/audio/cache/${key}.wav`},'ready',${WEB_AUDIO_VERSION}) ON CONFLICT(id) DO UPDATE SET status='ready'`);
      if(requestId)await tx.run(sql`UPDATE speech_requests SET status='completed',asset_id=${result.assetId},error_code=NULL,updated_at=${timestamp()} WHERE id=${requestId}`);
    });if(requestId)received.delete(requestId);return result;
  }
  async function pump(){if(pumping)return;pumping=true;try{while(queue.length){queue.sort((a,b)=>b.slot.priority-a.slot.priority);await queue.shift()!.run();}}finally{pumping=false;}}
  async function execute(input:Input,key:string,slot:Slot,options:Options){
    const last=(await database.read(tx=>tx.all<Row>(sql`SELECT * FROM speech_requests WHERE cache_key=${key} ORDER BY created_at DESC,id DESC LIMIT 1`)))[0];
    if(await cached(key))return publish(input,key,last?.id??null);
    if(last&&received.has(last.id))return publish(input,key,last.id,received.get(last.id));
    if(last&&(last.status==='unknown'||last.error_code==='result_unknown')&&!options.retryUnknown)throw new SpeechProviderError('上次声音合成结果尚未确认，先使用备用声音','result_unknown',false,409);
    if(last?.status==='completed'&&!options.retryUnknown)throw new SpeechProviderError('缓存声音需要恢复，可在设置中明确重试','invalid_audio',false,409);
    if(last?.status==='failed'&&last.error_code==='invalid_audio'&&!options.retryUnknown)throw new SpeechProviderError('上次音频无效，需要明确重新生成','invalid_audio',false,409);
    checkCircuit(options);
    const id='speech_'+platform.newId(),now=timestamp();
    await database.write(tx=>tx.run(sql`INSERT INTO speech_requests(id,cache_key,descriptor_json,status,priority,owner_boot_id,created_at,updated_at) VALUES(${id},${key},${JSON.stringify(input)},'queued',${slot.priority},${platform.bootId},${now},${now}) ON CONFLICT(id) DO UPDATE SET owner_boot_id=excluded.owner_boot_id,priority=excluded.priority`));
    return new Promise<SpeechSynthesisResult>((resolve,reject)=>{
      queue.push({slot,run:async()=>{
        let dispatched=false,claimed=false;let heartbeat:ReturnType<typeof setInterval>|undefined;
        const owner=`${platform.bootId}:${id}`;
        try{
          if([...slot.signals].every(signal=>signal?.aborted)){await database.write(tx=>tx.run(sql`UPDATE speech_requests SET status='cancelled',updated_at=${timestamp()} WHERE id=${id}`));throw new SpeechProviderError('已取消过时的声音预取','cancelled',false,409);}
          await acquireLane(slot,owner);claimed=true;
          heartbeat=setInterval(()=>{void database.write(tx=>tx.run(sql`UPDATE speech_lane SET expires_at=${new Date(Date.now()+120000).toISOString()} WHERE singleton=1 AND owner=${owner}`)).catch(()=>undefined);},10000);
          // Another Web process may have completed (or lost) the paid request while we waited.
          if(await cached(key)){resolve(await publish(input,key,id));return;}
          const [previous]=await database.read(tx=>tx.all<Row>(sql`SELECT * FROM speech_requests WHERE cache_key=${key} AND id!=${id} AND status NOT IN ('queued','cancelled') ORDER BY updated_at DESC,id DESC LIMIT 1`));
          if(previous&&['processing','unknown','completed'].includes(previous.status)&&!options.retryUnknown)throw new SpeechProviderError('上次结果未确认，需要明确重新生成','result_unknown',false,409);
          checkCircuit(options);
          await database.write(tx=>tx.run(sql`UPDATE speech_requests SET status='processing',priority=${slot.priority},updated_at=${timestamp()} WHERE id=${id}`));dispatched=true;
          const output=await platform.generate(input);if(!validWave(output.bytes))throw new SpeechProviderError('返回音频无效','invalid_audio',false);received.set(id,output.bytes);circuit=null;
          resolve(await publish(input,key,id,output.bytes));
        }catch(error){
          const original=error instanceof SpeechProviderError?error.code:'storage_error';
          const unknown=dispatched&&['network_error','timeout','storage_error'].includes(original);
          const code:SpeechErrorCode=unknown?'result_unknown':original;
          if(dispatched&&['missing_key','authentication_failed','rate_limited','network_error','timeout'].includes(original))circuit={code:original,configuration:platform.configurationId?.()??'',until:platform.now().getTime()+30000};
          await database.write(tx=>tx.run(sql`UPDATE speech_requests SET status=${original==='cancelled'?'cancelled':unknown?'unknown':'failed'},error_code=${code},updated_at=${timestamp()} WHERE id=${id}`)).catch(()=>undefined);
          reject(error instanceof SpeechProviderError&&!unknown?error:new SpeechProviderError('声音结果未确认，已保留状态，不会自动重复请求',code,false,503));
        }finally{
          clearInterval(heartbeat);
          if(claimed)await database.write(tx=>tx.run(sql`DELETE FROM speech_lane WHERE singleton=1 AND owner=${owner}`)).catch(()=>undefined);
        }
      }});void pump();
    });
  }
  function synthesize(input:Input,options:Options={}){
    const key=webAudioKey(input),old=inFlight.get(key);
    if(old){old.priority=Math.max(old.priority,options.priority??1);old.signals.add(options.signal);return old.promise;}
    const slot:Slot={priority:options.priority??1,signals:new Set([options.signal]),promise:Promise.resolve(null as unknown as SpeechSynthesisResult)};
    slot.promise=execute(input,key,slot,options);inFlight.set(key,slot);void slot.promise.finally(()=>{if(inFlight.get(key)===slot)inFlight.delete(key);}).catch(()=>undefined);return slot.promise;
  }
  return {synthesize,cached};
}
