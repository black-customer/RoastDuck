import type { ComponentType,ReactNode } from "react";
import type { VoicePresetId } from "@/lib/speech/contracts";
import type { LightAudioPlayer,LightAudioState } from "./audio";
import type { LightEvent,LightMode,LightScope,LightOverview,LightView } from "./contracts";

export type LightAudioController=Pick<LightAudioPlayer,"prime"|"play"|"stop"|"dispose">;
export type LightLink=ComponentType<{href:string;className?:string;children:ReactNode}>;
/** UI depends on application operations, not desktop HTTP routes. */
export interface LightStudyClient {
  overview(scope:LightScope):Promise<LightOverview>;
  get(id:string):Promise<LightView>;
  create(input:{scope:LightScope;mode:LightMode;clientRequestId:string;resumeSessionId?:string}):Promise<LightView>;
  event(id:string,event:LightEvent):Promise<LightView>;
  autoPlay():Promise<boolean>;
  setAutoPlay?(value:boolean):Promise<void>;
  audio(update:(state:LightAudioState)=>void):LightAudioController;
  voice():VoicePresetId;
  setVoice(voice:VoicePresetId):void;
  rememberSession(id:string):void;
}
