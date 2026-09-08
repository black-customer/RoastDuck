import { VOICE_PRESETS, type VoicePresetId } from "@/lib/speech/contracts";
import type { TTSProvider } from "@/lib/tts";
export interface LightAudioInput { text:string; voiceId:VoicePresetId;rate?:number;retryUnknown?:boolean }
export interface LightAudioState { phase:"idle"|"loading"|"playing"|"blocked"|"error"; provider:"mimo"|"browser"|"device"|null; message:string;errorCode?:string;voice?:string }
export const speechFailureMessage=(code:string)=>({missing_key:'未配置 MiMo Key',authentication_failed:'MiMo 鉴权失败',rate_limited:'MiMo 请求较多',timeout:'MiMo 响应超时',network_error:'MiMo 连接暂不可用',invalid_audio:'示范音频校验失败',result_unknown:'上次合成结果尚未确认',invalid_configuration:'MiMo 配置需要检查',preparing:'MiMo 仍在准备'})[code]??'MiMo 暂不可用';
interface Resource {url:string}
const keyOf=(input:LightAudioInput)=>JSON.stringify([input.text,input.voiceId,input.rate??.95]);

/** 客户端只预取当前/下一项；过期排队任务不发送，迟到结果只缓存不出声。 */
export class LightAudioPlayer {
  private static active:LightAudioPlayer|null=null;
  private desired=new Set<string>();
  private cache=new Map<string,Resource>();
  private pending=new Map<string,Promise<Resource|null>>();
  private priorities=new Map<string,number>();
  private requests=new Map<string,Set<AbortController>>();
  private controller=new AbortController();
  private generation=0;
  private audio:HTMLAudioElement|null=null;
  private next:LightAudioInput|null=null;
  private disposed=false;
  private failures=new Map<string,string>();
  constructor(private fallback:TTSProvider,private update:(state:LightAudioState)=>void,
    private fetcher:typeof fetch=fetch,private audioFactory:(url:string)=>HTMLAudioElement=url=>new Audio(url),
    private nativeLoader?: (input:LightAudioInput)=>Promise<Resource|null>) {}
  prime(current:LightAudioInput|null,next:LightAudioInput|null,warm=true) {
    this.next=next;
    this.desired=new Set([current,next].filter((v):v is LightAudioInput=>Boolean(v)).map(keyOf));
    for(const [key,requests] of this.requests)if(!this.desired.has(key))for(const request of requests)request.abort();
    if(warm){if(current)void this.prepare(current,1);if(next)void this.prepare(next,0);}
  }
  private prepare(input:LightAudioInput,priority=1):Promise<Resource|null> {
    const key=keyOf(input);
    if(input.retryUnknown)this.cache.delete(key);
    if(this.cache.has(key))return Promise.resolve(this.cache.get(key)!);
    if(this.pending.has(key)&&[...this.requests.get(key)??[]].some(request=>!request.signal.aborted)&&(this.priorities.get(key)??0)>=priority)return this.pending.get(key)!;
    this.priorities.set(key,priority);
    const controller=new AbortController();if(!this.requests.has(key))this.requests.set(key,new Set());this.requests.get(key)!.add(controller);
    const work=Promise.resolve().then(async()=>{
      if(this.disposed||!this.desired.has(key))return null;
      const preset=VOICE_PRESETS.find(p=>p.id===input.voiceId)!;
      try {
        if(this.nativeLoader){const resource=await this.nativeLoader(input);if(resource)this.cache.set(key,resource);return resource;}
        const response=await this.fetcher("/api/speech/synthesis",{method:"POST",headers:{"content-type":"application/json"},
          signal:AbortSignal.any([this.controller.signal,controller.signal,AbortSignal.timeout(65000)]),
          body:JSON.stringify({text:input.text,purpose:"example",voice:preset.mimoVoice,accent:preset.accent,rate:input.rate??.95,priority,retryUnknown:input.retryUnknown??false})});
        const body=await response.json();
        if(!response.ok||typeof body.audio?.audioUrl!=="string"||!body.audio.audioUrl.startsWith("/api/speech/assets/")){this.failures.set(key,typeof body.code==='string'?body.code:'upstream_unavailable');return null;}
        this.failures.delete(key);
        const resource={url:body.audio.audioUrl};this.cache.set(key,resource);return resource;
      } catch(error) {if(!controller.signal.aborted&&!this.controller.signal.aborted)this.failures.set(key,error instanceof Error&&error.name==='TimeoutError'?'timeout':'network_error');return null;}
    });
    this.pending.set(key,work);
    void work.then(()=>{if(this.pending.get(key)===work)this.pending.delete(key);const requests=this.requests.get(key);requests?.delete(controller);if(!requests?.size){this.requests.delete(key);this.priorities.delete(key);}});
    return work;
  }
  stop() {
    if(LightAudioPlayer.active===this)LightAudioPlayer.active=null;
    this.generation++;
    if(this.audio){this.audio.pause();this.audio=null;}
    this.fallback.stop();
    if(!this.disposed)this.update({phase:"idle",provider:null,message:""});
  }
  async play(input:LightAudioInput) {
    if(this.disposed)return;
    if(LightAudioPlayer.active&&LightAudioPlayer.active!==this)LightAudioPlayer.active.stop();
    this.stop();const token=this.generation;
    LightAudioPlayer.active=this;
    this.desired=new Set([input,this.next].filter((v):v is LightAudioInput=>Boolean(v)).map(keyOf));
    for(const [key,requests] of this.requests)if(!this.desired.has(key))for(const request of requests)request.abort();
    this.update({phase:"loading",provider:null,message:"声音准备中，可以继续学习"});
    let timer:ReturnType<typeof setTimeout>|undefined;
    const resource=await Promise.race([this.prepare(input),new Promise<null>(resolve=>{timer=setTimeout(()=>resolve(null),3500);})]);clearTimeout(timer);
    if(this.disposed||token!==this.generation)return;
    const alive=()=>!this.disposed&&token===this.generation;
    const fallback=()=>{
      if(!alive())return;
      this.audio?.pause();this.audio=null;
      const preset=VOICE_PRESETS.find(p=>p.id===input.voiceId)!;
      const source=this.fallback.name==="android_tts"?"device" as const:"browser" as const;
      const code=this.failures.get(keyOf(input))??'preparing',label=source==='device'?'设备备用声音':'系统备用声音';
      this.update({phase:"playing",provider:source,errorCode:code,voice:preset.mimoVoice,message:`${label} · ${speechFailureMessage(code)}`});
      this.fallback.speak(input.text,{voiceId:input.voiceId,lang:preset.accent,rate:input.rate,
        onEnd:()=>{if(alive())this.update({phase:"idle",provider:source,errorCode:code,message:`${label} · ${speechFailureMessage(code)}`});},
        onError:()=>{if(alive())this.update({phase:"error",provider:source,message:"声音暂不可用，仍可继续学习"});}});
    };
    if(!resource){fallback();return;}
    const audio=this.audioFactory(resource.url);this.audio=audio;
    const voice=VOICE_PRESETS.find(p=>p.id===input.voiceId)!.mimoVoice;
    audio.onended=()=>{if(alive()&&this.audio===audio){this.audio=null;this.update({phase:"idle",provider:"mimo",voice,message:`MiMo · ${voice}`});}};
    audio.onerror=()=>{if(alive()&&this.audio===audio){this.cache.delete(keyOf(input));this.failures.set(keyOf(input),'invalid_audio');fallback();}};
    try{await audio.play();if(alive())this.update({phase:"playing",provider:"mimo",voice,message:`MiMo · ${voice}`});}
    catch(error){
      if(!alive())return;
      if(error instanceof Error&&error.name==="NotAllowedError")this.update({phase:"blocked",provider:"mimo",message:"浏览器暂停了自动播放，请点击播放"});
      else fallback();
    }
  }
  dispose(){this.stop();this.disposed=true;this.desired.clear();this.controller.abort();}
}
