import { query as sql } from "@/lib/platform/sql";
import type { SqlReader } from "@/lib/platform/database";
import { auditPracticeMaterials } from "@/lib/four-step/audit";
import { type MaterialRow } from "@/lib/four-step/material-types";
import { hash } from "@/lib/four-step/shared";
import { speakingAttemptAnalysisSchema } from "@/lib/speaking-practice/schemas";
import { LightStudyError, type LightCard, type LightScope, type LightSource } from "./contracts";
import {currentReadyMaterialPredicate} from './current-material';

export interface ProgressRow {
  learning_item_id:string; first_seen_at:string; last_seen_at:string; due_at:string;
  fsrs_json:string|null; review_count:number; version:number; last_rating:string|null;
  scheduler_version:string;
}
export function materialFingerprint(material: MaterialRow) {
  return hash(material.input_json, material.analysis_json, material.review_json,
    material.generator_run_id ?? "", material.reviewer_run_id ?? "");
}

export function createLightCatalogue(db:SqlReader,allowMock=false) {
/** 独立只读投影，不以ready字样代替审核链，不调用生成服务。 */
async function readLightCatalogue(scope:LightScope,includeHidden=false,includeSelfKnown=false) {
  if (scope.type === "question" && !(await db.all(sql`SELECT id FROM questions WHERE id=${scope.id}`)).length) {
    throw new LightStudyError("题目不存在",404,"scope_not_found");
  }
  if (scope.type === "material" && !(await db.all(sql`SELECT id FROM practice_materials WHERE id=${scope.id}`)).length) {
    throw new LightStudyError("材料不存在",404,"scope_not_found");
  }
  const where = scope.type === "question" ? sql`pm.question_id=${scope.id}` : scope.type === "material" ? sql`pm.id=${scope.id}` : scope.type === "collection" ? sql`pm.source_type=${scope.id === "ielts" ? "ielts_practice" : "free_talk"}` : sql`1=1`;
  const filters=scope.type==='collection'&&scope.id==='ielts'?scope:null;
  const materials = await db.all<MaterialRow & {title:string;question_title:string|null;topic_id:string|null;topic_title:string|null}>(sql`
    SELECT pm.*,COALESCE(NULLIF(q.text_zh,''),q.text,ft.title,'我的表达') AS title,
      COALESCE(NULLIF(q.text_zh,''),q.text) AS question_title,t.id AS topic_id,COALESCE(NULLIF(t.name_zh,''),t.name_en) AS topic_title FROM practice_materials pm
    LEFT JOIN questions q ON q.id=pm.question_id
    LEFT JOIN topics t ON t.id=q.topic_id
    LEFT JOIN free_talk_conversations ft ON pm.source_type='free_talk' AND ft.id=pm.source_id
    WHERE ${where} AND pm.contract_version='evidence_v2'
      AND ${{sql:currentReadyMaterialPredicate}}
      AND (${filters?.questionId?sql`pm.question_id=${filters.questionId}`:sql`1=1`})
      AND (${filters?.topicId?(filters.topicId==='unmarked'?sql`q.topic_id IS NULL OR t.id IS NULL`:sql`q.topic_id=${filters.topicId}`):sql`1=1`})
      AND (${filters?.seasonId?(filters.seasonId==='unmarked'?sql`NOT EXISTS(SELECT 1 FROM question_set_links qsl JOIN question_sets qs ON qs.id=qsl.question_set_id WHERE qsl.question_id=q.id)`:sql`EXISTS(SELECT 1 FROM question_set_links qsl JOIN question_sets qs ON qs.id=qsl.question_set_id WHERE qsl.question_id=q.id AND qs.id=${filters.seasonId})`):sql`1=1`})
      AND NOT EXISTS(SELECT 1 FROM practice_answer_sources map JOIN personal_answers pa ON pa.id=map.answer_id
        WHERE map.attempt_id=pm.source_id AND pa.superseded_by_revision_id IS NOT NULL)
    ORDER BY julianday(pm.created_at) DESC,pm.id DESC`);
  const seasons=await db.all<{question_id:string;id:string;title:string}>(sql`SELECT DISTINCT qsl.question_id,qs.id,qs.name_zh AS title FROM question_set_links qsl JOIN question_sets qs ON qs.id=qsl.question_set_id ORDER BY qs.sort,qs.year,qs.start_month,qs.id`);
  const ready = materials.filter(m => m.status === "ready");
  const audit = await auditPracticeMaterials({execute:async statement=>({rows:await db.all<Record<string,unknown>>(typeof statement==="string"?{sql:statement}:statement)})},
    allowMock, ready.map(m=>m.id));
  const rejected = new Set(audit.issues.map(i=>i.materialId));
  const links = await db.all<{material_id:string;learning_item_id:string;row_index:number}>(sql`
    SELECT mi.* FROM practice_material_items mi JOIN learning_items i ON i.id=mi.learning_item_id
    WHERE i.status='active' AND ${includeHidden?sql`1=1`:sql`NOT EXISTS(SELECT 1 FROM expression_preferences p WHERE p.learning_item_id=i.id AND p.hidden=1)`}
      AND ${includeSelfKnown?sql`1=1`:sql`NOT EXISTS(SELECT 1 FROM expression_preferences p WHERE p.learning_item_id=i.id AND p.self_known=1)`} ORDER BY mi.row_index`);
  const progress = new Map((await db.all<ProgressRow>(sql`SELECT * FROM light_study_progress`)).map(p=>[p.learning_item_id,p]));
  const cards:LightCard[]=[];
  for (const material of ready.filter(m=>!rejected.has(m.id))) {
    const analysis = speakingAttemptAnalysisSchema.parse(JSON.parse(material.analysis_json));
    for (const link of links.filter(l=>l.material_id===material.id)) {
      const row = analysis.learningMaterials[link.row_index];
      if (!row) continue;
      const source:LightSource={materialId:material.id,sourceType:material.source_type as LightSource["sourceType"],sourceId:material.source_id,
        title:material.title||"我的表达",questionId:material.question_id,questionTitle:material.question_title??'',topicId:material.topic_id,topicTitle:material.topic_title??'未标注',
        seasons:seasons.filter(season=>season.question_id===material.question_id).map(({id,title})=>({id,title})),
        href:material.question_id ? `/questions/${encodeURIComponent(material.question_id)}/attempts/${encodeURIComponent(material.source_id)}` : "/free-talk"};
      cards.push({itemId:link.learning_item_id,materialId:material.id,materialHash:materialFingerprint(material),
        rowIndex:link.row_index,progressVersion:progress.get(link.learning_item_id)?.version ?? 0,
        chinese:row.chineseChunk,english:row.englishChunk,sentenceZh:row.yourChineseSentence,sentenceEn:row.naturalEnglishSentence,
        originalEnglish:row.originalEnglish ?? "",reasonZh:row.inclusionReasonZh ?? "",
        sourceTitle:source.title,questionId:material.question_id,sourceHref:source.href,sourceType:source.sourceType,sources:[source],
      });
    }
  }
  // 先按材料新近/原行序选参考场景，随后按稳定学习项去重，不重建词书。
  const seen = new Map<string,LightCard>();
  const unique = cards.filter(card => {
    const previous=seen.get(card.itemId);
    if (previous) { if(!previous.sources!.some(source=>source.materialId===card.materialId))previous.sources!.push(...card.sources!);return false; }
    seen.set(card.itemId,card);
    return true;
  });
  return {cards:unique,progress,unavailableCount:materials.length-ready.length+rejected.size};
}

async function snapshotAvailability(card:LightCard) {
  try {
    const [preference]=await db.all<{self_known:number}>(sql`SELECT self_known FROM expression_preferences WHERE learning_item_id=${card.itemId}`);
    if(preference?.self_known)return "这项表达已设为已掌握（自评），已停止推送；可在我的表达中恢复。";
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
