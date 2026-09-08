import type { Client } from "@libsql/client";
import { compileSourceRevision } from "./source-revisions";
import { recoverySourceSchema } from "./offline-contracts";
/** 只读验收追加修订；原文、连续偏移及子回答任何漂移都会失败。 */
export async function auditSourceRevisions(client:Client){
  const records=(await client.execute("SELECT * FROM practice_source_revisions")).rows;
  const failures:Array<{id:string;reason:string}>=[];
  let children=0,nonAnswerParents=0;
  for(const row of records){
    try{
      const snapshot=JSON.parse(String(row.snapshot_json));
      const compiled=compileSourceRevision(recoverySourceSchema.parse(snapshot.source),snapshot.revision);
      if(compiled.id!==row.id||compiled.source.key!==row.parent_answer_id||compiled.source.hash!==row.source_hash||compiled.revision.reviewerContext!==row.reviewer_context||JSON.stringify(compiled)!==JSON.stringify(snapshot))throw new Error("revision_evidence_changed");
      const parent=(await client.execute({sql:"SELECT raw_text,superseded_by_revision_id FROM personal_answers WHERE id=?",args:[compiled.source.key]})).rows[0];
      if(!parent||parent.raw_text!==compiled.source.english||parent.superseded_by_revision_id!==compiled.id)throw new Error("parent_original_changed");
      const actual=(await client.execute({sql:"SELECT id,question_id,raw_text,created_at FROM personal_answers WHERE source_revision_id=?",args:[compiled.id]})).rows;
      if(actual.length!==compiled.children.length)throw new Error("child_coverage_changed");
      for(const child of compiled.children){
        const a=actual.find(a=>a.id===child.id);
        if(!a||a.question_id!==child.questionId||a.raw_text!==child.raw||a.created_at!==compiled.source.createdAt)throw new Error("child_original_changed");
      }
      children+=actual.length;if(!actual.length)nonAnswerParents++;
    }catch(error){failures.push({id:String(row.id),reason:error instanceof Error?error.message:"invalid_source_revision"});}
  }
  return {ok:!failures.length,checked:records.length,children,nonAnswerParents,failures};
}
