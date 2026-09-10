import type {MaterialInput} from './material-types';
import {hash} from './shared';

/** Stable source identity excludes display/generation version and revision metadata. */
export function materialSourceHash(input:MaterialInput){
  return hash(JSON.stringify({sourceType:input.sourceType,sourceId:input.sourceId,question:input.question,mode:input.mode,actualAnswer:input.actualAnswer,intendedMeaningZh:input.intendedMeaningZh,inputFormat:input.inputFormat??null,rawInput:input.rawInput??null,sourceMessages:input.sourceMessages??null}));
}
