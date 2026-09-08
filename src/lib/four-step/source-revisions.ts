import { z } from "zod";
import { sql } from "drizzle-orm";
import { getDbReady, withDbTransaction } from "@db/client";
import { hash } from "./shared";
import { type RecoverySource } from "./offline-contracts";
const text=z.string().min(1);
export const sourceRevisionSchema=z.object({
  sourceIndex:z.number().int(),sourceHash:text,generatorContext:text,reviewerContext:text,reasonZh:text,
  pieces:z.array(z.object({start:z.number().int().nonnegative(),end:z.number().int().positive(),
    kind:z.enum(["answer","retry_answer","question","instruction","non_answer"]),
    questionId:z.string().nullable(),questionEn:z.string().nullable(),reasonZh:text,
  })).min(1),
});
export type SourceRevision=z.infer<typeof sourceRevisionSchema>;
export function compileSourceRevision(source:RecoverySource,raw:SourceRevision){
  const revision=sourceRevisionSchema.parse(raw);
  if(source.kind!=="personal_answer"||source.hash!==revision.sourceHash||source.index!==revision.sourceIndex||revision.generatorContext===revision.reviewerContext)throw new Error("切分来源或独立审核不成立");
  let cursor=0;
  for(const p of revision.pieces){
    if(p.start!==cursor||p.end<=p.start||p.end>source.english.length)throw new Error("切分字符遗漏、重叠或越界");
    if(["answer","retry_answer"].includes(p.kind)&&(!p.questionId||p.questionEn===null))throw new Error("回答缺少核实后的题目");
    cursor=p.end;
  }
  if(cursor!==source.english.length)throw new Error("切分末尾未覆盖");
  const id=`psr_${hash(source.key,JSON.stringify(revision)).slice(0,24)}`;
  const children=revision.pieces.filter(p=>["answer","retry_answer"].includes(p.kind)).map(p=>({
    id:`answer_split_${hash(source.key,p.start,p.end,p.questionId!).slice(0,24)}`,
    questionId:p.questionId!,questionEn:p.questionEn!,start:p.start,end:p.end,raw:source.english.slice(p.start,p.end),
  }));
  return {id,source,revision,children};
}
/** 父答案及其旧版本不删除。新答案严格是原文连续切片；无 Runtime 和进度写入。 */
export async function applySourceRevision(source:RecoverySource,review:SourceRevision){
  const compiled=compileSourceRevision(source,review);
  return withDbTransaction(async()=>{
    const db=await getDbReady();
    const snapshot=JSON.stringify(compiled);
    const [existing]=await db.all<{snapshot_json:string}>(sql`SELECT snapshot_json FROM practice_source_revisions WHERE id=${compiled.id}`);
    if(existing){if(existing.snapshot_json!==snapshot)throw new Error("切分快照漂移");return {id:compiled.id,reused:true,children:compiled.children.map(c=>c.id)};}
    const [parent]=await db.all<{raw_text:string;question_id:string;superseded_by_revision_id:string|null;import_id:string|null;source_segment_id:string|null;source_order:number;created_at:string}>(sql`SELECT * FROM personal_answers WHERE id=${source.key}`);
    if(!parent||parent.raw_text!==source.english||parent.question_id!==source.questionId||parent.superseded_by_revision_id)throw new Error("切分父原文已变化或被修订");
    if((await db.all(sql`SELECT 1 FROM practice_answer_sources WHERE answer_id=${source.key}`)).length)throw new Error("已经发布的答案不能静默切分");
    for(const child of compiled.children){
      const [q]=await db.all<{text:string;part:number}>(sql`SELECT text,part FROM questions WHERE id=${child.questionId}`);
      if(!q||q.text!==child.questionEn||q.part!==source.part)throw new Error("切分题目不匹配");
    }
    const now=new Date().toISOString();
    await db.run(sql`INSERT INTO practice_source_revisions VALUES(${compiled.id},${source.key},${source.hash},${snapshot},${review.reviewerContext},${now})`);
    for(const child of compiled.children){
      const versionId=`av_${hash(child.id,"raw").slice(0,24)}`;
      await db.run(sql`INSERT INTO personal_answers(id,question_id,input_language,raw_text,status,current_version_id,import_id,source_segment_id,source_order,attempt_order,source_kind,source_revision_id,created_at,updated_at)
        VALUES(${child.id},${child.questionId},'en',${child.raw},'ready',${versionId},${parent.import_id},${parent.source_segment_id},${Number(parent.source_order)+child.start},${child.start},'historical_import',${compiled.id},${parent.created_at},${now})`);
      await db.run(sql`INSERT INTO answer_versions(id,answer_id,version_no,kind,text_en,text_zh,change_summary_json,created_at)
        VALUES(${versionId},${child.id},1,'raw_transcript',${child.raw},'','["离线独立切分；原文连续切片，未提升英语水平"]',${parent.created_at})`);
    }
    await db.run(sql`UPDATE personal_answers SET superseded_by_revision_id=${compiled.id} WHERE id=${source.key}`);
    return {id:compiled.id,reused:false,children:compiled.children.map(c=>c.id)};
  });
}
