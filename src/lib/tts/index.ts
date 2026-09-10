import {
  type VoicePresetId,
  VOICE_PRESETS,
  DEFAULT_VOICE_PRESET,
  type SpeechStyle,
  type MimoVoice,
} from "@/lib/speech/contracts";
import {LightAudioPlayer,type LightAudioState,type PlaybackMode} from '@/lib/light-study/audio';
import {getSpeechPreferences,legacyPresetFor,resolveSpeechSelection,setSpeechPreferences,subscribeSpeechPreferences} from '@/lib/speech/preferences';

export interface SpeakOptions {
  rate?: number;
  lang?: string;
  voiceId?: VoicePresetId;
  voice?: MimoVoice;
  style?: SpeechStyle;
  onEnd?: () => void;
  onError?: (err: unknown) => void;
  onState?: (state:LightAudioState)=>void;
  retryUnknown?:boolean;
  ownerId?:string;
  playbackMode?:PlaybackMode;
  /** Internal fallback constraint: never send quick speech to a remote browser voice. */
  localOnly?:boolean;
}

/** 单次明确声线优先，其次来源口音；未指定时才使用用户的默认声线。 */
export function resolveVoicePreset(active: VoicePresetId, options?: SpeakOptions) {
  const selected = VOICE_PRESETS.find((p) => p.id === (options?.voiceId ?? active)) ?? VOICE_PRESETS.find(p => p.id === DEFAULT_VOICE_PRESET)!;
  const accent=options?.lang==='en-US'||options?.lang==='en-GB'?options.lang:undefined;
  const actual=resolveSpeechSelection({voiceId:selected.id,voice:options?.voice,accent});
  return {...selected,mimoVoice:actual.voice,accent:actual.accent,gender:actual.voice==='Milo'||actual.voice==='Dean'?'male' as const:'female' as const};
}

/** TTSProvider：服务端 MiMo 为主，浏览器 Web Speech 只作故障降级。 */
export interface TTSProvider {
  speak(text: string, opts?: SpeakOptions): void;
  stop(ownerId?:string,preserveAudio?:boolean): void;
  setVoice(voiceId: VoicePresetId): void;
  getVoice(): VoicePresetId;
  readonly name: string;
}

const VOICE_STORAGE_KEY = "roastduck_active_voice";
const VOICE_SOURCE_KEY = "roastduck_voice_preference_v2";
const isVoicePreset = (value: unknown): value is VoicePresetId => VOICE_PRESETS.some(preset => preset.id === value);

function recordVoicePreference(voiceId: VoicePresetId, source: "explicit" | "legacy-preserved" | "default") {
  window.localStorage.setItem(VOICE_SOURCE_KEY, JSON.stringify({ version: 2, voiceId, source, defaultVoice: DEFAULT_VOICE_PRESET, previousDefault: "us-female" }));
}

export function getStoredVoicePreference(): VoicePresetId {
  if (typeof window === "undefined") return DEFAULT_VOICE_PRESET;
  try {
    const saved = window.localStorage.getItem(VOICE_STORAGE_KEY);
    if (isVoicePreset(saved)) {
      // Historical entries have no provenance. Preserve them rather than guess that Chloe was automatic.
      try { if (!window.localStorage.getItem(VOICE_SOURCE_KEY)) recordVoicePreference(saved, "legacy-preserved"); } catch { /* Preference is still readable. */ }
    } else recordVoicePreference(DEFAULT_VOICE_PRESET, "default");
  } catch {
    // Ignore localStorage access errors
  }
  return legacyPresetFor(getSpeechPreferences());
}

export function setStoredVoicePreference(voiceId: VoicePresetId): void {
  if (typeof window === "undefined") return;
  const preset=VOICE_PRESETS.find(value=>value.id===voiceId);
  if(!preset)return;
  setSpeechPreferences({voice:preset.mimoVoice,accent:preset.accent});
  try {
    window.localStorage.setItem(VOICE_STORAGE_KEY, voiceId);
    recordVoicePreference(voiceId, "explicit");
  } catch {
    // Ignore localStorage write errors
  }
}

export function splitSentencesForTts(text: string): string[] {
  const clean = text.trim();
  if (!clean) return [];
  // Split on sentence boundaries (. ! ?) while keeping abbreviations relatively intact
  const matched = clean.match(/[^.!?]+(?:[.!?]+(?:["'”’])?|$)/g);
  if (!matched) return [clean];
  return matched.map((s) => s.trim()).filter(Boolean);
}

export function pickSpeechVoice(voices:SpeechSynthesisVoice[],presetId:VoicePresetId,localOnly=false):SpeechSynthesisVoice|null {
  const preset=VOICE_PRESETS.find(p=>p.id===presetId)??VOICE_PRESETS[0];
  const english=voices.filter(voice=>voice.lang.toLowerCase().startsWith('en')&&(!localOnly||voice.localService===true));
  const exact=english.filter(voice=>voice.lang.toLowerCase()===preset.accent.toLowerCase());
  const candidates=exact.length?exact:english;
  const gender=preset.gender==='female'?/female|woman|girl|samantha|victoria|zira|jenny|libby|sonia|hazel|serena|aria/i:/\bmale\b|\bman\b|boy|david|guy|mark|ryan|oliver|george|arthur/i;
  return candidates.find(voice=>gender.test(voice.name)&&/natural|online|premium|neural/i.test(voice.name))
    ??candidates.find(voice=>gender.test(voice.name))
    ??candidates.find(voice=>/natural|online|premium|neural/i.test(voice.name))
    ??candidates[0]??null;
}

class WebSpeechProvider implements TTSProvider {
  readonly name = "webspeech";
  private activeVoiceId: VoicePresetId = DEFAULT_VOICE_PRESET;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private isSpeaking = false;
  private playbackId = 0;
  private utterances:SpeechSynthesisUtterance[]=[];
  private unsubscribePreferences:(()=>void)|null=null;

  constructor() {
    if (typeof window !== "undefined") {
      this.activeVoiceId = getStoredVoicePreference();
    }
  }

  getVoice(): VoicePresetId {
    return this.activeVoiceId;
  }

  setVoice(voiceId: VoicePresetId): void {
    this.activeVoiceId = voiceId;
    setStoredVoicePreference(voiceId);
  }

  speak(text: string, opts?: SpeakOptions): void {
    if (typeof window === "undefined" || !window.speechSynthesis) { opts?.onError?.(new Error("browser_tts_unavailable")); return; }
    this.stop();
    const playbackId = this.playbackId;

    const clean = text.trim();
    if (!clean) {
      opts?.onEnd?.();
      return;
    }

    const preset = resolveVoicePreset(this.activeVoiceId, opts);
    const voiceId = legacyPresetFor({voice:preset.mimoVoice,accent:preset.accent});
    const bestVoice = pickSpeechVoice(window.speechSynthesis.getVoices(),voiceId,opts?.localOnly);
    if(opts?.localOnly&&!bestVoice){opts.onError?.(new Error('local_voice_unavailable'));return;}
    opts?.onState?.({phase:'playing',provider:'browser',voice:bestVoice?.name,
      message:bestVoice?`${bestVoice.localService?'本机':'浏览器'}声音 · ${bestVoice.name}`:'浏览器默认声音'});

    // Split text into natural sentence fragments to prevent Chromium stutter/timeout bug
    const sentences = splitSentencesForTts(clean);
    if (sentences.length === 0) {
      opts?.onEnd?.();
      return;
    }

    this.isSpeaking = true;
    this.startKeepalive();
    this.unsubscribePreferences=subscribeSpeechPreferences(preferences=>{
      // Web Speech engines apply changes at utterance boundaries; never restart spoken text.
      for(const utterance of this.utterances)utterance.rate=preferences.playbackRate;
    });

    // Queue utterances natively in browser speech synthesis engine to eliminate JS delays
    const total = sentences.length;
    for (let i = 0; i < total; i++) {
      const sentenceText = sentences[i];
      const u = new SpeechSynthesisUtterance(sentenceText);
      if (bestVoice) u.voice = bestVoice;
      u.lang = bestVoice?.lang ?? preset.accent;
      u.rate = opts?.rate ?? getSpeechPreferences().playbackRate;
      this.utterances.push(u);

      if (i === total - 1) {
        u.onend = () => {
          if (this.playbackId !== playbackId) return;
          this.clearKeepalive();
          this.isSpeaking = false;
          this.utterances=[];this.unsubscribePreferences?.();this.unsubscribePreferences=null;
          opts?.onEnd?.();
        };
      }

      u.onerror = (e) => {
        if (this.playbackId !== playbackId) return;
        if (e.error === "canceled" || e.error === "interrupted") return;
        this.stop();
        opts?.onError?.(e);
      };

      window.speechSynthesis.speak(u);
    }
  }

  private startKeepalive() {
    this.clearKeepalive();
    this.utterances=[];this.unsubscribePreferences?.();this.unsubscribePreferences=null;
    this.keepaliveTimer = setInterval(() => {
      if (typeof window !== "undefined" && window.speechSynthesis && window.speechSynthesis.speaking) {
        window.speechSynthesis.pause();
        window.speechSynthesis.resume();
      }
    }, 12000);
  }

  private clearKeepalive() {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  stop(): void {
    this.playbackId++;
    this.isSpeaking = false;
    this.clearKeepalive();
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    window.speechSynthesis.cancel();
  }
}

class ServerTtsProvider implements TTSProvider {
  readonly name = "mimo-with-webspeech-fallback";
  private activeVoiceId:VoicePresetId=DEFAULT_VOICE_PRESET;
  private player:LightAudioPlayer;
  private options:SpeakOptions|undefined;
  private began=false;
  constructor(private readonly fallback:TTSProvider){
    this.activeVoiceId=getStoredVoicePreference();
    this.player=new LightAudioPlayer(fallback,state=>{
      this.options?.onState?.(state);
      if(state.phase==='playing')this.began=true;
      if(state.phase==='idle'&&state.provider&&this.began){this.began=false;this.options?.onEnd?.();}
      if(state.phase==='error')this.options?.onError?.(new Error(state.message));
    });
  }
  getVoice(){return legacyPresetFor(getSpeechPreferences());}
  setVoice(id:VoicePresetId){this.activeVoiceId=id;setStoredVoicePreference(id);this.fallback.setVoice(id);}
  speak(text:string,opts?:SpeakOptions){
    this.stop(undefined,true);if(!text.trim()){this.player.prime(null,null,false);opts?.onEnd?.();return;}
    this.options=opts;
    const preset=resolveVoicePreset(this.getVoice(),opts),input={text:text.trim(),voiceId:preset.id,voice:preset.mimoVoice,accent:preset.accent,rate:opts?.rate,retryUnknown:opts?.retryUnknown,style:opts?.style,playbackMode:opts?.playbackMode};
    this.player.prime(input,null,false);void this.player.play(input);
  }
  stop(ownerId?:string,preserveAudio=false){if(ownerId&&this.options?.ownerId!==ownerId)return;const previous=this.options;this.options=undefined;this.began=false;if(!preserveAudio)this.player.prime(null,null,false);this.player.stop();previous?.onState?.({phase:'idle',provider:null,message:''});}
}

let provider: TTSProvider | null = null;

/** 仅供明确标示来源的故障降级，不再次请求服务器。 */
export function createBrowserSpeechProvider(): TTSProvider { return new WebSpeechProvider(); }

export function getTTS(): TTSProvider {
  if (!provider) provider = new ServerTtsProvider(new WebSpeechProvider());
  return provider;
}

export function getSpeechStatus(): {
  isWebSpeechSupported: boolean;
  hasNaturalVoice: boolean;
} {
  if (typeof window === "undefined" || !window.speechSynthesis) {
    return { isWebSpeechSupported: false, hasNaturalVoice: false };
  }
  const voices = window.speechSynthesis.getVoices();
  const hasNatural = voices.some((v) => /natural|online|neural/i.test(v.name));
  return { isWebSpeechSupported: true, hasNaturalVoice: hasNatural };
}
