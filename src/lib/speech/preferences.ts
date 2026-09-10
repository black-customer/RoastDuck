import {DEFAULT_MIMO_VOICE,DEFAULT_SPEECH_ACCENT,DEFAULT_VOICE_PRESET,MIMO_TTS_VOICES,PLAYBACK_RATES,VOICE_PRESETS,type MimoVoice,type PlaybackRate,type SpeechAccent,type VoicePresetId} from './contracts';

export interface SpeechPreferences {version:3;voice:MimoVoice;accent:SpeechAccent;playbackRate:PlaybackRate}
export const SPEECH_PREFERENCES_KEY='roastduck_speech_preferences_v3';
export const SPEECH_PREFERENCES_EVENT='roastduck:speech-preferences';
export const DEFAULT_SPEECH_PREFERENCES:SpeechPreferences={version:3,voice:DEFAULT_MIMO_VOICE,accent:DEFAULT_SPEECH_ACCENT,playbackRate:1};
const LEGACY_VOICE_KEY='roastduck_active_voice';
const isVoice=(value:unknown):value is MimoVoice=>MIMO_TTS_VOICES.includes(value as MimoVoice);
const isAccent=(value:unknown):value is SpeechAccent=>value==='en-US'||value==='en-GB';
const isRate=(value:unknown):value is PlaybackRate=>PLAYBACK_RATES.includes(value as PlaybackRate);
let sessionPreference:{owner:Window;preferences:SpeechPreferences}|null=null;

export function legacyPresetFor(preferences:Pick<SpeechPreferences,'voice'|'accent'>):VoicePresetId {
  return `${preferences.accent==='en-GB'?'uk':'us'}-${preferences.voice==='Milo'||preferences.voice==='Dean'?'male':'female'}` as VoicePresetId;
}
/** The old male default becomes Milo; old female/accent selections are preserved. */
export function getSpeechPreferences():SpeechPreferences {
  if(typeof window==='undefined')return {...DEFAULT_SPEECH_PREFERENCES};
  if(sessionPreference?.owner===window)return sessionPreference.preferences;
  try {
    const raw=window.localStorage.getItem(SPEECH_PREFERENCES_KEY);
    if(raw){try {const value=JSON.parse(raw);if(value.version===3&&isVoice(value.voice)&&isAccent(value.accent)&&isRate(value.playbackRate))return value;}catch{/* A damaged new setting must not discard a valid old accent/voice choice. */}}
    const legacy=window.localStorage.getItem(LEGACY_VOICE_KEY);
    const preset=VOICE_PRESETS.find(value=>value.id===legacy)??VOICE_PRESETS.find(value=>value.id===DEFAULT_VOICE_PRESET)!;
    return {version:3,voice:preset.mimoVoice,accent:preset.accent,playbackRate:1};
  } catch {return {...DEFAULT_SPEECH_PREFERENCES};}
}
/** Returns false when persistence failed; subscribers still receive the session choice. */
export function setSpeechPreferences(patch:Partial<Omit<SpeechPreferences,'version'>>):boolean {
  if(typeof window==='undefined')return false;
  const previous=getSpeechPreferences(),next:SpeechPreferences={...previous,
    ...(isVoice(patch.voice)?{voice:patch.voice}:{}),...(isAccent(patch.accent)?{accent:patch.accent}:{}),...(isRate(patch.playbackRate)?{playbackRate:patch.playbackRate}:{})};
  let saved=true;
  try {window.localStorage.setItem(SPEECH_PREFERENCES_KEY,JSON.stringify(next));window.localStorage.setItem(LEGACY_VOICE_KEY,legacyPresetFor(next));}
  catch {saved=false;}
  sessionPreference=saved?null:{owner:window,preferences:next};
  window.dispatchEvent?.(new CustomEvent<SpeechPreferences>(SPEECH_PREFERENCES_EVENT,{detail:next}));
  return saved;
}
export function subscribeSpeechPreferences(listener:(preferences:SpeechPreferences)=>void):()=>void {
  if(typeof window==='undefined'||typeof window.addEventListener!=='function')return ()=>{};
  const local=(event:Event)=>listener((event as CustomEvent<SpeechPreferences>).detail);
  const storage=(event:StorageEvent)=>{if(event.key===SPEECH_PREFERENCES_KEY||event.key===LEGACY_VOICE_KEY||event.key===null){sessionPreference=null;listener(getSpeechPreferences());}};
  window.addEventListener(SPEECH_PREFERENCES_EVENT,local);window.addEventListener('storage',storage);
  return ()=>{window.removeEventListener(SPEECH_PREFERENCES_EVENT,local);window.removeEventListener('storage',storage);};
}
/** Source accent overrides only accent; it never silently swaps the chosen speaker. */
export function resolveSpeechSelection(input:{voiceId?:VoicePresetId;voice?:MimoVoice;accent?:SpeechAccent}):Pick<SpeechPreferences,'voice'|'accent'> {
  const saved=getSpeechPreferences();
  const legacy=input.voiceId&&input.voiceId!==legacyPresetFor(saved)?VOICE_PRESETS.find(value=>value.id===input.voiceId):null;
  return {voice:input.voice??legacy?.mimoVoice??saved.voice,accent:input.accent??legacy?.accent??saved.accent};
}
