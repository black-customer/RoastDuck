import {canonical,type SyncChange,type SyncRow} from './contracts';
const hidden=(row:SyncRow|null)=>row===null||['deleted','dismissed','hidden','removed','retired'].includes(String(row.status));
const time=(a:unknown,b:unknown,first:boolean)=>[String(a??''),String(b??'')].filter(Boolean).sort()[first?0:1]??String(a??b??'');
const ratingWeight:Record<string,number>={forgot:0,Again:0,uncertain:1,fuzzy:1,Hard:1,remembered:2,Good:2};
/** Only concurrent heads enter here. Causally newer updates are applied as-is. */
export function mergeConcurrent(changes:SyncChange[]):{row:SyncRow|null;reason:string|null}{
  const sorted=[...changes].sort((a,b)=>a.id.localeCompare(b.id)),entity=sorted[0].entity;
  const removed=sorted.find(change=>hidden(change.row));if(removed)return {row:removed.row,reason:'revocation_wins'};
  const rows=sorted.map(change=>change.row!);
  if(rows.every(row=>canonical(row)===canonical(rows[0])))return {row:rows[0],reason:null};
  if(['questions','topics','question_sets','question_set_links'].includes(entity)){
    // The bundled public seed has fewer fields than the full desktop source. Prefer the complete row.
    const richness=(row:SyncRow)=>Object.values(row).filter(value=>value!==null&&value!==''&&value!=='[]'&&value!=='{}').length;
    return {row:[...rows].sort((a,b)=>richness(b)-richness(a))[0],reason:'public_source_revision'};
  }
  if(entity==='light_study_progress'){
    const winner=rows.reduce((a,b)=>(ratingWeight[String(a.last_rating)]??0)<=(ratingWeight[String(b.last_rating)]??0)?a:b);
    const result={...winner};
    for(const row of rows){result.due_at=time(result.due_at,row.due_at,true);result.first_seen_at=time(result.first_seen_at,row.first_seen_at,true);result.last_seen_at=time(result.last_seen_at,row.last_seen_at,false);}
    result.review_count=Math.max(...rows.map(row=>Number(row.review_count)));
    result.version=Math.max(...rows.map(row=>Number(row.version)))+1;
    // Existing full FSRS history remains in envelopes. Do not compound two successes from one base.
    if(result.fsrs_json){try{const card=JSON.parse(String(result.fsrs_json));card.due=result.due_at;result.fsrs_json=JSON.stringify(card);}catch{result.fsrs_json=null;}}
    return {row:result,reason:'concurrent_self_ratings_conservative'};
  }
  if(entity==='learning_item_schedule'){
    const row=rows.reduce((a,b)=>String(a.due_at)<String(b.due_at)?a:b);
    return {row:{...row,review_count:Math.max(...rows.map(r=>Number(r.review_count)))},reason:'concurrent_training_review_conservative'};
  }
  if(entity==='companion_memory_control'){
    const cutoffs:Record<string,number>={};for(const row of rows)for(const [id,sequence] of Object.entries(JSON.parse(String(row.cutoffs_json))))cutoffs[id]=Math.max(cutoffs[id]??0,Number(sequence));
    return {row:{...rows[0],generation:Math.max(...rows.map(row=>Number(row.generation)))+1,cutoffs_json:JSON.stringify(cutoffs)},reason:'memory_revocation_union'};
  }
  if(entity==='companion_memories')return {row:{...rows[0],status:'dismissed'},reason:'memory_edit_needs_confirmation'};
  if(entity==='practice_materials'){
    // Select a whole reviewed revision; never combine fields from different reviewers.
    const selected=sorted.find(change=>change.row?.status==='ready')??sorted[0];
    return {row:selected.row,reason:'material_revision_branch'};
  }
  if(entity==='light_study_sessions'||entity==='four_step_sessions')return {row:{...rows[0],status:'paused'},reason:'session_branch_requires_resume'};
  return {row:rows[0],reason:'concurrent_versions_preserved'};
}
