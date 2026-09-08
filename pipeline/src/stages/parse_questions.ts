/**
 * parse_questions 阶段：books/*.json → 统一题目清单 + 话题注册表 + 示范答案句。
 *
 * - 跨书题目去重（norm_text），合并 sourceRefs 与答案段
 * - 话题归一（Part1/3 用 topicEn；Part2 用串题组）
 * - 示范答案段切分为句子（确定性规则切分），带题目/组关联
 *
 * 输出：pipeline/sources/questions.json / topics.json / demo_sentences.json
 */
import fs from "node:fs";
import path from "node:path";
import { normQuestionText, sha1Like } from "../lib/text";
import type { AnswerSegment, ParsedBook } from "./extract_content";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const BOOKS_DIR = path.join(ROOT, "pipeline/sources/books");
const OUT_DIR = path.join(ROOT, "pipeline/sources");

interface UnifiedTopic {
  id: string;
  part: number;
  nameEn: string;
  nameZh: string;
  aliases: string[];
  questionIds: string[];
  sourceRefs: Array<{ slug: string; page: number }>;
}

interface UnifiedQuestion {
  id: string;
  part: number;
  topicId: string;
  textEn: string;
  textZh: string;
  sourceRefs: Array<{ slug: string; page: number }>;
  answerSegments: Array<AnswerSegment & { from: string }>;
}

interface DemoSentence {
  id: string;
  slug: string;
  episodeOrFile: string;
  seq: number;
  textEn: string;
  questionId: string | null;
  groupZh: string | null;
  labelZh: string;
  context: string;
}

/** 确定性英文分句（缩写/省略号保护）。 */
export function splitSentences(text: string): string[] {
  const protectedText = text
    .replace(/\b(Mr|Mrs|Ms|Dr|Prof|vs|etc|e\.g|i\.e|St)\./g, "$1<DOT>")
    .replace(/\b([A-Z])\./g, "$1<DOT>")
    .replace(/\.\.\./g, "<ELL>");
  const raw = protectedText.split(/(?<=[.!?])\s+(?=[A-Z"“(I])/);
  return raw
    .map((s) => s.replace(/<DOT>/g, ".").replace(/<ELL>/g, "...").trim())
    .filter((s) => s.length > 0);
}

export function parseAllBooks(): { topics: UnifiedTopic[]; questions: UnifiedQuestion[]; sentences: DemoSentence[] } {
  const files = fs
    .readdirSync(BOOKS_DIR)
    .filter((f) => f.endsWith(".json") && !f.startsWith("_"))
    .sort();

  const topics = new Map<string, UnifiedTopic>();
  const questions = new Map<string, UnifiedQuestion>();
  const sentences: DemoSentence[] = [];
  const episodeSeq = new Map<string, number>();
  const stats: Array<{ slug: string; raw: number; merged: number }> = [];

  for (const file of files) {
    const book = JSON.parse(fs.readFileSync(path.join(BOOKS_DIR, file), "utf-8")) as ParsedBook;
    let raw = 0;
    let merged = 0;

    for (const item of book.items) {
      raw++;
      const isCue = item.kind === "cue";
      const topicEn = isCue ? "" : item.topicEn.trim();
      const topicZh = isCue ? "" : item.topicZh.trim();
      const groupName = isCue ? item.groupZh.trim() : "";

      // 话题归一：QA 书用英文话题名；cue 书每组一个话题
      const topicKey = isCue ? `p2-group:${groupName}` : `p${book.part}-topic:${topicEn.toLowerCase()}`;
      let topic = topics.get(topicKey);
      if (!topic) {
        topic = {
          id: `t${book.part}_${sha1Like(topicKey).slice(0, 10)}`,
          part: book.part,
          nameEn: isCue ? "" : topicEn,
          nameZh: isCue ? groupName : topicZh,
          aliases: [],
          questionIds: [],
          sourceRefs: [],
        };
        topics.set(topicKey, topic);
      }
      if (topicEn && !topic.nameEn) topic.nameEn = topicEn;
      if (topicZh && !topic.nameZh) topic.nameZh = topicZh;

      const textEn = isCue ? item.cueEn.trim() : item.textEn.trim();
      if (!textEn) continue;
      const norm = normQuestionText(isCue ? item.cueEn.split("\n")[0] : textEn);
      if (!norm) continue;
      const qid = `q_${sha1Like(norm)}`;

      let q = questions.get(qid);
      const srcRef = { slug: book.slug, page: item.page };
      if (!q) {
        q = {
          id: qid,
          part: book.part,
          topicId: topic.id,
          textEn,
          textZh: item.kind === "qa" ? item.textZh : "",
          sourceRefs: [srcRef],
          answerSegments: [],
        };
        questions.set(qid, q);
        topic.questionIds.push(qid);
      } else {
        merged++;
        if (!q.sourceRefs.some((r) => r.slug === srcRef.slug && r.page === srcRef.page)) {
          q.sourceRefs.push(srcRef);
        }
        if (!q.textZh && item.kind === "qa" && item.textZh) q.textZh = item.textZh;
      }
      if (!topic.sourceRefs.some((r) => r.slug === srcRef.slug && r.page === srcRef.page)) {
        topic.sourceRefs.push(srcRef);
      }

      // 答案段合并（直接挂载 + 组级共享段）
      const segs: Array<AnswerSegment & { from: string }> = [];
      for (const seg of item.answerSegments) {
        if (seg.en || seg.zh) segs.push({ ...seg, from: book.slug });
      }
      if (isCue) {
        const groupSegs = book.groupAnswers.filter((g) => g.groupZh === item.groupZh);
        for (const g of groupSegs) {
          for (const seg of g.segments) {
            if (!(seg.en || seg.zh)) continue;
            if (seg.cueId && seg.cueId !== `${item.groupZh}::${item.cueEn}`) continue; // 已明确属于其他 cue
            if (seg.cueId) {
              // 明确属于本 cue，避免重复（同组过滤后只加一次）
              if (!segs.some((s) => s.en === seg.en && s.labelZh === seg.labelZh)) {
                segs.push({ ...seg, from: book.slug });
              }
              continue;
            }
            // 组级共享段 → 挂到组内每个 cue（句子关联时取主 cue）
            if (!segs.some((s) => s.en === seg.en && s.labelZh === seg.labelZh)) {
              segs.push({ ...seg, from: book.slug });
            }
          }
        }
      }
      q.answerSegments.push(...segs);

      // 示范答案切句（seq 按 episode 全局递增，保证 (book, episode, seq) 唯一）
      for (const seg of q.answerSegments) {
        if (!seg.en) continue;
        const episodeOrFile = `${book.slug}#${item.page}`;
        for (const sentence of splitSentences(seg.en)) {
          if (sentence.length < 3) continue;
          const sid = `s_${sha1Like(`${book.slug}|${sentence}`)}`;
          const seq = episodeSeq.get(episodeOrFile) ?? 0;
          episodeSeq.set(episodeOrFile, seq + 1);
          sentences.push({
            id: sid,
            slug: book.slug,
            episodeOrFile,
            seq,
            textEn: sentence,
            questionId: qid,
            groupZh: isCue ? item.groupZh : null,
            labelZh: seg.labelZh,
            context: [isCue ? item.groupZh : item.topicEn, seg.labelZh].filter(Boolean).join(" / "),
          });
        }
      }
    }
    stats.push({ slug: book.slug, raw, merged });
  }

  // 同一句子被多题引用时保留一条（questionId 取首题），但题目关联由 chunk_sources 记录
  const seen = new Set<string>();
  const dedupedSentences: DemoSentence[] = [];
  for (const s of sentences) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    dedupedSentences.push(s);
  }

  // 重算题目 topicIds 一致性（合并后 question 保留首个 topicId）
  const outTopics = [...topics.values()];
  const outQuestions = [...questions.values()];
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "topics.json"), JSON.stringify(outTopics, null, 1), "utf-8");
  fs.writeFileSync(path.join(OUT_DIR, "questions.json"), JSON.stringify(outQuestions, null, 1), "utf-8");
  fs.writeFileSync(path.join(OUT_DIR, "demo_sentences.json"), JSON.stringify(dedupedSentences, null, 1), "utf-8");

  for (const st of stats) console.log(`${st.slug}: raw=${st.raw} mergedIntoExisting=${st.merged}`);
  console.log(
    `TOTAL: topics=${outTopics.length} questions=${outQuestions.length} demo_sentences=${dedupedSentences.length}`,
  );
  return { topics: outTopics, questions: outQuestions, sentences: dedupedSentences };
}

if (process.argv[1] && process.argv[1].endsWith("parse_questions.ts")) {
  parseAllBooks();
}
