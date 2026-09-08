import {sha256Text} from "@/lib/platform/hash";
import {MIMO_TTS_MODEL,MIMO_TTS_VERSION,type SpeechSynthesisInput} from "./contracts";
export function audioDescriptor(input:SpeechSynthesisInput,voice:string){return {text:input.text,purpose:input.purpose,accent:input.accent,rate:input.rate,model:MIMO_TTS_MODEL,voice,version:MIMO_TTS_VERSION};}
export const speechContentHash=(input:SpeechSynthesisInput,voice:string)=>sha256Text(JSON.stringify(audioDescriptor(input,voice)));
export function buildMimoBody(input:SpeechSynthesisInput,voice:string){
  const speed=input.rate<.85?"slow and carefully articulated":input.rate>1.08?"lively but still easy to follow":"natural conversational pace";
  const accent=input.accent==="en-GB"?"natural contemporary British English":"natural contemporary General American English";
  return {model:MIMO_TTS_MODEL,messages:[{role:"user",content:`Speak in ${accent}, at a ${speed}. Sound warm, human, and appropriate for an adult language learner. Preserve every word exactly; do not add explanations or omit content.`},{role:"assistant",content:input.text}],audio:{format:"wav",voice},stream:false};
}
