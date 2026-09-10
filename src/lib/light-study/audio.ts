import { MIMO_TTS_VERSION, resolveSpeechStyle, type MimoVoice, type SpeechAccent, type SpeechStyle, type VoicePresetId } from "@/lib/speech/contracts";
import {getSpeechPreferences,resolveSpeechSelection,subscribeSpeechPreferences} from '@/lib/speech/preferences';
import type { TTSProvider } from "@/lib/tts";
/** Omitted mode preserves the old extension playback contract. */
export type PlaybackMode = "natural" | "quick";
export interface LightAudioInput { text:string; voiceId:VoicePresetId;voice?:MimoVoice;accent?:SpeechAccent;rate?:number;synthesisRate?:number;retryUnknown?:boolean;style?:SpeechStyle;playbackMode?:PlaybackMode }
export interface LightAudioState { phase:"idle"|"loading"|"playing"|"blocked"|"error"; provider:"mimo"|"browser"|"device"|null; message:string;errorCode?:string;voice?:string }
export const speechFailureMessage=(code:string)=>({missing_key:'未配置 MiMo Key',authentication_failed:'MiMo 鉴权失败',rate_limited:'MiMo 请求较多',timeout:'MiMo 响应超时',network_error:'MiMo 连接暂不可用',invalid_audio:'示范音频校验失败',result_unknown:'上次合成结果尚未确认',invalid_configuration:'MiMo 配置需要检查',preparing:'MiMo 仍在准备'})[code]??'MiMo 暂不可用';
interface Resource {url:string;voice?:string;release?:()=>void}
const normalized=(input:LightAudioInput):LightAudioInput=>({...input,...resolveSpeechSelection(input)});
// Playback speed changes the media element, not the synthesis identity or API request.
const keyOf=(input:LightAudioInput)=>JSON.stringify([MIMO_TTS_VERSION,input.text,input.voice,input.accent,input.synthesisRate??1,resolveSpeechStyle(input)]);
const MAX_AUDIO_BYTES=20*1024*1024;

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
  private playingKey:string|null=null;
  private next:LightAudioInput|null=null;
  private disposed=false;
  private failures=new Map<string,string>();
  private playbackRate=getSpeechPreferences().playbackRate as number;
  private unsubscribePreferences:()=>void;
  constructor(private fallback:TTSProvider,private update:(state:LightAudioState)=>void,
    private fetcher:typeof fetch=(...args)=>globalThis.fetch(...args),private audioFactory:(url:string)=>HTMLAudioElement=url=>new Audio(url),
    private nativeLoader?: (input:LightAudioInput)=>Promise<Resource|null>) {
      this.unsubscribePreferences=subscribeSpeechPreferences(preferences=>{
        this.playbackRate=preferences.playbackRate;
        if(this.audio)this.applyPlaybackRate(this.audio);
      });
    }
  private applyPlaybackRate(audio:HTMLAudioElement){audio.playbackRate=this.playbackRate;audio.preservesPitch=true;}
  prime(current:LightAudioInput|null,next:LightAudioInput|null,warm=true) {
    if(this.disposed)return;
    current=current?normalized(current):null;next=next?normalized(next):null;
    this.next=next;
    this.desired=new Set([current,next].filter((v):v is LightAudioInput=>Boolean(v)).map(keyOf));
    for(const [key,requests] of this.requests)if(!this.desired.has(key))for(const request of requests)request.abort();
    this.pruneResources();
    if(warm){if(current)void this.prepare(current,1);if(next)void this.prepare(next,0);}
  }
  private releaseResource(key:string){const resource=this.cache.get(key);this.cache.delete(key);resource?.release?.();}
  private clearAudio(){
    const audio=this.audio;this.audio=null;
    if(!audio)return;
    audio.onended=null;audio.onerror=null;audio.pause();
    audio.removeAttribute?.('src');audio.load?.();
  }
  private pruneResources(){
    // At most current, next, and the still-playing item retain audio bytes.
    for(const key of this.cache.keys())if(!this.desired.has(key)&&key!==this.playingKey)this.releaseResource(key);
    for(const key of this.failures.keys())if(!this.desired.has(key)&&key!==this.playingKey)this.failures.delete(key);
  }
  private prepare(input:LightAudioInput,priority=1):Promise<Resource|null> {
    const key=keyOf(input);
    if(input.retryUnknown)this.releaseResource(key);
    if(this.cache.has(key))return Promise.resolve(this.cache.get(key)!);
    if(this.pending.has(key)&&[...this.requests.get(key)??[]].some(request=>!request.signal.aborted))return this.pending.get(key)!;
    this.priorities.set(key,priority);
    const controller=new AbortController();if(!this.requests.has(key))this.requests.set(key,new Set());this.requests.get(key)!.add(controller);
    const wanted=()=>!this.disposed&&!controller.signal.aborted&&this.desired.has(key);
    const work=Promise.resolve().then(async()=>{
      if(!wanted())return null;
      try {
        if(this.nativeLoader){const resource=await this.nativeLoader(input);if(!wanted()){resource?.release?.();return null;}if(resource)this.cache.set(key,resource);return resource;}
        const signal=AbortSignal.any([this.controller.signal,controller.signal,AbortSignal.timeout(65000)]);
        const response=await this.fetcher("/api/speech/synthesis",{method:"POST",headers:{"content-type":"application/json"},
          signal,
          body:JSON.stringify({text:input.text,purpose:"example",voice:input.voice,accent:input.accent,rate:input.synthesisRate??1,style:resolveSpeechStyle(input),priority,retryUnknown:input.retryUnknown??false})});
        const body=await response.json();
        if(!wanted())return null;
        if(!response.ok||typeof body.audio?.audioUrl!=="string"||!body.audio.audioUrl.startsWith("/api/speech/assets/")){this.failures.set(key,typeof body.code==='string'?body.code:'upstream_unavailable');return null;}
        // A promoted request may share the same server result with its original prefetch.
        if(this.cache.has(key))return this.cache.get(key)!;
        if(body.audio.voice!==input.voice||(body.audio.accent&&body.audio.accent!==input.accent)){this.failures.set(key,'invalid_audio');return null;}
        const asset=await this.fetcher(body.audio.audioUrl,{signal});
        if(!wanted())return null;
        if(!asset.ok||Number(asset.headers.get('content-length'))>MAX_AUDIO_BYTES){this.failures.set(key,'invalid_audio');return null;}
        const blob=await asset.blob();
        if(!wanted())return null;
        const header=new Uint8Array(await blob.slice(0,12).arrayBuffer());
        if(!wanted())return null;
        if(blob.size<44||blob.size>MAX_AUDIO_BYTES||String.fromCharCode(...header.slice(0,4))!=='RIFF'||String.fromCharCode(...header.slice(8,12))!=='WAVE'){this.failures.set(key,'invalid_audio');return null;}
        this.failures.delete(key);
        if(this.cache.has(key))return this.cache.get(key)!;
        const url=URL.createObjectURL(blob),resource={url,voice:body.audio.voice as string,release:()=>URL.revokeObjectURL(url)};
        this.cache.set(key,resource);return resource;
      } catch(error) {if(!controller.signal.aborted&&!this.controller.signal.aborted)this.failures.set(key,error instanceof Error&&error.name==='TimeoutError'?'timeout':'network_error');return null;}
    });
    this.pending.set(key,work);
    void work.then(()=>{if(this.pending.get(key)===work)this.pending.delete(key);const requests=this.requests.get(key);requests?.delete(controller);if(!requests?.size){this.requests.delete(key);this.priorities.delete(key);}});
    return work;
  }
  private haltPlayback() {
    const owned=LightAudioPlayer.active===this;
    if(owned)LightAudioPlayer.active=null;
    this.generation++;
    this.clearAudio();
    this.playingKey=null;
    if(owned)this.fallback.stop();
    if(!this.disposed)this.update({phase:"idle",provider:null,message:""});
  }
  // Stopping playback keeps useful current/next prefetch alive (including before reveal).
  // prime() cancels obsolete work, and dispose() cancels all work on leaving the page.
  stop(){this.haltPlayback();this.pruneResources();}
  async play(input:LightAudioInput) {
    if(this.disposed)return;
    input=normalized(input);
    this.playbackRate=input.rate??getSpeechPreferences().playbackRate;
    if(LightAudioPlayer.active&&LightAudioPlayer.active!==this)LightAudioPlayer.active.stop();
    this.haltPlayback();const token=this.generation;
    LightAudioPlayer.active=this;
    this.playingKey=keyOf(input);
    this.desired=new Set([input,this.next].filter((v):v is LightAudioInput=>Boolean(v)).map(keyOf));
    for(const [key,requests] of this.requests)if(!this.desired.has(key))for(const request of requests)request.abort();
    this.pruneResources();
    const alive=()=>!this.disposed&&token===this.generation;
    const naturalFailure=(code:string)=>{
      if(!alive())return;
      this.clearAudio();
      this.update({phase:"error",provider:null,errorCode:code,message:`${speechFailureMessage(code)}，可以先听快捷声音`});
    };
    const fallback=()=>{
      if(!alive())return;
      this.clearAudio();
      const source=this.fallback.name==="android_tts"?"device" as const:"browser" as const;
      const quick=input.playbackMode==='quick';
      const code=quick?undefined:this.failures.get(keyOf(input))??'preparing',label=source==='device'?'设备快捷声音':quick?'本机快捷声音':'系统备用声音';
      let actual:Pick<LightAudioState,'voice'|'message'>={message:code?`${label} · ${speechFailureMessage(code)}`:label};
      this.update({phase:"playing",provider:source,errorCode:code,...actual});
      this.fallback.speak(input.text,{voiceId:input.voiceId,voice:input.voice,lang:input.accent,rate:this.playbackRate,localOnly:quick,
        onState:state=>{if(alive()){actual={voice:state.voice,message:state.message};this.update({...state,provider:source});}},
        onEnd:()=>{if(alive()){this.playingKey=null;this.pruneResources();this.update({phase:"idle",provider:source,errorCode:code,...actual});}},
        onError:error=>{if(alive()){const unavailable=error instanceof Error&&error.message==='local_voice_unavailable';this.update({phase:"error",provider:source,errorCode:unavailable?'local_voice_unavailable':undefined,message:unavailable?'设备没有可用的本机英语声音，可以准备 MiMo 自然声音':'声音暂不可用，仍可继续学习'});}}});
    };
    // Quick speech has no network dependency: use prepared bytes or call local speech
    // in the same interaction. Natural playback never changes voice without consent.
    if(input.retryUnknown)this.releaseResource(keyOf(input));
    let resource=this.cache.get(keyOf(input))??null;
    if(!resource&&input.playbackMode==='quick'){fallback();return;}
    if(!resource){
      this.update({phase:"loading",provider:null,message:input.playbackMode==='natural'?"自然声音准备中，可以继续学习或先听快捷声音":"声音准备中，可以继续学习"});
      if(input.playbackMode==='natural')resource=await this.prepare(input);
      else {
        let timer:ReturnType<typeof setTimeout>|undefined;
        resource=await Promise.race([this.prepare(input),new Promise<null>(resolve=>{timer=setTimeout(()=>resolve(null),3500);})]);clearTimeout(timer);
      }
    }
    if(!alive())return;
    const unavailable=()=>input.playbackMode==='natural'?naturalFailure(this.failures.get(keyOf(input))??'upstream_unavailable'):fallback();
    if(!resource){unavailable();return;}
    const audio=this.audioFactory(resource.url);audio.preload="auto";this.audio=audio;this.applyPlaybackRate(audio);
    const voice=resource.voice??input.voice;
    audio.onended=()=>{if(alive()&&this.audio===audio){this.clearAudio();this.playingKey=null;this.pruneResources();this.update({phase:"idle",provider:"mimo",voice,message:`MiMo · ${voice}`});}};
    audio.onerror=()=>{if(alive()&&this.audio===audio){this.failures.set(keyOf(input),'invalid_audio');unavailable();this.releaseResource(keyOf(input));}};
    try{await audio.play();if(alive()&&this.audio===audio)this.update({phase:"playing",provider:"mimo",voice,message:`MiMo · ${voice}`});}
    catch(error){
      if(!alive()||this.audio!==audio)return;
      if(error instanceof Error&&error.name==="NotAllowedError")this.update({phase:"blocked",provider:"mimo",message:"浏览器暂停了自动播放，请点击播放"});
      else {this.failures.set(keyOf(input),'invalid_audio');this.releaseResource(keyOf(input));unavailable();}
    }
  }
  dispose(){this.stop();this.disposed=true;this.desired.clear();this.controller.abort();this.pruneResources();this.unsubscribePreferences();}
}
