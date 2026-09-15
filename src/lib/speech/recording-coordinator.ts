/** Browser-only ownership: every software player checks this before starting or resuming. */
const recordings=new Set<symbol>();
export const RECORDING_EVENT='roastduck:recording-changed';
export const STOP_AUDIO_EVENT='roastduck:stop-all-audio';
export const recordingActive=()=>recordings.size>0;
export function beginRecording(){const token=Symbol('original-answer');recordings.add(token);if(typeof window!=='undefined'){window.dispatchEvent?.(new Event(STOP_AUDIO_EVENT));window.dispatchEvent?.(new Event(RECORDING_EVENT));}let ended=false;return()=>{if(ended)return;ended=true;recordings.delete(token);if(typeof window!=='undefined')window.dispatchEvent?.(new Event(RECORDING_EVENT));};}
export function subscribeRecording(listener:(active:boolean)=>void){if(typeof window==='undefined'||!window.addEventListener)return()=>{};const changed=()=>listener(recordingActive());window.addEventListener(RECORDING_EVENT,changed);return()=>window.removeEventListener(RECORDING_EVENT,changed);}
