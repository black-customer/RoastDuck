import type {SqlReader} from '@/lib/platform/database';
import {query as sql} from '@/lib/platform/sql';
import type {MaterialRow,MaterialInput} from '@/lib/four-step/material-types';
import {speakingAttemptAnalysisSchema} from '@/lib/speaking-practice/schemas';
import {materialFingerprint} from '@/lib/light-study/core-catalogue';
import {currentReadyMaterialPredicate} from '@/lib/light-study/current-material';
import {compileSentenceEdition} from './editions';
import {projectSentenceMaterials,SENTENCE_VALIDATION_VERSION} from './materials';
import {auditPracticeMaterials} from '@/lib/four-step/audit';
import {compileTeachingEdition,type TeachingEditionRow} from './teaching-editions';
import {sha256Text} from '@/lib/platform/hash';
/** Explicit audit, never a click-path prerequisite. Reports no private source text. */
export async function auditSentenceMaterials(db:SqlReader,allowMock=false){
  const materials=await db.all<MaterialRow>(sql`SELECT pm.* FROM practice_materials pm WHERE pm.status='ready' AND pm.contract_version='evidence_v2' AND ${{sql:currentReadyMaterialPredicate}}`);
  const issues:Array<{materialId:string;code:string}>=[];let sentences=0,attention=0;
  for(const m of materials){try{
    const [cache]=await db.all<{fingerprint:string;rule_version:string;valid:number}>(sql`SELECT * FROM material_validation_cache WHERE material_id=${m.id}`);
    if(!cache?.valid||cache.fingerprint!==materialFingerprint(m)||cache.rule_version!==SENTENCE_VALIDATION_VERSION)throw new Error('validation_receipt');
    const [edition]=await db.all<{author_json:string;review_json:string;cards_json:string;status:string}>(sql`SELECT * FROM sentence_material_editions WHERE material_id=${m.id} ORDER BY created_at DESC,id DESC LIMIT 1`);
    let cards;
    if(edition){if(edition.status!=='ready')throw new Error('edition_withdrawn');const raw=JSON.parse(edition.author_json);
      if(raw.version==='sentence-teaching-revision-v1'){
        const [parent]=raw.parentEditionId?await db.all<{cards_json:string}>(sql`SELECT cards_json FROM sentence_material_editions WHERE id=${raw.parentEditionId} AND material_id=${m.id}`):[];
        const original=parent?JSON.parse(parent.cards_json):projectSentenceMaterials(m.id,JSON.parse(m.input_json),speakingAttemptAnalysisSchema.parse(JSON.parse(m.analysis_json)));
        if(JSON.stringify(original)!==JSON.stringify(raw.sourceCards))throw new Error('teaching_revision_parent');
        if(raw.replacesEditionId){const [replaced]=await db.all<{cards_json:string}>(sql`SELECT cards_json FROM sentence_material_editions WHERE id=${raw.replacesEditionId} AND material_id=${m.id}`);if(!replaced||sha256Text(replaced.cards_json)!==raw.expectedActiveHash)throw new Error('teaching_revision_replacement');}
      }
      const result=compileSentenceEdition(m,raw,JSON.parse(edition.review_json));cards=result.cards;attention+=result.attention.length;if(JSON.stringify(cards)!==edition.cards_json)throw new Error('edition_contents');}
    else{const base=await auditPracticeMaterials({execute:async c=>({rows:await db.all<Record<string,unknown>>(typeof c==='string'?{sql:c}:c)})},allowMock,[m.id]);if(!base.ok)throw new Error('base_review');cards=projectSentenceMaterials(m.id,JSON.parse(m.input_json) as MaterialInput,speakingAttemptAnalysisSchema.parse(JSON.parse(m.analysis_json)));}
    const rows=await db.all<{id:string;version:string;body_json:string}>(sql`SELECT id,version,body_json FROM sentence_learning_units WHERE material_id=${m.id} AND active=1`);
    if(rows.length!==cards.length||cards.some(c=>!rows.some(r=>r.id===c.id&&r.version===c.version&&r.body_json===JSON.stringify(c))))throw new Error('sentence_projection');
    const [teaching]=await db.all<TeachingEditionRow>(sql`SELECT * FROM sentence_teaching_editions WHERE material_id=${m.id} ORDER BY created_at DESC,id DESC LIMIT 1`);
    if(teaching?.status==='ready'){
      const attachments=JSON.parse(teaching.teachings_json),author=JSON.parse(teaching.author_json);
      const mapping=Object.fromEntries(author.sentences.filter((item:{issue?:{needsConfirmation?:boolean}})=>!item.issue?.needsConfirmation).map((item:{sentenceId:string},i:number)=>[item.sentenceId,attachments[i]?.sentenceId]));
      const sourceCards=edition?JSON.parse(edition.author_json).sourceCards??[]:[];
      const compiled=compileTeachingEdition(m,cards,author,JSON.parse(teaching.review_json),mapping,sourceCards);
      if(compiled.candidateHash!==teaching.candidate_hash||JSON.stringify(compiled.attachments)!==teaching.teachings_json)throw new Error('teaching_projection');
    }
    sentences+=cards.length;
  }catch(e){issues.push({materialId:m.id,code:e instanceof Error?e.message:'invalid_material'});}}
  return {ok:issues.length===0,checked:materials.length,sentences,attention,issues};
}
