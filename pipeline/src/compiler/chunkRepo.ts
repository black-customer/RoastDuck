/**
 * Chunk 仓库：插入即合并（dedup-on-write）。
 * 同一 (canonical, book) 只允许一条；再次出现时合并 variants/sources/coverage_refs/examples。
 * 对齐 docs/CONTENT_SPEC.md §3 去重规范与 docs/DATA_MODEL.md。
 */
import { eq, sql } from "drizzle-orm";
import { getDbReady, withDbTransaction } from "../../../db/client";
import {
  chunkCoverageRefs,
  chunkExamples,
  chunkQuestionLinks,
  chunkSources,
  chunkTopicLinks,
  chunks,
  questions,
} from "../../../db/schema";
import { sha1Like } from "../lib/text";

export interface CoverageRef {
  refType: "question_dimension" | "topic_domain";
  questionId?: string | null;
  dimId?: string | null;
  topicId?: string | null;
  domainId?: string | null;
}

export interface ChunkSource {
  sourceType: "question_bank" | "demo_answer" | "podcast";
  questionId?: string | null;
  sentenceId?: string | null;
  context?: string;
}

export interface NewChunkInput {
  bookId: string;
  displayChunk: string;
  canonicalChunk: string;
  unitType: string;
  meaningZh: string;
  englishGloss: string;
  pattern?: string | null;
  variants: string[];
  exampleEn: string;
  exampleZh: string;
  difficulty: string;
  tags: string[];
  contentVersion: string;
  source: ChunkSource;
  coverageRefs: CoverageRef[];
}

export function chunkIdFor(canonical: string, bookId: string): string {
  return `c_${sha1Like(`${bookId}|${canonical}`)}`;
}

function refId(chunkId: string, r: CoverageRef): string {
  return `cr_${sha1Like(`${chunkId}|${r.refType}|${r.questionId ?? ""}|${r.dimId ?? ""}|${r.topicId ?? ""}|${r.domainId ?? ""}`)}`;
}

function srcId(chunkId: string, s: ChunkSource): string {
  return `cs_${sha1Like(`${chunkId}|${s.sourceType}|${s.questionId ?? ""}|${s.sentenceId ?? ""}`)}`;
}

export async function insertOrMergeChunk(input: NewChunkInput): Promise<{ chunkId: string; created: boolean }> {
  const db = await getDbReady();
  const chunkId = chunkIdFor(input.canonicalChunk, input.bookId);

  const existing = await db.select().from(chunks).where(eq(chunks.id, chunkId)).limit(1);

  if (existing.length === 0) {
    await db
      .insert(chunks)
      .values({
        id: chunkId,
        bookId: input.bookId,
        canonicalChunk: input.canonicalChunk,
        displayChunk: input.displayChunk,
        unitType: input.unitType,
        meaningZh: input.meaningZh,
        englishGloss: input.englishGloss,
        pattern: input.pattern ?? null,
        variantsJson: JSON.stringify(input.variants),
        difficulty: input.difficulty,
        tagsJson: JSON.stringify(input.tags),
        contentVersion: input.contentVersion,
        qualityStatus: "pending_review",
      })
      .onConflictDoNothing();
  } else {
    // 合并 variants / tags / pattern
    const row = existing[0];
    const variants = new Set(JSON.parse(row.variantsJson) as string[]);
    for (const v of input.variants) variants.add(v);
    variants.add(input.displayChunk);
    const tags = new Set(JSON.parse(row.tagsJson) as string[]);
    for (const t of input.tags) tags.add(t);
    await db
      .update(chunks)
      .set({
        variantsJson: JSON.stringify([...variants].slice(0, 12)),
        tagsJson: JSON.stringify([...tags].slice(0, 10)),
        pattern: row.pattern ?? input.pattern ?? null,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(chunks.id, chunkId));
  }

  // 覆盖引用
  for (const r of input.coverageRefs) {
    await db
      .insert(chunkCoverageRefs)
      .values({
        id: refId(chunkId, r),
        chunkId,
        refType: r.refType,
        questionId: r.questionId ?? null,
        dimId: r.dimId ?? null,
        topicId: r.topicId ?? null,
        domainId: r.domainId ?? null,
      })
      .onConflictDoNothing();

    if (r.questionId) {
      await db
        .insert(chunkQuestionLinks)
        .values({
          chunkId,
          questionId: r.questionId,
          relation: "coverage",
          answerDimensionId: r.dimId ?? "",
        })
        .onConflictDoNothing();
      const [question] = await db.select({ topicId: questions.topicId }).from(questions).where(eq(questions.id, r.questionId)).limit(1);
      if (question?.topicId) {
        await db
          .insert(chunkTopicLinks)
          .values({ chunkId, topicId: question.topicId, relation: "coverage" })
          .onConflictDoNothing();
      }
    }
    if (r.topicId) {
      await db
        .insert(chunkTopicLinks)
        .values({ chunkId, topicId: r.topicId, relation: "coverage" })
        .onConflictDoNothing();
    }
  }

  // 来源
  await db
    .insert(chunkSources)
    .values({
      id: srcId(chunkId, input.source),
      chunkId,
      sourceType: input.source.sourceType,
      bookId: input.bookId,
      questionId: input.source.questionId ?? null,
      sentenceId: input.source.sentenceId ?? null,
      sourceContext: input.source.context ?? "",
    })
    .onConflictDoNothing();

  if (input.source.questionId) {
    await db
      .insert(chunkQuestionLinks)
      .values({ chunkId, questionId: input.source.questionId, relation: "source", answerDimensionId: "" })
      .onConflictDoNothing();
    const [question] = await db.select({ topicId: questions.topicId }).from(questions).where(eq(questions.id, input.source.questionId)).limit(1);
    if (question?.topicId) {
      await db
        .insert(chunkTopicLinks)
        .values({ chunkId, topicId: question.topicId, relation: "source" })
        .onConflictDoNothing();
    }
  }

  // 例句
  if (input.exampleEn) {
    const exId = `ce_${sha1Like(`${chunkId}|${input.exampleEn}`)}`;
    await db
      .insert(chunkExamples)
      .values({
        id: exId,
        chunkId,
        textEn: input.exampleEn,
        textZh: input.exampleZh,
        isSourceSentence: input.source.sourceType === "demo_answer" || input.source.sourceType === "podcast" ? 1 : 0,
        sourceRef: input.source.context ?? "",
        questionIdsJson: input.source.questionId ? JSON.stringify([input.source.questionId]) : "[]",
        sourceSentenceId: input.source.sentenceId ?? null,
        contextType:
          input.source.sourceType === "demo_answer" || input.source.sourceType === "podcast"
            ? "source_neighbors"
            : "generated_ielts",
        generated: input.source.sourceType === "question_bank" ? 1 : 0,
      })
      .onConflictDoNothing();
  }

  const created = existing.length === 0;
  return { chunkId, created };
}

/** 合并两条 chunk（dedup 裁决 merge 时调用）：keep 保留，drop 的信息并入 keep 后删除。 */
export async function mergeChunks(keepId: string, dropId: string): Promise<boolean> {
  return withDbTransaction(() => mergeUnreferencedChunks(keepId, dropId));
}

async function mergeUnreferencedChunks(keepId: string, dropId: string): Promise<boolean> {
  const db = await getDbReady();
  if (keepId === dropId) return false;
  const [keep] = await db.select().from(chunks).where(eq(chunks.id, keepId)).limit(1);
  const [drop] = await db.select().from(chunks).where(eq(chunks.id, dropId)).limit(1);
  if (!keep || !drop || keep.bookId !== drop.bookId) return false;
  const [book] = await db.all<{ source_type: string }>(sql`SELECT source_type FROM books WHERE id = ${keep.bookId}`);
  if (!book || book.source_type === 'personal_answers') return false;
  // 发布后 ID 是稳定契约；有个人、学习或审核引用时保留两条，等待显式迁移。
  if ([keep, drop].some((row) => row.qualityStatus !== 'pending_review')) return false;
  for (const table of ['learning_progress', 'review_log', 'personal_chunk_links', 'question_learning_units', 'learning_scenarios', 'difficult_notes', 'learning_inbox_items', 'content_amendments', 'text_annotations']) {
    const references = await db.all(sql`SELECT 1 FROM ${sql.identifier(table)} WHERE chunk_id IN (${keepId}, ${dropId}) LIMIT 1`);
    if (references.length) return false;
  }

  const variants = new Set([...JSON.parse(keep.variantsJson), ...JSON.parse(drop.variantsJson), drop.displayChunk]);
  const tags = new Set([...JSON.parse(keep.tagsJson), ...JSON.parse(drop.tagsJson)]);
  await db
    .update(chunks)
    .set({
      variantsJson: JSON.stringify([...variants].slice(0, 12)),
      tagsJson: JSON.stringify([...tags].slice(0, 10)),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(chunks.id, keepId));

  // 迁移来源/引用/例句
  await db.update(chunkSources).set({ chunkId: keepId }).where(eq(chunkSources.chunkId, dropId));
  await db.update(chunkCoverageRefs).set({ chunkId: keepId }).where(eq(chunkCoverageRefs.chunkId, dropId));
  await db.update(chunkExamples).set({ chunkId: keepId }).where(eq(chunkExamples.chunkId, dropId));
  const droppedQuestionLinks = await db.select().from(chunkQuestionLinks).where(eq(chunkQuestionLinks.chunkId, dropId));
  for (const link of droppedQuestionLinks) {
    await db.insert(chunkQuestionLinks).values({ ...link, chunkId: keepId }).onConflictDoNothing();
  }
  await db.delete(chunkQuestionLinks).where(eq(chunkQuestionLinks.chunkId, dropId));
  const droppedTopicLinks = await db.select().from(chunkTopicLinks).where(eq(chunkTopicLinks.chunkId, dropId));
  for (const link of droppedTopicLinks) {
    await db.insert(chunkTopicLinks).values({ ...link, chunkId: keepId }).onConflictDoNothing();
  }
  await db.delete(chunkTopicLinks).where(eq(chunkTopicLinks.chunkId, dropId));
  await db.delete(chunks).where(eq(chunks.id, dropId));
  await db.run(sql`UPDATE OR IGNORE chunk_pronunciations SET chunk_id = ${keepId} WHERE chunk_id = ${dropId}`);
  await db.run(sql`DELETE FROM chunk_pronunciations WHERE chunk_id = ${dropId}`);
  return true;
}
