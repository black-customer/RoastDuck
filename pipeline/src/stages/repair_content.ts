/**
 * 恢复版内容修复：导入 ECDICT 可审计子集、音标与文本注解，并确定性修复上下文标记。
 * 不生成句子翻译、不伪造 Reviewer 结论；未能补齐的项目继续由发布审计阻断。
 */
import fs from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { getDbReady } from "../../../db/client";
import {
  chunkExamples,
  chunkQuestionLinks,
  chunkPronunciations,
  chunkSources,
  chunkTopicLinks,
  chunks,
  lexemes,
  questions,
  textAnnotations,
} from "../../../db/schema";

const ROOT = path.resolve(process.cwd());
const SOURCE_FILE = path.join(ROOT, "pipeline/sources/lexicon_subset.json.gz");
const CONTEXT_OVERRIDES_FILE = path.join(ROOT, "pipeline/sources/context_overrides.json");
const REPORTS = path.join(ROOT, "pipeline/reports");

const lexemeSchema = z.object({
  id: z.string(),
  surface: z.string().min(1),
  normalized: z.string().min(1),
  lemma: z.string().nullable(),
  meaningZh: z.string().min(1),
  ipa: z.string().nullable(),
  accent: z.string().min(2),
  source: z.string().min(1),
  status: z.enum(["verified", "pending", "rejected"]),
  definition: z.string(),
});

const pronunciationSchema = z.object({
  id: z.string(),
  chunkId: z.string(),
  ipa: z.string().min(1),
  accent: z.string(),
  audioUrl: z.string().nullable(),
  source: z.string(),
  isPrimary: z.number().int().min(0).max(1),
});

const annotationSchema = z.object({
  id: z.string(),
  contentType: z.enum(["sentence", "example", "question"]),
  contentId: z.string(),
  startOffset: z.number().int().min(0),
  endOffset: z.number().int().positive(),
  surface: z.string().min(1),
  lexemeId: z.string().nullable(),
  chunkId: z.string().nullable(),
  meaningZh: z.string().min(1),
  ipa: z.string().nullable(),
  accent: z.string(),
});

const payloadSchema = z.object({
  schemaVersion: z.literal(1),
  source: z.object({
    name: z.literal("ECDICT"),
    repository: z.string().url(),
    commit: z.string().regex(/^[0-9a-f]{40}$/),
    inputSha256: z.string().regex(/^[0-9A-F]{64}$/),
    license: z.literal("MIT"),
  }),
  lexemes: z.array(lexemeSchema),
  chunkPronunciations: z.array(pronunciationSchema),
  chunkGlosses: z.array(z.object({ chunkId: z.string(), englishGloss: z.string().min(1) })),
  annotations: z.array(annotationSchema),
});

const contextOverridesSchema = z.object({
  schemaVersion: z.literal(1),
  overrides: z.array(
    z.object({
      exampleId: z.string().min(1),
      chunkId: z.string().min(1),
      questionId: z.string().min(1),
      relation: z.literal("verified_context"),
      reason: z.string().min(4),
      sourceEvidence: z.string().min(4),
    }),
  ),
});

function chunksOf<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

export async function repairContent() {
  if (!fs.existsSync(SOURCE_FILE)) {
    throw new Error(`缺少 ${path.relative(ROOT, SOURCE_FILE)}；先运行 python pipeline/src/build_lexicon.py`);
  }
  const raw = gunzipSync(fs.readFileSync(SOURCE_FILE)).toString("utf-8");
  const payload = payloadSchema.parse(JSON.parse(raw));
  const contextOverrides = contextOverridesSchema.parse(
    JSON.parse(fs.readFileSync(CONTEXT_OVERRIDES_FILE, "utf-8")),
  );
  const db = await getDbReady();

  // 派生内容可安全重建；用户进度、复习日志、会话和笔记不在删除范围内。
  await db.delete(textAnnotations);
  await db.delete(chunkPronunciations);
  await db.delete(lexemes);

  for (const batch of chunksOf(payload.lexemes, 180)) {
    await db.insert(lexemes).values(batch.map((value) => {
      const item = { ...value };
      delete (item as Partial<typeof value>).definition;
      return item;
    }));
  }
  for (const batch of chunksOf(payload.chunkPronunciations, 180)) {
    await db.insert(chunkPronunciations).values(batch);
  }
  for (const batch of chunksOf(payload.annotations, 180)) {
    await db.insert(textAnnotations).values(batch);
  }
  for (const gloss of payload.chunkGlosses) {
    await db
      .update(chunks)
      .set({ englishGloss: gloss.englishGloss, updatedAt: new Date().toISOString() })
      .where(sql`${chunks.id} = ${gloss.chunkId} AND trim(${chunks.englishGloss}) = ''`);
  }

  // 旧数据的 demo_answer 来源漏写 question_id；只从同一真实 source_sentence 回填。
  await db.run(sql`
    UPDATE chunk_sources SET question_id = (
      SELECT s.question_id FROM source_sentences s WHERE s.id = chunk_sources.sentence_id
    )
    WHERE question_id IS NULL AND sentence_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM source_sentences s WHERE s.id = chunk_sources.sentence_id AND s.question_id IS NOT NULL)`);
  await db.run(sql`
    INSERT OR IGNORE INTO chunk_question_links (chunk_id, question_id, relation, answer_dimension_id)
    SELECT chunk_id, question_id, 'source', '' FROM chunk_sources WHERE question_id IS NOT NULL`);
  await db.run(sql`
    INSERT OR IGNORE INTO chunk_topic_links (chunk_id, topic_id, relation, is_primary)
    SELECT DISTINCT l.chunk_id, q.topic_id, l.relation, 0
    FROM chunk_question_links l JOIN questions q ON q.id = l.question_id WHERE q.topic_id IS NOT NULL`);
  // Topic Domain 产出的生成例句没有“来源题目”；为上下文卡关联同 Topic 的代表题，relation 明确为 topic_context。
  await db.run(sql`
    INSERT OR IGNORE INTO chunk_question_links (chunk_id, question_id, relation, answer_dimension_id)
    SELECT l.chunk_id,
      (SELECT q.id FROM questions q WHERE q.topic_id = l.topic_id ORDER BY q.part, q.id LIMIT 1),
      'topic_context', ''
    FROM chunk_topic_links l
    WHERE NOT EXISTS (SELECT 1 FROM chunk_question_links ql WHERE ql.chunk_id = l.chunk_id)
      AND EXISTS (SELECT 1 FROM questions q WHERE q.topic_id = l.topic_id)`);
  await db.run(sql`
    UPDATE chunk_topic_links SET is_primary = CASE WHEN rowid IN (
      SELECT MIN(rowid) FROM chunk_topic_links GROUP BY chunk_id
    ) THEN 1 ELSE 0 END`);

  // 来源句例句只能指向真实 sentence；无法匹配者保留为空并由审计阻断。
  await db.run(sql`
    UPDATE chunk_examples SET source_sentence_id = (
      SELECT s.sentence_id FROM chunk_sources s
      WHERE s.chunk_id = chunk_examples.chunk_id AND s.sentence_id IS NOT NULL
      ORDER BY s.id LIMIT 1
    )
    WHERE is_source_sentence = 1 AND source_sentence_id IS NULL`);
  await db.run(sql`
    UPDATE chunk_examples SET
      context_type = CASE WHEN source_sentence_id IS NOT NULL THEN 'source_neighbors' ELSE 'generated_ielts' END,
      generated = CASE WHEN source_sentence_id IS NOT NULL THEN 0 ELSE 1 END`);

  // 少量无法由稳定 ID 自动恢复的旧关联必须进入版本化 override；应用前逐项验证，禁止模糊猜测。
  for (const override of contextOverrides.overrides) {
    const [example] = await db.select().from(chunkExamples).where(eq(chunkExamples.id, override.exampleId));
    if (!example || example.chunkId !== override.chunkId || example.generated !== 1) {
      throw new Error(`上下文 override ${override.exampleId} 与现有生成例句不匹配`);
    }
    const [question] = await db.select().from(questions).where(eq(questions.id, override.questionId));
    if (!question) throw new Error(`上下文 override 指向不存在的题目 ${override.questionId}`);
    await db
      .insert(chunkQuestionLinks)
      .values({
        chunkId: override.chunkId,
        questionId: override.questionId,
        relation: override.relation,
        answerDimensionId: "",
      })
      .onConflictDoNothing();
    if (question.topicId) {
      await db
        .insert(chunkTopicLinks)
        .values({ chunkId: override.chunkId, topicId: question.topicId, relation: override.relation, isPrimary: 0 })
        .onConflictDoNothing();
    }
    await db
      .update(chunkExamples)
      .set({ questionIdsJson: JSON.stringify([override.questionId]) })
      .where(eq(chunkExamples.id, override.exampleId));
    await db
      .update(chunkSources)
      .set({ questionId: override.questionId })
      .where(and(eq(chunkSources.chunkId, override.chunkId), isNull(chunkSources.questionId)));
  }

  // 缺 Transcript 的 Podcast Book 必须带可见阻塞原因。
  await db.run(sql`
    UPDATE books SET status = 'blocked', blocked_reason = '缺少可追溯的真实 Transcript', default_accent = 'source'
    WHERE source_type = 'podcast' AND NOT EXISTS (
      SELECT 1 FROM source_sentences s WHERE s.book_id = books.id
    )`);

  const orphans = await db.all<Record<string, unknown>>(sql`
    SELECT lp.* FROM learning_progress lp LEFT JOIN chunks c ON c.id = lp.chunk_id WHERE c.id IS NULL`);
  fs.mkdirSync(REPORTS, { recursive: true });
  const orphanReport = path.join(REPORTS, "orphan-learning-progress-latest.json");
  fs.writeFileSync(
    orphanReport,
    JSON.stringify({ checkedAt: new Date().toISOString(), count: orphans.length, records: orphans }, null, 1),
    "utf-8",
  );

  const result = {
    source: payload.source,
    lexemes: payload.lexemes.length,
    pronunciations: payload.chunkPronunciations.length,
    annotations: payload.annotations.length,
    glosses: payload.chunkGlosses.length,
    contextOverrides: contextOverrides.overrides.length,
    orphanProgress: orphans.length,
  };
  console.log("内容修复导入完成:", result);
  return result;
}

if (process.argv[1]?.endsWith("repair_content.ts")) {
  repairContent().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
