import { query as sql } from "@/lib/platform/sql";
import type { SqlReader } from "@/lib/platform/database";
import { auditPracticeMaterials } from "@/lib/four-step/audit";
import { type MaterialRow } from "@/lib/four-step/material-types";
import { hash } from "@/lib/four-step/shared";
import { speakingAttemptAnalysisSchema } from "@/lib/speaking-practice/schemas";
import { LightStudyError, type LightCard, type LightScope } from "./contracts";

export interface ProgressRow {
  learning_item_id:string; first_seen_at:string; last_seen_at:string; due_at:string;
  fsrs_json:string|null; review_count:number; version:number; last_rating:string|null;
}
export function materialFingerprint(material: MaterialRow) {
  return hash(material.input_json, material.analysis_json, material.review_json,
    material.generator_run_id ?? "", material.reviewer_run_id ?? "");
}

export function createLightCatalogue(db:SqlReader,allowMock=false) {
/** 独立只读投影，不以ready字样代替审核链，不调用生成服务。 */
async function readLightCatalogue(scope:LightScope,includeHidden=false) {
  if (scope.type === "question" && !(await db.all(sql`SELECT id FROM questions WHERE id=${scope.id}`)).length) {
    throw new LightStudyError("题目不存在",404,"scope_not_found");
  }
  if (scope.type === "material" && !(await db.all(sql`SELECT id FROM practice_materials WHERE id=${scope.id}`)).length) {
    throw new LightStudyError("材料不存在",404,"scope_not_found");
  }
  const where = scope.type === "question" ? sql`pm.question_id=${scope.id}` : scope.type === "material" ? sql`pm.id=${scope.id}` : sql`1=1`;
  const materials = await db.all<MaterialRow & {title:string}>(sql`
    SELECT pm.*,COALESCE(q.text_zh,ft.title,'我的表达') AS title FROM practice_materials pm
    LEFT JOIN questions q ON q.id=pm.question_id
    LEFT JOIN free_talk_conversations ft ON pm.source_type='free_talk' AND ft.id=pm.source_id
    WHERE ${where} AND pm.contract_version='evidence_v2'
      AND NOT EXISTS(SELECT 1 FROM practice_answer_sources map JOIN personal_answers pa ON pa.id=map.answer_id
        WHERE map.attempt_id=pm.source_id AND pa.superseded_by_revision_id IS NOT NULL)
    ORDER BY julianday(pm.updated_at) DESC,pm.id`);
  const ready = materials.filter(m => m.status === "ready");
  const audit = await auditPracticeMaterials({execute:async statement=>({rows:await db.all<Record<string,unknown>>(typeof statement==="string"?{sql:statement}:statement)})},
    allowMock, ready.map(m=>m.id));
  const rejected = new Set(audit.issues.map(i=>i.materialId));
  const links = await db.all<{material_id:string;learning_item_id:string;row_index:number}>(sql`
    SELECT mi.* FROM practice_material_items mi JOIN learning_items i ON i.id=mi.learning_item_id
    WHERE i.status='active' AND ${includeHidden?sql`1=1`:sql`NOT EXISTS(SELECT 1 FROM expression_preferences p WHERE p.learning_item_id=i.id AND p.hidden=1)`} ORDER BY mi.row_index`);
  const progress = new Map((await db.all<ProgressRow>(sql`SELECT * FROM light_study_progress`)).map(p=>[p.learning_item_id,p]));
  const cards:LightCard[]=[];
  for (const material of ready.filter(m=>!rejected.has(m.id))) {
    const analysis = speakingAttemptAnalysisSchema.parse(JSON.parse(material.analysis_json));
    for (const link of links.filter(l=>l.material_id===material.id)) {
      const row = analysis.learningMaterials[link.row_index];
      if (!row) continue;
      cards.push({itemId:link.learning_item_id,materialId:material.id,materialHash:materialFingerprint(material),
        rowIndex:link.row_index,progressVersion:progress.get(link.learning_item_id)?.version ?? 0,
        chinese:row.chineseChunk,english:row.englishChunk,sentenceZh:row.yourChineseSentence,sentenceEn:row.naturalEnglishSentence,
        originalEnglish:row.originalEnglish ?? "",reasonZh:row.inclusionReasonZh ?? "",
        sourceTitle:material.title || "我的表达",questionId:material.question_id,
        sourceHref:material.question_id ? `/questions/${encodeURIComponent(material.question_id)}/attempts/${encodeURIComponent(material.source_id)}` : "/free-talk",
      });
    }
  }
  // 先按材料新近/原行序选参考场景，随后按稳定学习项去重，不重建词书。
  const seen = new Set<string>();
  const unique = cards.filter(card => {
    if (seen.has(card.itemId)) return false;
    seen.add(card.itemId);
    return true;
  });
  return {cards:unique,progress,unavailableCount:materials.length-ready.length+rejected.size};
}

async function snapshotAvailability(card:LightCard) {
  try {
    const catalogue=await readLightCatalogue({type:"material",id:card.materialId});
    const live=catalogue.cards.find(c=>c.itemId===card.itemId && c.rowIndex===card.rowIndex && c.materialHash===card.materialHash);
    if (!live) return "这项材料已更新或暂不可用，将跳过，不计为学过。";
    if (live.progressVersion!==card.progressVersion) return "这项表达已在另一批次更新，将跳过，不重复记录。";
    return null;
  } catch (error) {
    if(error instanceof LightStudyError && error.status===404) return "这项材料已移除，将跳过，不计为学过。";
    throw error;
  }
}

return {readLightCatalogue,snapshotAvailability};
}
