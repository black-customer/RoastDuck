import type {SqlReader} from '@/lib/platform/database';
import {query as sql} from '@/lib/platform/sql';
import type {MaterialRow,MaterialInput} from '@/lib/four-step/material-types';
import {speakingAttemptAnalysisSchema} from '@/lib/speaking-practice/schemas';
import {materialFingerprint} from '@/lib/light-study/core-catalogue';
import {currentReadyMaterialPredicate} from '@/lib/light-study/current-material';
import {compileSentenceEdition} from './editions';
import {projectSentenceMaterials,SENTENCE_VALIDATION_VERSION} from './materials';
import {auditPracticeMaterials} from '@/lib/four-step/audit';
/** Explicit audit, never a click-path prerequisite. Reports no private source text. */
export async function auditSentenceMaterials(db:SqlReader,allowMock=false){
  const materials=await db.all<MaterialRow>(sql`SELECT pm.* FROM practice_materials pm WHERE pm.status='ready' AND pm.contract_version='evidence_v2' AND ${{sql:currentReadyMaterialPredicate}}`);
  const issues:Array<{materialId:string;code:string}>=[];let sentences=0,attention=0;
  for(const m of materials){try{
    const [cache]=await db.all<{fingerprint:string;rule_version:string;valid:number}>(sql`SELECT * FROM material_validation_cache WHERE material_id=${m.id}`);
    if(!cache?.valid||cache.fingerprint!==materialFingerprint(m)||cache.rule_version!==SENTENCE_VALIDATION_VERSION)throw new Error('validation_receipt');
    const [edition]=await db.all<{author_json:string;review_json:string;cards_json:string;status:string}>(sql`SELECT * FROM sentence_material_editions WHERE material_id=${m.id} ORDER BY created_at DESC,id DESC LIMIT 1`);
    let cards;
    if(edition){if(edition.status!=='ready')throw new Error('edition_withdrawn');const result=compileSentenceEdition(m,JSON.parse(edition.author_json),JSON.parse(edition.review_json));cards=result.cards;attention+=result.attention.length;if(JSON.stringify(cards)!==edition.cards_json)throw new Error('edition_contents');}
    else{const base=await auditPracticeMaterials({execute:async c=>({rows:await db.all<Record<string,unknown>>(typeof c==='string'?{sql:c}:c)})},allowMock,[m.id]);if(!base.ok)throw new Error('base_review');cards=projectSentenceMaterials(m.id,JSON.parse(m.input_json) as MaterialInput,speakingAttemptAnalysisSchema.parse(JSON.parse(m.analysis_json)));}
    const rows=await db.all<{id:string;version:string;body_json:string}>(sql`SELECT id,version,body_json FROM sentence_learning_units WHERE material_id=${m.id} AND active=1`);
    if(rows.length!==cards.length||cards.some(c=>!rows.some(r=>r.id===c.id&&r.version===c.version&&r.body_json===JSON.stringify(c))))throw new Error('sentence_projection');
    sentences+=cards.length;
  }catch(e){issues.push({materialId:m.id,code:e instanceof Error?e.message:'invalid_material'});}}
  return {ok:issues.length===0,checked:materials.length,sentences,attention,issues};
}
