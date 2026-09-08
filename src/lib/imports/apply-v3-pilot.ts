import type { Client, Transaction } from "@libsql/client";
import { normalizeForMatch, splitAnswerSentences, stableId as personalStableId } from "./personal-import";
import {
  V3_PILOT_EXPERIMENT,
  type V3PilotMaterial,
  type V3PilotInput,
  v3PilotHash,
  v3PilotId,
} from "./v3-pilot-material";

type Executor = Pick<Client, "execute"> | Pick<Transaction, "execute">;
type ReviewMeta = {
  generationSha256: string;
  materialReviewSha256: string;
  scenarioReviewSha256: string;
  generatorRunId: string;
  materialReviewerRunId: string;
  scenarioReviewerRunId: string;
};

const normalizeWord = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[’]/g, "'");
const words = (value: string) => [...value.matchAll(/[A-Za-z]+(?:['’][A-Za-z]+)?/g)];

async function annotate(
  db: Executor,
  input: { contentType: string; contentId: string; text: string; material: V3PilotMaterial; chunkId?: string; phrase?: string },
) {
  await db.execute({ sql: "DELETE FROM text_annotations WHERE content_type=? AND content_id=?", args: [input.contentType, input.contentId] });
  const glossary = new Map(input.material.glossary.map((entry) => [normalizeWord(entry.surface), entry]));
  const phraseStart = input.phrase ? input.text.toLowerCase().indexOf(input.phrase.toLowerCase()) : -1;
  const phraseEnd = phraseStart >= 0 ? phraseStart + input.phrase!.length : -1;

  if (phraseStart >= 0 && phraseEnd > phraseStart && words(input.phrase!).length > 1) {
    await db.execute({
      sql: "INSERT INTO text_annotations (id,content_type,content_id,start_offset,end_offset,surface,lexeme_id,chunk_id,meaning_zh,ipa,accent) VALUES (?,?,?,?,?,?,NULL,?,?,?,'en-US')",
      args: [v3PilotId("annotation", input.contentType, input.contentId, String(phraseStart), String(phraseEnd)), input.contentType, input.contentId, phraseStart, phraseEnd, input.text.slice(phraseStart, phraseEnd), input.chunkId ?? null, input.material.meaningZh, input.material.ipa],
    });
  }

  for (const match of words(input.text)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const entry = glossary.get(normalizeWord(match[0]));
    if (!entry) throw new Error("发布前英文注解覆盖检查失败");
    const lexemeId = v3PilotId("lexeme", normalizeWord(entry.surface), "en-US");
    await db.execute({
      sql: "INSERT INTO lexemes (id,surface,normalized,lemma,meaning_zh,ipa,accent,source,status) VALUES (?,?,?,?,?,?,'en-US','offline_v3_pilot','verified') ON CONFLICT(normalized,accent) DO NOTHING",
      args: [lexemeId, entry.surface, normalizeWord(entry.surface), normalizeWord(entry.surface), entry.meaningZh, entry.ipa],
    });
    const stored = await db.execute({ sql: "SELECT id FROM lexemes WHERE normalized=? AND accent='en-US' LIMIT 1", args: [normalizeWord(entry.surface)] });
    const resolvedLexemeId = String(stored.rows[0]?.id ?? lexemeId);
    const isSingleWordPhrase = phraseStart === start && phraseEnd === end;
    await db.execute({
      sql: "INSERT INTO text_annotations (id,content_type,content_id,start_offset,end_offset,surface,lexeme_id,chunk_id,meaning_zh,ipa,accent) VALUES (?,?,?,?,?,?,?,?,?,?,'en-US')",
      args: [v3PilotId("annotation", input.contentType, input.contentId, String(start), String(end)), input.contentType, input.contentId, start, end, match[0], resolvedLexemeId, isSingleWordPhrase ? input.chunkId ?? null : null, isSingleWordPhrase ? input.material.meaningZh : entry.meaningZh, isSingleWordPhrase ? input.material.ipa : entry.ipa],
    });
  }
}

async function ensureChunk(db: Executor, material: V3PilotMaterial, review: ReviewMeta) {
  const canonical = normalizeForMatch(material.canonicalChunk);
  const publicMatch = await db.execute({
    sql: "SELECT id FROM chunks WHERE canonical_chunk=? AND book_id!='book_personal_ielts_answers' AND quality_status IN ('approved','edited') AND review_provenance='independent_reviewer' ORDER BY id LIMIT 1",
    args: [canonical],
  });
  if (publicMatch.rows[0]) return { chunkId: String(publicMatch.rows[0].id), origin: "public" as const };

  const personalMatch = await db.execute({ sql: "SELECT id FROM chunks WHERE canonical_chunk=? AND book_id='book_personal_ielts_answers' LIMIT 1", args: [canonical] });
  const chunkId = personalMatch.rows[0] ? String(personalMatch.rows[0].id) : v3PilotId("c_personal", canonical);
  const reviewerVersion = `v3_pilot_material.reviewer.v1|development-agent|${review.materialReviewerRunId}`;
  await db.execute({
    sql: `INSERT INTO chunks (id,book_id,canonical_chunk,display_chunk,unit_type,meaning_zh,english_gloss,pattern,difficulty,tags_json,content_version,quality_status,review_provenance,reviewer_version,reviewed_at)
      VALUES (?,'book_personal_ielts_answers',?,?,?,?,?,?, 'intermediate',?,'personal-v3-pilot','approved','independent_reviewer',?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(id) DO UPDATE SET display_chunk=excluded.display_chunk,unit_type=excluded.unit_type,meaning_zh=excluded.meaning_zh,english_gloss=excluded.english_gloss,pattern=excluded.pattern,tags_json=excluded.tags_json,content_version=excluded.content_version,quality_status='approved',review_provenance='independent_reviewer',reviewer_version=excluded.reviewer_version,reviewed_at=excluded.reviewed_at,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    args: [chunkId, canonical, material.displayChunk, material.unitType, material.meaningZh, material.englishGloss, material.pattern, JSON.stringify(["personal_gap", "gap_retrieval_v3"]), reviewerVersion],
  });
  await db.execute({
    sql: "INSERT INTO chunk_pronunciations (id,chunk_id,ipa,accent,audio_url,source,is_primary) VALUES (?, ?, ?, 'en-US', NULL, 'offline_agent_verified', 1) ON CONFLICT(chunk_id,accent,source) DO UPDATE SET ipa=excluded.ipa,is_primary=1",
    args: [v3PilotId("pron", chunkId, "en-US", "v3"), chunkId, material.ipa],
  });
  return { chunkId, origin: "personal" as const };
}

async function applyScenario(db: Executor, material: V3PilotMaterial, chunkId: string, kind: "common_usage" | "question_repair", reviewerRunId: string) {
  const scenario = kind === "common_usage" ? material.commonUsage : material.questionRepair;
  const scenarioId = v3PilotId("scenario", chunkId, material.questionId, material.gapId, kind);
  await db.execute({
    sql: `INSERT INTO learning_scenarios (id,chunk_id,question_id,gap_id,scenario_kind,setting_zh,relationship_zh,purpose_zh,register,accent,is_generated,review_decision,review_reason,reviewer_run_id)
      VALUES (?,?,?,?,?,?,?,?,?,'en-US',1,'approved',?,?)
      ON CONFLICT(id) DO UPDATE SET setting_zh=excluded.setting_zh,relationship_zh=excluded.relationship_zh,purpose_zh=excluded.purpose_zh,register=excluded.register,accent='en-US',review_decision='approved',review_reason=excluded.review_reason,reviewer_run_id=excluded.reviewer_run_id,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    args: [scenarioId, chunkId, material.questionId, material.gapId, kind, scenario.settingZh, scenario.relationshipZh, scenario.purposeZh, scenario.register, `V3 独立语境审核：${kind}`, reviewerRunId],
  });
  const retained: string[] = [];
  for (const [index, line] of scenario.lines.entries()) {
    const lineId = v3PilotId("scenario_line", scenarioId, String(index));
    retained.push(lineId);
    await db.execute({
      sql: "INSERT INTO learning_scenario_lines (id,scenario_id,line_order,speaker,text_en,text_zh,is_target,annotation_status) VALUES (?,?,?,?,?,?,?,'pending') ON CONFLICT(id) DO UPDATE SET line_order=excluded.line_order,speaker=excluded.speaker,text_en=excluded.text_en,text_zh=excluded.text_zh,is_target=excluded.is_target,annotation_status='pending'",
      args: [lineId, scenarioId, index, line.speaker, line.en, line.zh, line.target ? 1 : 0],
    });
    await annotate(db, { contentType: "scenario_line", contentId: lineId, text: line.en, material, chunkId, phrase: line.target ? scenario.targetSurface : undefined });
    await db.execute({ sql: "UPDATE learning_scenario_lines SET annotation_status='complete' WHERE id=?", args: [lineId] });
  }
  const old = await db.execute({ sql: "SELECT id FROM learning_scenario_lines WHERE scenario_id=?", args: [scenarioId] });
  for (const row of old.rows) {
    if (!retained.includes(String(row.id))) {
      await db.execute({ sql: "DELETE FROM text_annotations WHERE content_type='scenario_line' AND content_id=?", args: [String(row.id)] });
      await db.execute({ sql: "DELETE FROM learning_scenario_lines WHERE id=?", args: [String(row.id)] });
    }
  }
  return scenarioId;
}

export async function verifyV3PilotSelection(db: Executor, input: V3PilotInput) {
  const batch = await db.execute({ sql: "SELECT review_sha256 FROM personal_diagnosis_batches WHERE id=?", args: [input.sourceBatchId] });
  if (String(batch.rows[0]?.review_sha256 ?? "") !== input.sourceReviewSha256) throw new Error("诊断审核批次证据已漂移");
  for (const selected of input.selected) {
    const rows = await db.execute({
      sql: `SELECT g.answer_id,g.answer_version_id,gap_type,g.cluster_id,evidence_text,intent_zh,recommended_expression,explanation_zh,impact_level,reviewer_run_id,a.question_id
        FROM answer_gaps g JOIN personal_answers a ON a.id=g.answer_id JOIN personal_gap_evidence e ON e.gap_id=g.id
        WHERE g.id=? AND e.batch_id=? AND g.learning_fit=1 AND g.reviewer_decision IN ('approved','edited') AND g.status IN ('open','learning') AND a.superseded_by_revision_id IS NULL`,
      args: [selected.gapId, input.sourceBatchId],
    });
    const row = rows.rows[0];
    if (!row) throw new Error("选中的 Gap 已失效或不再适合学习");
    const actual = {
      answerId: String(row.answer_id), answerVersionId: String(row.answer_version_id), questionId: String(row.question_id),
      gapType: String(row.gap_type), clusterId: String(row.cluster_id), evidenceSha256: v3PilotHash(String(row.evidence_text)),
      intentZh: String(row.intent_zh), recommendedExpression: String(row.recommended_expression), explanationZh: String(row.explanation_zh),
      impactLevel: String(row.impact_level), diagnosisReviewerRunId: String(row.reviewer_run_id),
    };
    const expected = { ...selected }; delete (expected as Partial<typeof expected>).gapId;
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("选中的 Gap 快照与数据库不一致");
  }
}

export async function applyV3PilotMaterials(client: Client, input: V3PilotInput, materials: V3PilotMaterial[], review: ReviewMeta) {
  const transaction = await client.transaction("write");
  const published: Array<{ gapId: string; chunkId: string; questionId: string }> = [];
  try {
    for (const material of materials) {
      const selected = input.selected.find((item) => item.gapId === material.gapId)!;
      const { chunkId, origin } = await ensureChunk(transaction, material, review);
      const evidence = await transaction.execute({ sql: "SELECT evidence_text FROM answer_gaps WHERE id=?", args: [material.gapId] });
      const evidenceText = String(evidence.rows[0]?.evidence_text ?? "");
      let sentenceRows = await transaction.execute({ sql: "SELECT id,text_en FROM personal_answer_sentences WHERE answer_id=? AND answer_version_id=? ORDER BY sentence_index", args: [material.answerId, selected.answerVersionId] });
      if (!sentenceRows.rows.length) {
        const version = await transaction.execute({ sql: "SELECT text_en FROM answer_versions WHERE id=? AND answer_id=?", args: [selected.answerVersionId, material.answerId] });
        const sentences = splitAnswerSentences(String(version.rows[0]?.text_en ?? ""));
        if (!sentences.length) throw new Error("个人回答缺少可追溯的英文版本");
        for (const [index, textEn] of sentences.entries()) {
          await transaction.execute({
            sql: "INSERT OR IGNORE INTO personal_answer_sentences (id,answer_id,answer_version_id,question_id,sentence_index,text_en,text_zh) VALUES (?,?,?,?,?,?,'')",
            args: [personalStableId("pas", selected.answerVersionId, index), material.answerId, selected.answerVersionId, material.questionId, index, textEn],
          });
        }
        sentenceRows = await transaction.execute({ sql: "SELECT id,text_en FROM personal_answer_sentences WHERE answer_id=? AND answer_version_id=? ORDER BY sentence_index", args: [material.answerId, selected.answerVersionId] });
      }
      const normalizedEvidence = normalizeForMatch(evidenceText);
      const sentence = sentenceRows.rows.find((row) => {
        const normalizedSentence = normalizeForMatch(String(row.text_en));
        return normalizedSentence.includes(normalizedEvidence) || normalizedEvidence.includes(normalizedSentence);
      });
      if (!sentence) throw new Error("个人回答缺少可追溯句子");
      const sentenceId = String(sentence.id);

      await transaction.execute({
        sql: "INSERT INTO personal_chunk_links (answer_id,sentence_id,chunk_id,origin,status,generator_run_id,reviewer_run_id) VALUES (?,?,?,?,'active',?,?) ON CONFLICT(answer_id,sentence_id,chunk_id) DO UPDATE SET origin=excluded.origin,status='active',generator_run_id=excluded.generator_run_id,reviewer_run_id=excluded.reviewer_run_id",
        args: [material.answerId, sentenceId, chunkId, origin, review.generatorRunId, review.materialReviewerRunId],
      });
      await transaction.execute({
        sql: "INSERT OR IGNORE INTO personal_content_reviews (id,answer_id,sentence_id,canonical_chunk,candidate_json,verdict,reason,generator_run_id,reviewer_run_id) VALUES (?,?,?,?,?,'approved',?,?,?)",
        args: [v3PilotId("personal_review", material.gapId, review.materialReviewSha256), material.answerId, sentenceId, normalizeForMatch(material.canonicalChunk), JSON.stringify({ schemaVersion: "v3-pilot-material-v1", gapId: material.gapId, generationSha256: review.generationSha256, materialReviewSha256: review.materialReviewSha256, scenarioReviewSha256: review.scenarioReviewSha256 }), "通过独立材料与语境审核，并完成确定性注解覆盖审计。", review.generatorRunId, review.materialReviewerRunId],
      });
      await transaction.execute({ sql: "INSERT OR IGNORE INTO chunk_question_links (chunk_id,question_id,relation,answer_dimension_id) VALUES (?,?,'personal_gap','')", args: [chunkId, material.questionId] });
      const topic = await transaction.execute({ sql: "SELECT topic_id FROM questions WHERE id=?", args: [material.questionId] });
      if (topic.rows[0]?.topic_id) await transaction.execute({ sql: "INSERT OR IGNORE INTO chunk_topic_links (chunk_id,topic_id,relation,is_primary) VALUES (?,?,'personal_gap',1)", args: [chunkId, String(topic.rows[0].topic_id)] });
      await transaction.execute({
        sql: "INSERT INTO chunk_sources (id,chunk_id,source_type,book_id,question_id,sentence_id,source_context) VALUES (?,?,'personal_answer','book_personal_ielts_answers',?,?,?) ON CONFLICT(id) DO UPDATE SET question_id=excluded.question_id,sentence_id=excluded.sentence_id,source_context=excluded.source_context",
        args: [v3PilotId("source", chunkId, material.answerId), chunkId, material.questionId, sentenceId, `gap:${material.gapId}`],
      });
      const exampleId = v3PilotId("example", chunkId, material.gapId);
      await transaction.execute({
        sql: "INSERT INTO chunk_examples (id,chunk_id,text_en,text_zh,is_source_sentence,source_ref,question_ids_json,source_sentence_id,context_type,generated,sort) VALUES (?,?,?,?,0,?,?,NULL,'generated_ielts',1,0) ON CONFLICT(id) DO UPDATE SET text_en=excluded.text_en,text_zh=excluded.text_zh,source_ref=excluded.source_ref,question_ids_json=excluded.question_ids_json",
        args: [exampleId, chunkId, material.example.en, material.example.zh, `v3-question-repair:${material.questionId}`, JSON.stringify([material.questionId])],
      });
      await annotate(transaction, { contentType: "example", contentId: exampleId, text: material.example.en, material, chunkId, phrase: material.displayChunk });
      await annotate(transaction, { contentType: "chunk", contentId: chunkId, text: material.displayChunk, material, chunkId, phrase: material.displayChunk });
      await annotate(transaction, { contentType: "chunk_gloss", contentId: chunkId, text: material.englishGloss, material });
      await annotate(transaction, { contentType: "chunk_pattern", contentId: chunkId, text: material.pattern, material });

      await transaction.execute({
        sql: "INSERT INTO question_learning_units (id,question_id,gap_id,chunk_id,requirement,priority,source,status) VALUES (?,?,?,?,'required',?,'historical_answer_gap','active') ON CONFLICT(question_id,chunk_id,source) DO UPDATE SET gap_id=excluded.gap_id,requirement='required',priority=excluded.priority,status='active',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')",
        args: [v3PilotId("qlu", material.questionId, material.gapId, chunkId), material.questionId, material.gapId, chunkId, selected.impactLevel === "high" ? 90 : 70],
      });
      await transaction.execute({
        sql: "INSERT INTO learning_inbox_items (id,source_type,source_id,chunk_id,surface,meaning_zh,reason,status) VALUES (?,'answer_gap',?,?,?,?,?,'open') ON CONFLICT(id) DO UPDATE SET chunk_id=excluded.chunk_id,surface=excluded.surface,meaning_zh=excluded.meaning_zh,reason=excluded.reason,status='open',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')",
        args: [v3PilotId("inbox", material.gapId), material.gapId, chunkId, material.displayChunk, material.meaningZh, "历史回答中经独立审核确认的待学表达"],
      });
      await applyScenario(transaction, material, chunkId, "common_usage", review.scenarioReviewerRunId);
      await applyScenario(transaction, material, chunkId, "question_repair", review.scenarioReviewerRunId);
      await transaction.execute({
        sql: "INSERT INTO learning_experiment_assignments (experiment_id,chunk_id,gap_id,question_id,status) VALUES (?,?,?,?, 'active') ON CONFLICT(experiment_id,chunk_id) DO UPDATE SET gap_id=excluded.gap_id,question_id=excluded.question_id,status='active'",
        args: [V3_PILOT_EXPERIMENT, chunkId, material.gapId, material.questionId],
      });
      published.push({ gapId: material.gapId, chunkId, questionId: material.questionId });
    }
    await transaction.commit();
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
  return published;
}

export async function auditV3Pilot(client: Client, expected = 10) {
  const rows = await client.execute({
    sql: `SELECT a.gap_id AS gapId,a.chunk_id AS chunkId,a.question_id AS questionId,c.display_chunk AS displayChunk,c.english_gloss AS englishGloss,c.pattern,
      (SELECT COUNT(*) FROM learning_scenarios s WHERE s.chunk_id=a.chunk_id AND s.gap_id=a.gap_id AND s.question_id=a.question_id AND s.review_decision='approved') AS scenarios,
      (SELECT COUNT(*) FROM learning_scenario_lines l JOIN learning_scenarios s ON s.id=l.scenario_id WHERE s.chunk_id=a.chunk_id AND s.gap_id=a.gap_id AND l.annotation_status='complete') AS lines,
      (SELECT COUNT(*) FROM question_learning_units u WHERE u.chunk_id=a.chunk_id AND u.gap_id=a.gap_id AND u.question_id=a.question_id AND u.status='active') AS units,
      (SELECT COUNT(*) FROM personal_chunk_links p JOIN personal_answers pa ON pa.id=p.answer_id WHERE p.chunk_id=a.chunk_id AND p.status='active' AND pa.superseded_by_revision_id IS NULL) AS links,
      (SELECT COUNT(*) FROM chunk_examples e WHERE e.chunk_id=a.chunk_id AND trim(e.text_zh)!='') AS examples,
      (SELECT COUNT(*) FROM chunk_pronunciations p WHERE p.chunk_id=a.chunk_id AND p.accent='en-US' AND trim(p.ipa)!='') AS pronunciations
      FROM learning_experiment_assignments a JOIN chunks c ON c.id=a.chunk_id
      WHERE a.experiment_id=? AND a.status='active' AND c.quality_status IN ('approved','edited') ORDER BY a.gap_id`,
    args: [V3_PILOT_EXPERIMENT],
  });
  const failures: string[] = [];
  async function hasCoverage(contentType: string, contentId: string, text: string) {
    const spans = await client.execute({ sql: "SELECT start_offset AS startOffset,end_offset AS endOffset FROM text_annotations WHERE content_type=? AND content_id=?", args: [contentType, contentId] });
    return words(text).every((match) => spans.rows.some((span) => Number(span.startOffset) <= (match.index ?? 0) && Number(span.endOffset) >= (match.index ?? 0) + match[0].length));
  }
  for (const row of rows.rows) {
    const gapId = String(row.gapId), chunkId = String(row.chunkId);
    let valid = Number(row.scenarios) === 2 && Number(row.lines) >= 4 && Number(row.lines) <= 8 && Number(row.units) === 1 && Number(row.links) >= 1 && Number(row.examples) >= 1 && Number(row.pronunciations) >= 1;
    const scenes = await client.execute({ sql: "SELECT id,scenario_kind AS kind FROM learning_scenarios WHERE chunk_id=? AND gap_id=? AND question_id=? AND review_decision='approved' ORDER BY scenario_kind", args: [chunkId, gapId, String(row.questionId)] });
    valid &&= new Set(scenes.rows.map((scene) => String(scene.kind))).size === 2 && scenes.rows.some((scene) => scene.kind === "common_usage") && scenes.rows.some((scene) => scene.kind === "question_repair");
    for (const scene of scenes.rows) {
      const lines = await client.execute({ sql: "SELECT id,text_en AS textEn,text_zh AS textZh,is_target AS target,annotation_status AS annotationStatus FROM learning_scenario_lines WHERE scenario_id=? ORDER BY line_order", args: [String(scene.id)] });
      valid &&= lines.rows.length >= 2 && lines.rows.length <= 4 && lines.rows.filter((line) => Number(line.target) === 1).length === 1;
      for (const line of lines.rows) valid &&= String(line.textZh).trim().length > 0 && line.annotationStatus === "complete" && await hasCoverage("scenario_line", String(line.id), String(line.textEn));
    }
    const examples = await client.execute({ sql: "SELECT id,text_en AS textEn,text_zh AS textZh FROM chunk_examples WHERE chunk_id=? ORDER BY sort,id", args: [chunkId] });
    valid &&= examples.rows.length > 0 && String(examples.rows[0]?.textZh ?? "").trim().length > 0 && await hasCoverage("example", String(examples.rows[0]?.id ?? ""), String(examples.rows[0]?.textEn ?? ""));
    valid &&= await hasCoverage("chunk", chunkId, String(row.displayChunk));
    valid &&= await hasCoverage("chunk_gloss", chunkId, String(row.englishGloss));
    valid &&= await hasCoverage("chunk_pattern", chunkId, String(row.pattern));
    if (!valid) failures.push(gapId);
  }
  return { ok: rows.rows.length >= expected && failures.length === 0, activeItems: rows.rows.length, failures };
}
