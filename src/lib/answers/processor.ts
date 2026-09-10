import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getDbReady, withDbTransaction } from "@db/client";
import { amendChunk } from '@/lib/content/amendments';
import {
  aiJobs,
  answerVersions,
  chunkExamples,
  chunkPronunciations,
  chunkQuestionLinks,
  chunkSources,
  chunkTopicLinks,
  chunks,
  lexemes,
  personalAnswers,
  personalAnswerSentences,
  personalChunkLinks,
  personalContentReviews,
  questionAttempts,
  questions,
  textAnnotations,
} from "@db/schema";
import { createAiProvider } from "@/lib/ai/provider-factory";
import { enqueueAiJob, runReviewedAiJob, runSingleAiJob } from "@/lib/ai/job-service";
import { normalizeAiError } from "@/lib/ai/errors";
import { AnswerServiceError, getPersonalAnswer } from "./service";
import {
  answerTransformOutputSchema,
  personalChunkGenerationSchema,
  personalChunkReviewSchema,
  type AnswerTransformOutput,
  type PersonalChunkCandidate,
  type PersonalChunkReview,
} from "./ai-schemas";
import { runtimeAnswerMockResolver } from "./runtime-mock";

const PERSONAL_BOOK_ID = "book_personal_ielts_answers";

function stableId(prefix: string, ...parts: string[]) {
  return `${prefix}_${createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 24)}`;
}

function canonicalize(value: string) {
  return value.normalize("NFKC").toLowerCase().replace(/[“”‘’]/g, "'").replace(/[^a-z0-9'\s-]/g, " ").replace(/\s+/g, " ").trim();
}

function readPrompt(filename: string) {
  return fs.readFileSync(path.join(process.env.ROASTDUCK_PROMPT_ROOT||path.join(process.cwd(), "pipeline", "prompts"), filename), "utf8");
}

async function latestVersionNo(answerId: string) {
  const db = await getDbReady();
  const [{ latest }] = await db.select({ latest: sql<number>`COALESCE(MAX(${answerVersions.versionNo}), 0)` })
    .from(answerVersions).where(eq(answerVersions.answerId, answerId));
  return Number(latest);
}

async function applyAnswerTransform(answerId: string, jobId: string, output: AnswerTransformOutput) {
  const db = await getDbReady();
  const [answer] = await db.select().from(personalAnswers).where(eq(personalAnswers.id, answerId)).limit(1);
  if (!answer) throw new Error("答案不存在");
  const versionId = stableId("answer_version", answerId, jobId, "ai_revised");
  const existing = await db.select({ id: answerVersions.id, versionNo: answerVersions.versionNo }).from(answerVersions).where(eq(answerVersions.id, versionId)).limit(1);
  const versionNo = existing[0]?.versionNo ?? (await latestVersionNo(answerId)) + 1;
  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx.insert(answerVersions).values({
      id: versionId,
      answerId,
      versionNo,
      kind: "ai_revised",
      textEn: output.revisedEnglish,
      textZh: output.translationZh,
      changeSummaryJson: JSON.stringify(output.changes.map((change) => `${change.type}：${change.reasonZh}`)),
      sourceJobId: jobId,
      createdAt: now,
    }).onConflictDoNothing({ target: answerVersions.id });
    for (const [sentenceIndex, sentence] of output.sentences.entries()) {
      await tx.insert(personalAnswerSentences).values({
        id: stableId("personal_sentence", versionId, String(sentenceIndex)),
        answerId,
        answerVersionId: versionId,
        questionId: answer.questionId,
        sentenceIndex,
        textEn: sentence.textEn,
        textZh: sentence.textZh,
        createdAt: now,
      }).onConflictDoNothing({ target: [personalAnswerSentences.answerVersionId, personalAnswerSentences.sentenceIndex] });
    }
    await tx.update(personalAnswers).set({ currentVersionId: versionId, status: "processing", updatedAt: now }).where(eq(personalAnswers.id, answerId));
  });
  return versionId;
}

async function lexemeIdFor(surface: string, meaningZh: string, ipa: string) {
  const db = await getDbReady();
  const normalized = canonicalize(surface);
  const existing = await db.select({ id: lexemes.id }).from(lexemes)
    .where(and(eq(lexemes.normalized, normalized), eq(lexemes.accent, "en-US"))).limit(1);
  if (existing[0]) return existing[0].id;
  const id = stableId("lexeme", normalized, "en-US");
  await db.insert(lexemes).values({
    id,
    surface,
    normalized,
    lemma: normalized,
    meaningZh,
    ipa,
    accent: "en-US",
    source: "personal_answer_ai_reviewed",
    status: "verified",
  }).onConflictDoNothing({ target: [lexemes.normalized, lexemes.accent] });
  const [stored] = await db.select({ id: lexemes.id }).from(lexemes)
    .where(and(eq(lexemes.normalized, normalized), eq(lexemes.accent, "en-US"))).limit(1);
  if (!stored) throw new Error(`个人答案词项写入失败：${surface}`);
  return stored.id;
}

async function annotatePersonalExample(exampleId: string, candidate: PersonalChunkCandidate, chunkId: string) {
  const db = await getDbReady();
  const text = candidate.exampleEn;
  const phraseStart = text.toLowerCase().indexOf(candidate.displayChunk.toLowerCase());
  if (phraseStart < 0) throw new Error(`个人 Chunk 不在完整原句中：${candidate.displayChunk}`);
  const phraseEnd = phraseStart + candidate.displayChunk.length;
  await db.insert(textAnnotations).values({
    id: stableId("annotation", exampleId, String(phraseStart), String(phraseEnd)),
    contentType: "example",
    contentId: exampleId,
    startOffset: phraseStart,
    endOffset: phraseEnd,
    surface: text.slice(phraseStart, phraseEnd),
    chunkId,
    meaningZh: candidate.meaningZh,
    ipa: candidate.ipa,
    accent: "en-US",
  }).onConflictDoNothing();

  const glossary = new Map(candidate.lexemes.map((item) => [canonicalize(item.surface), item]));
  for (const match of text.matchAll(/[A-Za-z]+(?:['’][A-Za-z]+)?/g)) {
    const start = match.index;
    const end = start + match[0].length;
    if (start >= phraseStart && end <= phraseEnd) continue;
    const item = glossary.get(canonicalize(match[0]));
    if (!item) throw new Error(`个人例句英文注解不完整：${match[0]}`);
    const lexemeId = await lexemeIdFor(match[0], item.meaningZh, item.ipa);
    await db.insert(textAnnotations).values({
      id: stableId("annotation", exampleId, String(start), String(end)),
      contentType: "example",
      contentId: exampleId,
      startOffset: start,
      endOffset: end,
      surface: match[0],
      lexemeId,
      meaningZh: item.meaningZh,
      ipa: item.ipa,
      accent: "en-US",
    }).onConflictDoNothing();
  }
}

export async function applyPersonalChunks(
  answerId: string,
  versionId: string,
  generated: { candidates: PersonalChunkCandidate[] },
  review: PersonalChunkReview,
  audit: { generatorRunId: string; reviewerRunId: string },
) {
  const db = await getDbReady();
  const [answer] = await db.select().from(personalAnswers).where(eq(personalAnswers.id, answerId)).limit(1);
  if (!answer) throw new Error("答案不存在");
  const [question] = await db.select({ topicId: questions.topicId, part: questions.part }).from(questions).where(eq(questions.id, answer.questionId)).limit(1);
  if (!question) throw new Error("题目不存在");
  const sentenceRows = await db.select().from(personalAnswerSentences).where(eq(personalAnswerSentences.answerVersionId, versionId));
  const sentenceByIndex = new Map(sentenceRows.map((sentence) => [sentence.sentenceIndex, sentence]));
  const generatedKeys = new Set(generated.candidates.map((item) => `${item.sentenceIndex}|${canonicalize(item.canonicalChunk)}`));
  const now = new Date().toISOString();

  for (const item of review.items) {
    const candidate = item.candidate;
    const canonical = canonicalize(candidate.canonicalChunk);
    const sentence = sentenceByIndex.get(item.sentenceIndex);
    if (!sentence || !generatedKeys.has(`${item.sentenceIndex}|${canonicalize(item.canonicalChunk)}`)) continue;
    await db.insert(personalContentReviews).values({
      id: stableId("personal_review", audit.reviewerRunId, sentence.id, canonical),
      answerId,
      sentenceId: sentence.id,
      canonicalChunk: canonical,
      candidateJson: JSON.stringify(candidate),
      verdict: item.verdict,
      reason: item.reason,
      generatorRunId: audit.generatorRunId,
      reviewerRunId: audit.reviewerRunId,
      createdAt: now,
    }).onConflictDoNothing();
    if (item.verdict === "rejected") continue;
    if (canonicalize(candidate.exampleEn) !== canonicalize(sentence.textEn)) {
      throw new Error(`个人 Chunk 例句必须等于已确认完整句：${candidate.displayChunk}`);
    }

    const [publicChunk] = await db.select({ id: chunks.id, bookId: chunks.bookId }).from(chunks)
      .where(sql`${chunks.canonicalChunk} = ${canonical} AND ${chunks.qualityStatus} IN ('approved','edited') AND ${chunks.bookId} != ${PERSONAL_BOOK_ID}`).limit(1);
    let chunkId = publicChunk?.id;
    const origin = publicChunk ? "public" : "personal";
    if (!chunkId) {
      chunkId = stableId("personal_chunk", canonical);
      await db.insert(chunks).values({
        id: chunkId,
        bookId: PERSONAL_BOOK_ID,
        canonicalChunk: canonical,
        displayChunk: candidate.displayChunk,
        unitType: candidate.unitType,
        meaningZh: candidate.meaningZh,
        englishGloss: candidate.englishGloss,
        pattern: candidate.pattern,
        topicId: question.topicId,
        ieltsPart: question.part,
        difficulty: "personal",
        tagsJson: JSON.stringify(["personal_answer"]),
        contentVersion: "personal-v1",
        qualityStatus: item.verdict === "edited" ? "edited" : "approved",
        reviewProvenance: "independent_reviewer",
        reviewerVersion: "personal-chunk-reviewer-v1",
        reviewedAt: now,
        createdAt: now,
        updatedAt: now,
      }).onConflictDoNothing();
      await db.insert(chunkPronunciations).values({
        id: stableId("pronunciation", chunkId, "en-US"),
        chunkId,
        ipa: candidate.ipa,
        accent: "en-US",
        source: "deepseek-flash-reviewed",
        isPrimary: 1,
      }).onConflictDoNothing();
    }

    const exampleId = stableId("personal_example", answerId, sentence.id, chunkId);
    await db.insert(chunkExamples).values({
      id: exampleId,
      chunkId,
      textEn: sentence.textEn,
      textZh: sentence.textZh,
      isSourceSentence: 0,
      sourceRef: `personal_answer:${answerId}`,
      questionIdsJson: JSON.stringify([answer.questionId]),
      contextType: "personal_answer",
      generated: 0,
      sort: 0,
    }).onConflictDoNothing();
    if (question.topicId) {
      await db.insert(chunkTopicLinks).values({ chunkId, topicId: question.topicId, relation: "personal_answer", isPrimary: origin === "personal" ? 1 : 0 }).onConflictDoNothing();
    }
    await db.insert(chunkQuestionLinks).values({ chunkId, questionId: answer.questionId, relation: "personal_answer", answerDimensionId: "" }).onConflictDoNothing();
    await db.insert(chunkSources).values({
      id: stableId("chunk_source", answerId, sentence.id, chunkId),
      chunkId,
      sourceType: "personal_answer",
      bookId: PERSONAL_BOOK_ID,
      questionId: answer.questionId,
      sourceContext: sentence.textEn,
    }).onConflictDoNothing();
    await annotatePersonalExample(exampleId, candidate, chunkId);
    await db.insert(personalChunkLinks).values({
      answerId,
      sentenceId: sentence.id,
      chunkId,
      origin,
      status: "active",
      generatorRunId: audit.generatorRunId,
      reviewerRunId: audit.reviewerRunId,
      createdAt: now,
    }).onConflictDoNothing();
  }
}

async function activeTransformJob(answerId: string) {
  const db = await getDbReady();
  const rows = await db.select().from(aiJobs)
    .where(and(eq(aiJobs.targetType, "personal_answer"), eq(aiJobs.targetId, answerId), eq(aiJobs.kind, "answer_transform")))
    .orderBy(desc(aiJobs.updatedAt));
  return rows.find((job) => ["queued", "generating", "reviewing", "applying"].includes(job.status)) ?? rows[0] ?? null;
}

export async function processPersonalAnswer(
  answerId: string,
  clientRequestId: string,
  force = false,
  options: { compilePersonalChunks?: boolean } = {},
) {
  const db = await getDbReady();
  const answer = await getPersonalAnswer(answerId);
  if (!answer) throw new Error("答案不存在");
  if (answer.status === "superseded") throw new AnswerServiceError("此回答已由切分修复后的记录取代", 409, "answer_superseded");
  let transformJob = await activeTransformJob(answerId);
  if (force || !transformJob || ["completed", "needs_attention", "retryable_failure", "terminal_failure"].includes(transformJob.status)) {
    transformJob = await enqueueAiJob({
      kind: "answer_transform",
      targetType: "personal_answer",
      targetId: answerId,
      payload: { answerId, requestId: clientRequestId },
      promptVersion: "answer-transform-v1",
      schemaVersion: "answer-transform-v1",
    });
  }
  if (["generating", "reviewing", "applying"].includes(transformJob.status)) return getPersonalAnswer(answerId);
  if (transformJob.status !== "queued") return getPersonalAnswer(answerId);

  await db.update(personalAnswers).set({ status: "processing", updatedAt: new Date().toISOString() }).where(eq(personalAnswers.id, answerId));
  const provider = createAiProvider({ mockResolver: runtimeAnswerMockResolver });
  try {
    const transformed = await runSingleAiJob({
      jobId: transformJob.id,
      provider,
      request: {
        role: "corrector",
        instructions: readPrompt("answer_transform.corrector.v1.md"),
        input: JSON.stringify({ question: answer.question, inputLanguage: answer.inputLanguage, rawText: answer.rawText }),
        schema: answerTransformOutputSchema,
        schemaName: "answer_transform_v1",
        promptVersion: "answer-transform-v1",
        schemaVersion: "answer-transform-v1",
        idempotencyKey: transformJob.idempotencyKey,
      },
      apply: async (output) => { await applyAnswerTransform(answerId, transformJob!.id, output); },
    });
    const versionId = stableId("answer_version", answerId, transformJob.id, "ai_revised");
    if (options.compilePersonalChunks === false) {
      const now = new Date().toISOString();
      await db.update(personalAnswers).set({ status: "ready", updatedAt: now }).where(eq(personalAnswers.id, answerId));
      await db.insert(questionAttempts).values({ id: stableId("attempt", answerId, versionId, "completed"), questionId: answer.questionId, status: "completed", origin: "answer", createdAt: now }).onConflictDoNothing();
      return getPersonalAnswer(answerId);
    }
    const materialJob = await enqueueAiJob({
      kind: "personal_chunk_pipeline",
      targetType: "answer_version",
      targetId: versionId,
      payload: { answerId, versionId, transformRunId: transformed.runId },
      promptVersion: "personal-chunk-generator-v1",
      schemaVersion: "personal-chunk-v1",
    });
    if (materialJob.status === "completed") return getPersonalAnswer(answerId);
    const sentences = await db.select().from(personalAnswerSentences).where(eq(personalAnswerSentences.answerVersionId, versionId)).orderBy(personalAnswerSentences.sentenceIndex);
    const materialInput = { question: answer.question, revisedEnglish: transformed.data.revisedEnglish, sentences: sentences.map((sentence) => ({ index: sentence.sentenceIndex, textEn: sentence.textEn, textZh: sentence.textZh })) };
    await runReviewedAiJob({
      jobId: materialJob.id,
      provider,
      generator: {
        role: "generator",
        instructions: readPrompt("personal_chunk.generator.v1.md"),
        input: JSON.stringify(materialInput),
        schema: personalChunkGenerationSchema,
        schemaName: "personal_chunk_generator_v1",
        promptVersion: "personal-chunk-generator-v1",
        schemaVersion: "personal-chunk-v1",
        idempotencyKey: materialJob.idempotencyKey,
      },
      reviewer: (generated) => ({
        role: "reviewer",
        instructions: readPrompt("personal_chunk.reviewer.v1.md"),
        input: JSON.stringify({ ...materialInput, generatorCandidates: generated.candidates }),
        schema: personalChunkReviewSchema,
        schemaName: "personal_chunk_reviewer_v1",
        promptVersion: "personal-chunk-reviewer-v1",
        schemaVersion: "personal-chunk-review-v1",
        idempotencyKey: `${materialJob.idempotencyKey}_review`,
      }),
      isRejected: () => false,
      apply: async (generated, review, audit) => { await applyPersonalChunks(answerId, versionId, generated, review, audit); },
    });
    const now = new Date().toISOString();
    await db.update(personalAnswers).set({ status: "ready", updatedAt: now }).where(eq(personalAnswers.id, answerId));
    await db.insert(questionAttempts).values({ id: stableId("attempt", answerId, versionId, "completed"), questionId: answer.questionId, status: "completed", origin: "answer", createdAt: now }).onConflictDoNothing();
    return getPersonalAnswer(answerId);
  } catch (reason) {
    const error = normalizeAiError(reason);
    await db.update(personalAnswers).set({ status: error.code === "invalid_output" ? "needs_attention" : "failed", updatedAt: new Date().toISOString() }).where(eq(personalAnswers.id, answerId));
    throw error;
  }
}

export async function listPersonalBook() {
  const db = await getDbReady();
  const items = await db.all<Record<string, unknown>>(sql`
    SELECT pcl.chunk_id AS id, c.display_chunk AS display, c.meaning_zh AS meaningZh,
      c.english_gloss AS englishGloss, c.pattern, pcl.origin,
      COUNT(DISTINCT pcl.answer_id) AS answerCount,
      MAX(pcl.created_at) AS addedAt,
      COALESCE((SELECT cp.ipa FROM chunk_pronunciations cp WHERE cp.chunk_id = c.id ORDER BY cp.is_primary DESC LIMIT 1), '') AS ipa,
      COALESCE((SELECT ce.text_en FROM chunk_examples ce WHERE ce.chunk_id = c.id AND ce.source_ref LIKE 'personal_answer:%' ORDER BY ce.id DESC LIMIT 1), '') AS exampleEn,
      COALESCE((SELECT ce.text_zh FROM chunk_examples ce WHERE ce.chunk_id = c.id AND ce.source_ref LIKE 'personal_answer:%' ORDER BY ce.id DESC LIMIT 1), '') AS exampleZh,
      COALESCE((SELECT ce.id FROM chunk_examples ce WHERE ce.chunk_id = c.id AND ce.source_ref LIKE 'personal_answer:%' ORDER BY ce.id DESC LIMIT 1), '') AS exampleId
    FROM personal_chunk_links pcl JOIN chunks c ON c.id = pcl.chunk_id
    WHERE pcl.status = 'active'
    GROUP BY pcl.chunk_id, c.id ORDER BY addedAt DESC`);
  const reviews = await db.all<{ verdict: string; total: number }>(sql`
    SELECT verdict, COUNT(*) AS total FROM personal_content_reviews GROUP BY verdict`);
  const rejected = await db.all<Record<string, unknown>>(sql`
    SELECT canonical_chunk AS canonicalChunk, reason, created_at AS createdAt
    FROM personal_content_reviews WHERE verdict = 'rejected'
    ORDER BY created_at DESC LIMIT 100`);
  const exampleIds = items.map((item) => String(item.exampleId)).filter(Boolean);
  const annotations = exampleIds.length ? await db.select({
    id: textAnnotations.id,
    contentId: textAnnotations.contentId,
    start: textAnnotations.startOffset,
    end: textAnnotations.endOffset,
    surface: textAnnotations.surface,
  }).from(textAnnotations).where(and(eq(textAnnotations.contentType, "example"), inArray(textAnnotations.contentId, exampleIds))).orderBy(textAnnotations.contentId, textAnnotations.startOffset) : [];
  const annotationMap = new Map<string, Array<{ id: string; start: number; end: number; surface: string }>>();
  for (const annotation of annotations) {
    const list = annotationMap.get(annotation.contentId) ?? [];
    list.push({ id: annotation.id, start: annotation.start, end: annotation.end, surface: annotation.surface });
    annotationMap.set(annotation.contentId, list);
  }
  return {
    id: PERSONAL_BOOK_ID,
    title: "我的雅思答案",
    items: items.map((item) => ({
      id: String(item.id), display: String(item.display), meaningZh: String(item.meaningZh), englishGloss: String(item.englishGloss),
      pattern: String(item.pattern ?? ""), origin: String(item.origin), answerCount: Number(item.answerCount), addedAt: String(item.addedAt),
      ipa: String(item.ipa), exampleEn: String(item.exampleEn), exampleZh: String(item.exampleZh), exampleId: String(item.exampleId),
      interactiveExample: { contentType: "example" as const, contentId: String(item.exampleId), text: String(item.exampleEn), annotations: annotationMap.get(String(item.exampleId)) ?? [] },
    })),
    reviewStats: Object.fromEntries(reviews.map((row) => [row.verdict, Number(row.total)])),
    rejected: rejected.map((row) => ({ canonicalChunk: String(row.canonicalChunk), reason: String(row.reason), createdAt: String(row.createdAt) })),
  };
}

export async function hidePersonalChunk(chunkId: string) {
  return withDbTransaction(async () => {
    const db = await getDbReady();
    await db.run(sql`UPDATE question_learning_units SET status = 'hidden', updated_at = ${new Date().toISOString()}
      WHERE chunk_id = ${chunkId} AND status = 'active' AND (
        EXISTS (SELECT 1 FROM chunks c WHERE c.id = ${chunkId} AND c.book_id = ${PERSONAL_BOOK_ID})
        OR gap_id IN (SELECT g.id FROM answer_gaps g JOIN personal_chunk_links pcl ON pcl.answer_id = g.answer_id WHERE pcl.chunk_id = ${chunkId}))`);
    await db.update(personalChunkLinks).set({ status: "hidden" }).where(eq(personalChunkLinks.chunkId, chunkId));
    return true;
  });
}

export async function updatePersonalChunk(chunkId: string, input: { display: string; meaningZh: string }) {
  const result = await amendChunk({ id: chunkId, action: 'edit', fields: { displayChunk: input.display, meaningZh: input.meaningZh }, personalOnly: true });
  if (!result) return 'not_found' as const;
  if ('publicChunk' in result) return 'public_chunk' as const;
  return "updated" as const;
}

export async function personalChunksForQuestion(questionId: string) {
  const db = await getDbReady();
  return db.all<Record<string, unknown>>(sql`
    SELECT DISTINCT c.id, c.display_chunk AS display, c.meaning_zh AS meaningZh, pcl.origin
    FROM personal_chunk_links pcl
    JOIN personal_answers pa ON pa.id = pcl.answer_id
    JOIN chunks c ON c.id = pcl.chunk_id
    WHERE pa.question_id = ${questionId} AND pa.superseded_by_revision_id IS NULL AND pcl.status = 'active'
    ORDER BY c.display_chunk`);
}
