import {z} from 'zod';
import {sha256Text} from '@/lib/platform/hash';

const id=z.string().min(1).max(160);
export const highlightContextSchema=z.object({sentenceId:id,language:z.enum(['zh','en']),textVersion:id});
export const highlightReadSchema=highlightContextSchema.omit({language:true});
export const highlightAddSchema=highlightContextSchema.extend({start:z.number().int().min(0).max(100000),end:z.number().int().min(1).max(100000),quote:z.string().min(1).max(4000),clientRequestId:id});
export type HighlightContext=z.infer<typeof highlightContextSchema>;
export type HighlightAdd=z.infer<typeof highlightAddSchema>;
export interface HighlightMark {id:string;sentenceId:string;language:'zh'|'en';textVersion:string;sourceVersion:string;start:number;end:number;quote:string;pending?:boolean}
export type SentenceHighlight=HighlightMark;
export interface HighlightList {highlights:HighlightMark[];unmappedCount:number}
export interface HighlightAnchor {start_offset:number;end_offset:number;text_hash:string;quote:string;prefix:string;suffix:string}
export interface StoredSentenceHighlight extends HighlightAnchor {id:string;sentence_id:string;language:'zh'|'en';text_version:string;state:string;client_request_id:string;request_hash:string}
export function highlightAnchor(text:string,start:number,end:number):HighlightAnchor {return {start_offset:start,end_offset:end,text_hash:sha256Text(text),quote:text.slice(start,end),prefix:text.slice(Math.max(0,start-24),start),suffix:text.slice(end,end+24)};}
/** UTF-16 offsets match DOM Range. Reject cuts through a surrogate pair. */
export function validHighlightRange(text:string,start:number,end:number,quote:string){
  const boundary=(offset:number)=>offset===0||offset===text.length||!(text.charCodeAt(offset)>=0xDC00&&text.charCodeAt(offset)<=0xDFFF&&text.charCodeAt(offset-1)>=0xD800&&text.charCodeAt(offset-1)<=0xDBFF);
  return start>=0&&end>start&&end<=text.length&&text.slice(start,end)===quote&&quote.trim().length>0&&boundary(start)&&boundary(end);
}
/** GET projects a safe same-identity anchor but never mutates the original record. */
export function reanchorHighlight(text:string,anchor:HighlightAnchor):{start:number;end:number}|null {
  if(sha256Text(text)===anchor.text_hash&&validHighlightRange(text,anchor.start_offset,anchor.end_offset,anchor.quote))return {start:anchor.start_offset,end:anchor.end_offset};
  const candidates:Array<{start:number;end:number}>=[];
  for(let index=text.indexOf(anchor.quote);index>=0;index=text.indexOf(anchor.quote,index+1)){
    const end=index+anchor.quote.length;
    if((!anchor.prefix||text.slice(Math.max(0,index-anchor.prefix.length),index)===anchor.prefix)&&(!anchor.suffix||text.slice(end,end+anchor.suffix.length)===anchor.suffix))candidates.push({start:index,end});
  }
  return candidates.length===1?candidates[0]:null;
}
export function projectStoredSentenceHighlights(rows:StoredSentenceHighlight[],context:HighlightContext,text:string):HighlightList {
  const highlights:HighlightMark[]=[];let unmappedCount=0;
  for(const row of rows){if(row.sentence_id!==context.sentenceId||row.language!==context.language||row.state!=='active')continue;const range=reanchorHighlight(text,row);if(!range){unmappedCount++;continue;}highlights.push({id:row.id,sentenceId:row.sentence_id,language:row.language,textVersion:context.textVersion,sourceVersion:row.text_version,...range,quote:row.quote});}
  return {highlights,unmappedCount};
}
export interface HighlightSegment {start:number;end:number;text:string;manualIds:string[];ai:boolean}
export function highlightSegments(text:string,marks:Array<Pick<HighlightMark,'id'|'start'|'end'>>,aiRanges:Array<{start:number;end:number}>=[]):HighlightSegment[] {
  const valid=(range:{start:number;end:number})=>range.start>=0&&range.end>range.start&&range.end<=text.length;
  const personal=marks.filter(valid),automatic=aiRanges.filter(valid);
  const boundaries=[...new Set([0,text.length,...personal.flatMap(range=>[range.start,range.end]),...automatic.flatMap(range=>[range.start,range.end])])].sort((a,b)=>a-b);
  return boundaries.slice(0,-1).map((start,index)=>{const end=boundaries[index+1];return {start,end,text:text.slice(start,end),manualIds:personal.filter(range=>range.start<=start&&range.end>=end).map(range=>range.id),ai:automatic.some(range=>range.start<=start&&range.end>=end)};});
}
