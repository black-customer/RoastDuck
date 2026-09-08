/**
 * import_db 阶段：sources/{topics,questions,demo_sentences}.json → SQLite（幂等）。
 * 同时播种 4 本词书（Book 2-4 播客书为占位，transcript 到位后编译）。
 */
import fs from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import { getDbReady } from "../../../db/client";
import { books, questions, questionSetLinks, sourceSentences, topics } from "../../../db/schema";
import { normQuestionText } from "../lib/text";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const SRC = path.join(ROOT, "pipeline/sources");

const BOOK1_ID = "book1_ielts_complete";

const QUESTION_SOURCE_CATALOG: Record<string, { setId: string; file: string }> = {
  mdoors_part1_demo_2026q2: { setId: "qs_2026_05_08", file: "【麦门雅思】2026年5-8月口语Part1新题高分demo.pdf" },
  mdoors_part2_2026q2: { setId: "qs_2026_05_08", file: "【麦门雅思】26年5-8月Part2新题保留题_全部串题.pdf" },
  mdoors_part3_2026q2: { setId: "qs_2026_05_08", file: "【麦门雅思】26年5-8月Part3_十大话题高分示范.pdf" },
  part1_new_2026q1: { setId: "qs_2026_01_04", file: "Part1新题.pdf" },
  part2_all_new: { setId: "qs_2026_01_04", file: "Part2全部新题串题.pdf" },
  part2_people: { setId: "qs_2026_01_04", file: "Part2人物类串题.pdf" },
  part3_vol1: { setId: "qs_2026_01_04", file: "Part3（一）.pdf" },
  part3_vol2: { setId: "qs_2026_01_04", file: "Part3（二）.pdf" },
};

const SEED_BOOKS = [
  {
    id: BOOK1_ID,
    titleZh: "雅思口语完整语块书",
    titleEn: "IELTS Speaking Complete Chunk Book",
    sourceType: "question_bank",
    descriptionZh: "来自 2026 年 1-8 月雅思口语题库材料（含高分示范答案），全部题目进入覆盖系统。",
    status: "beta",
    blockedReason: null,
    defaultAccent: "en-GB",
  },
  {
    id: "book2_speaking_success",
    titleZh: "IELTS Speaking for Success",
    titleEn: "IELTS Speaking for Success",
    sourceType: "podcast",
    descriptionZh: "播客词书（MVP 5 集）。transcript 待获取/提供。",
    status: "blocked",
    blockedReason: "缺少可追溯的真实 Transcript",
    defaultAccent: "source",
  },
  {
    id: "book3_ielts_energy",
    titleZh: "IELTS Energy 7+",
    titleEn: "IELTS Energy 7+",
    sourceType: "podcast",
    descriptionZh: "播客词书（MVP 5 集）。transcript 待获取/提供。",
    status: "blocked",
    blockedReason: "缺少可追溯的真实 Transcript",
    defaultAccent: "source",
  },
  {
    id: "book4_esl_daily",
    titleZh: "ESL Daily English Podcast",
    titleEn: "ESL Daily English Podcast",
    sourceType: "podcast",
    descriptionZh: "播客词书（MVP 5 集）。transcript 待获取/提供。",
    status: "blocked",
    blockedReason: "缺少可追溯的真实 Transcript",
    defaultAccent: "source",
  },
];

export async function importDb() {
  const db = await getDbReady();

  // 内容表整体重建（确定性产物）；学习侧表（learning_progress/review_log）与已编译 chunks 不动
  await db.run(sql`DELETE FROM source_sentences`);
  await db.run(sql`DELETE FROM question_set_links`);
  await db.run(sql`DELETE FROM questions`);
  await db.run(sql`DELETE FROM topics`);

  for (const b of SEED_BOOKS) {
    await db
      .insert(books)
      .values(b)
      .onConflictDoUpdate({
        target: books.id,
        set: {
          titleZh: b.titleZh,
          titleEn: b.titleEn,
          descriptionZh: b.descriptionZh,
          status: b.status,
          blockedReason: b.blockedReason,
          defaultAccent: b.defaultAccent,
        },
      });
  }

  const topicsJson = JSON.parse(fs.readFileSync(path.join(SRC, "topics.json"), "utf-8"));
  const questionsJson = JSON.parse(fs.readFileSync(path.join(SRC, "questions.json"), "utf-8"));
  const sentencesJson = JSON.parse(fs.readFileSync(path.join(SRC, "demo_sentences.json"), "utf-8"));

  // 话题
  for (const t of topicsJson) {
    await db
      .insert(topics)
      .values({
        id: t.id,
        bookId: BOOK1_ID,
        nameZh: t.nameZh || t.nameEn,
        nameEn: t.nameEn || t.nameZh,
        ieltsPart: t.part,
        domainsJson: "[]",
        status: "pending",
      })
      .onConflictDoUpdate({
        target: topics.id,
        set: { nameZh: t.nameZh || t.nameEn, nameEn: t.nameEn || t.nameZh, ieltsPart: t.part },
      });
  }

  // 题目
  for (const q of questionsJson) {
    await db
      .insert(questions)
      .values({
        id: q.id,
        bookId: BOOK1_ID,
        topicId: q.topicId,
        part: q.part,
        text: q.textEn,
        textZh: q.textZh ?? "",
        normText: normQuestionText(q.textEn),
        status: "pending",
        blueprintJson: "[]",
        sourceRefsJson: JSON.stringify(q.sourceRefs ?? []),
      })
      .onConflictDoUpdate({
        target: questions.id,
        set: {
          topicId: q.topicId,
          text: q.textEn,
          textZh: q.textZh ?? "",
          sourceRefsJson: JSON.stringify(q.sourceRefs ?? []),
        },
      });

    for (const sourceRef of q.sourceRefs ?? []) {
      const source = QUESTION_SOURCE_CATALOG[String(sourceRef.slug)];
      if (!source || !Number.isInteger(sourceRef.page)) continue;
      await db.insert(questionSetLinks).values({
        questionId: q.id,
        questionSetId: source.setId,
        sourceSlug: String(sourceRef.slug),
        sourceFile: source.file,
        sourcePage: Number(sourceRef.page),
      }).onConflictDoNothing();
    }
  }

  // 示范答案句
  const demoSentences = sentencesJson as Array<{
    id: string;
    slug: string;
    episodeOrFile: string;
    seq: number;
    textEn: string;
    questionId: string | null;
    context: string;
    labelZh: string;
  }>;
  for (const s of demoSentences) {
    await db
      .insert(sourceSentences)
      .values({
        id: s.id,
        bookId: BOOK1_ID,
        episodeOrFile: s.episodeOrFile,
        seq: s.seq,
        text: s.textEn,
        questionId: s.questionId,
        status: "pending",
      })
      .onConflictDoUpdate({
        target: sourceSentences.id,
        set: { text: s.textEn, questionId: s.questionId },
      });
  }

  const counts = await db.all<{ questions: number; sentences: number; topics: number }>(sql`
    SELECT
      (SELECT COUNT(*) FROM questions) AS questions,
      (SELECT COUNT(*) FROM source_sentences) AS sentences,
      (SELECT COUNT(*) FROM topics) AS topics
  `);
  console.log("DB 导入完成:", counts[0]);
}

if (process.argv[1] && process.argv[1].endsWith("import_db.ts")) {
  importDb()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
