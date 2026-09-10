import { sha256Text } from "@/lib/platform/hash";
import { speakingAttemptAnalysisSchema } from "@/lib/speaking-practice/schemas";
import { materialReviewSchema } from "./contracts";
import { validateMaterial } from "./material-validation";
import type { MaterialInput, MaterialRow } from "./material-types";
import {materialStageContracts,diagnosisRepairPrompt} from "./stage-contracts";
import { reviewSchemaForSource, validateEvidenceReview,diagnosisSchema } from "./selection-contracts";
import {normalizeUniqueQuoteOccurrences} from './quote-normalization';
import {matchesReviewedProjection} from './reviewed-projection';
import { hash } from "./shared";
import {compileOfflineMaterial} from './offline-compile';
import {authorHash} from './offline-contracts';
import {materialSourceHash} from './revision-source';
import {normalizeExpression} from './contracts';

/** Read-only SQL boundary: neither libsql internals nor platform credentials escape it. */
export interface MaterialAuditReader {
  execute(statement:string|{sql:string;args?:Array<string|number|bigint|null>}):Promise<{rows:ReadonlyArray<Record<string,unknown>>}>;
}

/** 只读取当前发布材料；不把退役词书、Mock 或未发布候选混算成真实可学数量。 */
export async function auditPracticeMaterials(client: MaterialAuditReader, allowMock = false, materialIds?: string[]) {
  const issues: Array<{ materialId: string; code: string }> = [];
  const tables = await client.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='practice_materials'");
  if (!tables.rows.length) return { ok: false, checked: 0, availability: "not_initialized", pending: 0, issues: [{ materialId: "", code: "v19_required" }] };
  const rows = (await client.execute(materialIds ? {
    sql: `SELECT * FROM practice_materials WHERE id IN (${materialIds.map(() => "?").join(",") || "NULL"})`, args: materialIds,
  } : "SELECT * FROM practice_materials")).rows as unknown as MaterialRow[];
  let checked = 0;
  for (const material of rows.filter((row) => row.status === "ready")) {
    checked++;
    const fail = (code: string) => issues.push({ materialId: material.id, code });
    try {
      const input = JSON.parse(material.input_json) as MaterialInput;
      const contracts=materialStageContracts(input),repairPrompt=diagnosisRepairPrompt(input);
      const analysis = speakingAttemptAnalysisSchema.parse(JSON.parse(material.analysis_json));
      validateMaterial(analysis,input);
      const offline = (await client.execute({sql:"SELECT * FROM practice_offline_runs WHERE material_id=?",args:[material.id]})).rows;
      if (material.contract_version === "evidence_v2") {
        if (analysis.contractVersion !== "evidence_v2" || !analysis.evidence) throw new Error("missing_evidence");
        const history = (await client.execute({sql:"SELECT s.*,a.role,a.provider,a.status AS run_status,a.input_hash AS run_input_hash,a.prompt_version AS run_prompt FROM practice_material_stages s LEFT JOIN ai_runs a ON a.run_id=s.run_id WHERE s.material_id=? AND s.status='completed'",args:[material.id]})).rows;
        // Sync can preserve more than one valid analysis branch. Follow this publication's exact ancestry.
        const publishedReview=history.find(s=>s.run_id===material.reviewer_run_id&&s.stage==='review');
        const publishedMaterial=history.find(s=>s.run_id===material.generator_run_id&&s.stage==='material');
        const publishedSelection=publishedMaterial?history.find(s=>s.run_id===JSON.parse(String(publishedMaterial.input_json)).selectionRunId&&s.stage==='selection'):undefined;
        const publishedDiagnosis=publishedSelection?history.find(s=>s.run_id===JSON.parse(String(publishedSelection.input_json)).diagnosisRunId&&s.stage==='diagnosis'):undefined;
        const stages=[publishedDiagnosis,publishedSelection,publishedMaterial,publishedReview].filter((s):s is Record<string,unknown>=>!!s);
        if(stages.length!==4 || new Set(stages.map((s)=>s.run_id)).size!==4) throw new Error("stage_coverage");
        const stage = (name:string)=>stages.find((s)=>s.stage===name)!;
        const evidence=analysis.evidence;
        const diagnosisInput=JSON.parse(String(stage("diagnosis").input_json));
        if(stage("diagnosis").prompt_version===repairPrompt){
          const correction=diagnosisInput.correction;
          const previous=correction?(await client.execute({sql:"SELECT * FROM practice_material_stages WHERE run_id=? AND material_id=? AND stage='diagnosis' AND status='rejected'",args:[correction.previousRunId,material.id]})).rows[0]:null;
          if(!previous||JSON.stringify(JSON.parse(String(previous.output_json)))!==JSON.stringify(correction.previousDiagnosis)||!correction.validationIssue||JSON.stringify(diagnosisInput.source)!==JSON.stringify(input))fail("diagnosis_repair_chain");
        }
        const expectedInputs={
          diagnosis:stage("diagnosis").prompt_version===repairPrompt?diagnosisInput:{source:input},
          selection:{source:input,diagnosis:evidence.diagnosis,diagnosisRunId:stage("diagnosis").run_id},
          material:{source:input,diagnosis:evidence.diagnosis,selection:evidence.selection,selectionRunId:stage("selection").run_id},
          review:{source:input,compiled:JSON.parse(String(stage("review").input_json)).compiled,generatorRunId:stage("material").run_id},
        };
        for(const [name,spec] of Object.entries(contracts)) {
          const s=stage(name);
          const json=String(s.input_json);
          const expectedPrompt=name==="diagnosis"&&s.prompt_version===repairPrompt?repairPrompt:spec.prompt;
          const receipt=offline.find(r=>r.run_id===s.run_id);
          if(receipt){
            if(receipt.stage!==name||receipt.provider!=="offline_agent"||!receipt.model||!receipt.context_id||receipt.network_calls!==0||receipt.prompt_version!==spec.prompt||receipt.input_hash!==s.input_hash||receipt.output_hash!==hash(String(s.output_json))||!receipt.artifact_hash) fail("offline_stage_evidence");
          } else if(s.role!==spec.role || s.run_prompt!==expectedPrompt || s.run_status!=="completed" || s.run_input_hash!==sha256Text(json.normalize("NFKC"))) fail("stage_run_evidence");
          if(s.prompt_version!==expectedPrompt||s.input_hash!==hash(expectedPrompt,json))fail("stage_input_hash");
          if(JSON.stringify(JSON.parse(json))!==JSON.stringify(expectedInputs[name as keyof typeof expectedInputs])) fail("stage_source_chain");
          if(!allowMock && s.provider==="mock") fail("mock_diagnosis_is_not_real_review");
        }
        if(stage("material").run_id!==material.generator_run_id || stage("review").run_id!==material.reviewer_run_id) fail("stage_publication_chain");
        for(const [name,output] of [["diagnosis",evidence.diagnosis],["selection",evidence.selection],["material",evidence.draft]] as const) {
          const original=JSON.parse(String(stage(name).output_json));
          const expected=name==='diagnosis'&&input.registerProfileVersion?normalizeUniqueQuoteOccurrences(input,diagnosisSchema.parse(original)).diagnosis:original;
          if(JSON.stringify(expected)!==JSON.stringify(output)) fail("stage_output_chain");
        }
        const reviewSchema=reviewSchemaForSource(input);
        const finalReview=reviewSchema.parse(JSON.parse(String(stage("review").output_json)));
        validateEvidenceReview(evidence,finalReview,input);
        if(!matchesReviewedProjection(input,expectedInputs.review.compiled,analysis,finalReview))fail("reviewed_material_drift");
        if(offline.length){
          const receipt=(name:string)=>offline.find(r=>r.run_id===stage(name).run_id);
          if(["diagnosis","selection","material","review"].some(n=>!receipt(n))||receipt("diagnosis")?.context_id===receipt("selection")?.context_id||receipt("material")?.context_id===receipt("review")?.context_id||new Set(offline.filter(r=>stages.some(s=>s.run_id===r.run_id)).map(r=>r.artifact_hash)).size!==1)fail("offline_independence");
        }
      }
      const review = materialReviewSchema.parse(JSON.parse(material.review_json));
      if (!review.approved || review.rows.length !== analysis.learningMaterials.length || analysis.learningMaterials.some((_, i) => review.rows.filter((r) => r.index === i && r.approved).length !== 1)) fail("review_coverage");
      const runs = (await client.execute({ sql: "SELECT run_id,role,provider,status,prompt_version,input_hash FROM ai_runs WHERE run_id IN (?,?)", args: [material.generator_run_id, material.reviewer_run_id] })).rows;
      const generator = runs.find((r) => r.run_id === material.generator_run_id);
      const reviewer = runs.find((r) => r.run_id === material.reviewer_run_id);
      const offlineGenerator=offline.find(r=>r.run_id===material.generator_run_id),offlineReviewer=offline.find(r=>r.run_id===material.reviewer_run_id);
      if(offlineGenerator||offlineReviewer){
        if(!offlineGenerator||!offlineReviewer||offlineGenerator.stage!=="material"||offlineReviewer.stage!=="review"||offlineGenerator.context_id===offlineReviewer.context_id||offlineGenerator.run_id===offlineReviewer.run_id)fail("independent_review_evidence");
      }else if (runs.length !== 2 || generator?.status !== "completed" || reviewer?.status !== "completed" || reviewer?.role !== "reviewer" || generator.prompt_version === reviewer.prompt_version || !generator.input_hash || !reviewer.input_hash) fail("independent_review_evidence");
      if (!allowMock && runs.some((r) => r.provider === "mock")) fail("mock_is_not_real_review");
      const links = (await client.execute({ sql: "SELECT mi.row_index,i.id FROM practice_material_items mi LEFT JOIN learning_items i ON i.id=mi.learning_item_id WHERE mi.material_id=?", args: [material.id] })).rows;
      if (links.length !== analysis.learningMaterials.length || links.some((r) => !r.id) || analysis.learningMaterials.some((_, i) => !links.some((r) => r.row_index === i))) fail("learning_item_links");
      if(input.offlineRevision){
        const artifact=JSON.parse(material.review_json).offlineRevision;
        if(!artifact)throw new Error('offline_revision_evidence');
        const compiled=compileOfflineMaterial(artifact.source,artifact.author,artifact.review,{selectionPolicyVersion:input.selectionPolicyVersion}),basis=compiled.author.revisionBasis;
        const revision=input.offlineRevision;
        if(!basis||basis.materialId!==revision.parentMaterialId||basis.inputHash!==revision.parentInputHash||basis.analysisHash!==revision.parentAnalysisHash||basis.sourceHash!==revision.sourceHash||materialSourceHash(input)!==revision.sourceHash||hash(authorHash(compiled.author),JSON.stringify(compiled.review))!==revision.artifactHash||JSON.stringify(compiled.analysis)!==JSON.stringify(analysis))fail('offline_revision_evidence');
        const old=(await client.execute({sql:'SELECT * FROM practice_materials WHERE id=?',args:[revision.parentMaterialId]})).rows[0];
        if(!old||old.input_hash!==revision.parentInputHash||hash(String(old.analysis_json))!==revision.parentAnalysisHash||materialSourceHash(JSON.parse(String(old.input_json)))!==revision.sourceHash)fail('offline_revision_parent');
        const oldItems=(await client.execute({sql:'SELECT mi.row_index,i.id,i.target_english,i.intention_zh FROM practice_material_items mi JOIN learning_items i ON i.id=mi.learning_item_id WHERE mi.material_id=?',args:[revision.parentMaterialId]})).rows;
        for(const [unitIndex,unit] of compiled.author.units.entries())for(const [gapIndex,gap] of unit.gaps.entries())if(gap.priorLearningItem){
          const gapId=`g${unitIndex}_${gapIndex}`,rowIndex=analysis.learningMaterials.findIndex(row=>row.gapId===gapId);
          if(rowIndex<0)continue;
          const prior=gap.priorLearningItem,original=oldItems.find(item=>item.row_index===prior.rowIndex),verdict=compiled.review.continuity?.find(item=>item.gapId===gapId);
          if(!original||original.id!==prior.learningItemId||original.target_english!==prior.targetEnglish||original.intention_zh!==prior.intentionZh||!links.some(link=>link.row_index===rowIndex&&link.id===original.id)||normalizeExpression(prior.targetEnglish)!==normalizeExpression(analysis.learningMaterials[rowIndex].englishChunk)||!verdict?.sameTarget||!verdict.sameIntention||verdict.learningItemId!==original.id)fail('offline_revision_identity');
        }
      }
      if (material.source_type === "ielts_practice") {
        const original = (await client.execute({ sql: "SELECT question_id,answer_text,intended_meaning_zh FROM speaking_question_attempts WHERE id=?", args: [material.source_id] })).rows[0];
        if (!original || original.question_id !== material.question_id || original.answer_text !== input.actualAnswer || original.intended_meaning_zh !== input.intendedMeaningZh) fail("answer_source_mismatch");
      } else if (material.source_type === "free_talk") {
        const messages = (await client.execute({ sql: "WITH RECURSIVE origins(id) AS (SELECT ? UNION SELECT b.conversation_id FROM device_sync_chat_branches b JOIN origins o ON b.parent_id=o.id) SELECT id,role,text FROM free_talk_messages WHERE conversation_id IN(SELECT id FROM origins) ORDER BY sequence_no", args: [material.source_id] })).rows;
        if (!input.sourceMessages?.some((m) => m.role === "user") || input.sourceMessages.some((m) => !messages.some((original) => original.id === m.id && original.role === m.role && original.text === m.text)) || input.sourceMessages.filter((m) => m.role === "user").map((m) => m.text).join("\n") !== input.actualAnswer || material.question_id !== null) fail("conversation_source_mismatch");
      } else fail("unknown_source");
    } catch { fail("material_contract_invalid"); }
  }
  return { ok: issues.length === 0, checked, pending: rows.filter((r) => r.status !== "ready").length, availability: checked ? "published_material_present" : "no_ready_materials", issues };
}
