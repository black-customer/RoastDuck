import {randomUUID} from 'node:crypto';
import {nodeDatabase} from '@/lib/platform/node/database';
import {createSentenceService} from './core-service';
import {readSentenceCatalogue} from './catalogue';
import {query as sql} from '@/lib/platform/sql';
import {safeMaterialPresentation} from './presentation';
export const sentenceStudy=createSentenceService(nodeDatabase,{now:()=>new Date(),newId:randomUUID});
export const sentenceOverview=sentenceStudy.overview;
export async function getMaterialSentences(materialId:string){return nodeDatabase.read(async db=>{
  const data=await readSentenceCatalogue(db,{type:'material',id:materialId});
  const source=data.sources[0];if(!source)return null;
  const [receipt]=await db.all<{result_json:string}>(sql`SELECT result_json FROM material_validation_cache WHERE material_id=${materialId}`);
  const pending=receipt?JSON.parse(receipt.result_json).attention as Array<{chinese:string;reason:string}>|undefined:undefined;
  const [question]=source.type==='question'?await db.all<{text:string;text_zh:string}>(sql`SELECT text,text_zh FROM questions WHERE id=${source.id}`):[];
  return {materialId,questionId:source.type==='question'?source.id:null,questionEn:question?.text??'',questionZh:question?.text_zh??'',sourceType:source.type==='question'?'ielts_practice':'free_talk',sourceId:data.cards[0]?.source.id??source.id,...safeMaterialPresentation(data.cards,pending)};
});}
