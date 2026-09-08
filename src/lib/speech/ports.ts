import type {SpeechSynthesisInput} from "./contracts";
export interface PreparedAudio {assetId:string;url:string;provider:"mimo";cached:boolean}
export interface SpeechPort {prepare(input:SpeechSynthesisInput,options?:{regenerateMissing?:boolean}):Promise<PreparedAudio>}
