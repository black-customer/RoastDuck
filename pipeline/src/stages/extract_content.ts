/**
 * extract_content 阶段：raw JSON（PDF 行）→ 规范化书籍内容 JSON。
 *
 * 两类解析器：
 *  - QA 书（Part1/Part3 问答式）：part1_new、mdoors_part1、part3_vol1/2、mdoors_part3
 *  - Cue 书（Part2 卡片式）：part2_all_new、part2_people、mdoors_part2
 *
 * Cue 书答案为组级资源：answerSegments 挂在 cue 或 groupAnswers（按标签匹配回 cue）。
 * 所有解析为确定性规则；无法归类的行进入 warnings 供人工核查。
 * 输出：pipeline/sources/books/<slug>.json
 */
import fs from "node:fs";
import path from "node:path";
import { classifyLine, normalizeZh, sha1Like, splitMixed, type LineKind } from "../lib/text";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const RAW_DIR = path.join(ROOT, "pipeline/sources/raw");
const OUT_DIR = path.join(ROOT, "pipeline/sources/books");

type Span = { font: string; size: number; text: string };
type RawLine = { y: number; size: number; spans: Span[]; text: string };
type RawPage = { page: number; lines: RawLine[] };
type RawBook = { slug: string; file: string; pages: RawPage[] };

export interface AnswerSegment {
  labelZh: string;
  en: string;
  zh: string;
  cueId?: string; // 组级答案匹配到的 cue
}

export interface ParsedQA {
  kind: "qa";
  topicEn: string;
  topicZh: string;
  number: string;
  textEn: string;
  textZh: string;
  answerSegments: AnswerSegment[];
  page: number;
}

export interface ParsedCue {
  kind: "cue";
  groupZh: string;
  labelZh: string;
  cueEn: string;
  answerSegments: AnswerSegment[];
  page: number;
}

export interface GroupAnswers {
  groupZh: string;
  segments: AnswerSegment[];
  page: number;
}

export interface ParsedBook {
  slug: string;
  file: string;
  part: 1 | 2 | 3;
  season: string;
  items: Array<ParsedQA | ParsedCue>;
  groupAnswers: GroupAnswers[];
  warnings: string[];
}

type BookConfig = {
  slug: string;
  part: 1 | 2 | 3;
  season: string;
  strategy: "qa" | "cue";
  contentStartPage: number;
  startPattern: RegExp;
  topicHeaderSize: number;
  groupHeaderSize: number;
  questionNumbered: boolean;
  questionSize?: number; // QA 书：题目行字号（与正文不同时配置）
};

const CONFIGS: BookConfig[] = [
  { slug: "part1_new_2026q1", part: 1, season: "2026Q1", strategy: "qa", contentStartPage: 8, startPattern: /Part\s*1必考题/, topicHeaderSize: 11.0, groupHeaderSize: 13.0, questionNumbered: false },
  { slug: "mdoors_part1_demo_2026q2", part: 1, season: "2026Q2", strategy: "qa", contentStartPage: 6, startPattern: /Teachers/, topicHeaderSize: 11.0, groupHeaderSize: 13.0, questionNumbered: true },
  { slug: "part3_vol1", part: 3, season: "2026Q1", strategy: "qa", contentStartPage: 8, startPattern: /Part\s*3/, topicHeaderSize: 11.0, groupHeaderSize: 13.0, questionNumbered: false },
  { slug: "part3_vol2", part: 3, season: "2026Q1", strategy: "qa", contentStartPage: 8, startPattern: /Part\s*3/, topicHeaderSize: 11.0, groupHeaderSize: 13.0, questionNumbered: false },
  { slug: "mdoors_part3_2026q2", part: 3, season: "2026Q2", strategy: "qa", contentStartPage: 7, startPattern: /Topic\s*1/, topicHeaderSize: 16.0, groupHeaderSize: 16.0, questionNumbered: true, questionSize: 11.5 },
  { slug: "part2_all_new", part: 2, season: "2026Q1", strategy: "cue", contentStartPage: 8, startPattern: /新题串题1/, topicHeaderSize: 11.0, groupHeaderSize: 11.0, questionNumbered: false },
  { slug: "part2_people", part: 2, season: "2026Q1", strategy: "cue", contentStartPage: 8, startPattern: /Describe/, topicHeaderSize: 10.0, groupHeaderSize: 11.0, questionNumbered: false },
  { slug: "mdoors_part2_2026q2", part: 2, season: "2026Q2", strategy: "cue", contentStartPage: 7, startPattern: /串题一/, topicHeaderSize: 12.0, groupHeaderSize: 13.5, questionNumbered: true },
];

const PAGE_NO_RE = /^\d{1,3}$/;
const GROUP_RE = /^(新题串题|串题|人物难题|新题题目|新题难题)\s*[一二三四五六七八九十\d]*/;
const SEGMENT_LABEL_RE = /^(开头|结尾|侧重点|对比|中间|原因|感受|过渡|故事|观点)\s*[-–—（(]?/;
const LABEL_PREFIX_RE = /^(开头|结尾|侧重点|侧重|中间|对比|过渡)[（(]?[-–——]?]?）?/;

const DESCRIBE_RE = /^Describe\s+(a|an|the|your|one|something|a time|when|who|what|a person|an occasion)/i;
// 疑问句开头的英文行（无中文翻译的题目行）
const QUESTION_START_RE =
  /^\s*(Do|Does|Did|Is|Are|Was|Were|Have|Has|Had|Can|Could|Would|Will|What|When|Where|Who|Why|How|Which|Please describe|Describe)\b/i;

function lineKindOf(line: RawLine): LineKind {
  return classifyLine(line.text);
}

function isFooter(line: RawLine): boolean {
  return line.size <= 8.7 && PAGE_NO_RE.test(line.text.trim());
}

function joinEn(a: string, b: string): string {
  return `${a} ${b}`.replace(/\s+/g, " ").trim();
}

type FlatLine = { page: number; size: number; kind: LineKind; text: string };

function flatten(raw: RawBook, cfg: BookConfig): FlatLine[] {
  const out: FlatLine[] = [];
  let started = false;
  for (const page of raw.pages) {
    for (const line of page.lines) {
      if (isFooter(line)) continue;
      if (line.size <= 8.0) continue; // 页脚水印/页码（所有正文行 ≥ 9.6）
      const text = line.text.trim();
      if (!text) continue;
      if (!started) {
        if (page.page >= cfg.contentStartPage && cfg.startPattern.test(text)) started = true;
        else continue;
      }
      out.push({ page: page.page, size: line.size, kind: lineKindOf(line), text });
    }
  }
  return out;
}

/* ---------------- QA 状态机 ---------------- */

function parseQaBook(raw: RawBook, cfg: BookConfig): ParsedBook {
  const lines = flatten(raw, cfg);
  const items: ParsedBook["items"] = [];
  const warnings: string[] = [];

  let topicEn = "";
  let topicZh = "";
  let expectingTopicZh = false;
  let expectingTopicEn = false;

  let cur: ParsedQA | null = null as ParsedQA | null;
  let state: "fresh" | "question_zh" | "answer_en" | "answer_zh" = "fresh";
  let segIdx = -1;
  let qFromEnOnly = false;
  let sinceHeader = 999; // 距最近话题标题的行数（用于仅消费紧邻的补充行）

  const newSegment = () => {
    cur!.answerSegments.push({ labelZh: "", en: "", zh: "" });
    segIdx = cur!.answerSegments.length - 1;
    return cur!.answerSegments[segIdx];
  };

  const finalize = () => {
    if (cur && cur.textEn) {
      cur.answerSegments = cur.answerSegments.filter((s) => s.en || s.zh);
      items.push(cur);
    }
    cur = null;
    segIdx = -1;
    state = "fresh";
  };

  const startQuestion = (en: string, zh: string, page: number) => {
    finalize();
    const numMatch = en.match(/^(\d{1,2})[.、)]\s*(.+)$/);
    cur = {
      kind: "qa",
      topicEn,
      topicZh,
      number: numMatch ? numMatch[1] : "",
      textEn: (numMatch ? numMatch[2] : en).trim(),
      textZh: normalizeZh(zh, cfg.slug),
      answerSegments: [],
      page,
    };
    newSegment();
    state = cur.textZh ? "question_zh" : "fresh";
  };

  const isQuestionLine = (line: FlatLine): boolean => {
    if (line.kind === "zh") return false;
    if (line.kind === "mixed") return true;
    if (cfg.questionSize && line.size >= cfg.questionSize) return true;
    return false;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const { kind, size, text, page } = line;
    sinceHeader++;

    // 话题标题（大字号，非纯中文）
    if (size >= cfg.topicHeaderSize && kind !== "zh") {
      finalize();
      sinceHeader = 0;
      if (/^Part\s*\d/i.test(text) && kind === "mixed") {
        expectingTopicZh = true;
        continue;
      }
      if (kind === "mixed") {
        const { en, zh } = splitMixed(text);
        topicEn = en.trim();
        topicZh = normalizeZh(zh, cfg.slug);
      } else {
        topicEn = text.replace(/^\d{1,2}[.、]\s*/, "").trim();
        topicZh = "";
      }
      expectingTopicZh = true;
      expectingTopicEn = true;
      continue;
    }
    // 组标题（纯中文大字号）
    if (size >= cfg.groupHeaderSize && kind === "zh" && !cur) {
      finalize();
      sinceHeader = 0;
      topicZh = normalizeZh(text, cfg.slug);
      topicEn = "";
      expectingTopicZh = false;
      continue;
    }

    // 话题补充行（仅消费紧邻标题的行）
    if (!cur && state === "fresh" && sinceHeader <= 1) {
      if (expectingTopicZh && kind === "zh") {
        topicZh = normalizeZh(text, cfg.slug);
        expectingTopicZh = false;
        continue;
      }
      if (expectingTopicEn && kind === "en" && !QUESTION_START_RE.test(text)) {
        topicEn = topicEn ? `${topicEn} (${text.replace(/[()]/g, "").trim()})` : text.replace(/[()]/g, "").trim();
        expectingTopicEn = false;
        continue;
      }
    }

    // 题目行
    if (isQuestionLine(line)) {
      if (kind === "mixed") {
        const { en, zh } = splitMixed(text);
        // mixed 行必须像题目才出题（含 ? 或疑问词开头或编号开头），
        // 否则是混入中文的答案行 → 并入当前答案
        const looksQuestion =
          en.includes("?") || QUESTION_START_RE.test(en) || /^\d{1,2}[.、)]/.test(en);
        if (looksQuestion) {
          // EN-only 题目的 mixed 续行（题干英文剩余部分 + 中文翻译）
          if (cur && qFromEnOnly && state === "fresh" && !cur.textZh && !QUESTION_START_RE.test(en)) {
            const seg = cur.answerSegments[segIdx];
            if (seg && !seg.en && !seg.zh) {
              cur.textEn = joinEn(cur.textEn, en);
              cur.textZh = normalizeZh(zh, cfg.slug);
              qFromEnOnly = false;
              state = cur.textZh ? "question_zh" : "fresh";
              continue;
            }
          }
          startQuestion(en, zh, page);
          qFromEnOnly = false;
          continue;
        }
        // 非题目 mixed 行 → 答案
        if (cur) {
          const seg = cur.answerSegments[segIdx];
          if (state === "answer_en" || state === "answer_zh" || state === "fresh") {
            seg.en = joinEn(seg.en, en);
            if (zh) seg.zh += normalizeZh(zh, cfg.slug);
            state = "answer_en";
            continue;
          }
        }
        warnings.push(`p${page} 无主混合行: ${text.slice(0, 44)}`);
        continue;
      }
      startQuestion(text, "", page);
      qFromEnOnly = false;
      continue;
    }

    // 纯英文行
    if (kind === "en") {
      if (!cur) {
        // 疑问句开头的无主英文行 → 视为题目（该题无中文翻译行）
        if (QUESTION_START_RE.test(text) && !/[.!?]$/.test(text)) {
          startQuestion(text, "", page);
          qFromEnOnly = true;
        } else if (QUESTION_START_RE.test(text) && /[?]$/.test(text)) {
          startQuestion(text, "", page);
          qFromEnOnly = true;
        } else {
          warnings.push(`p${page} 无主英文行: ${text.slice(0, 50)}`);
        }
        continue;
      }
      const seg = cur.answerSegments[segIdx];
      // 题干英文续行：题干未以 ? 结尾且尚无答案
      if (state === "fresh" && seg && !seg.en && !seg.zh && !cur.textZh && !/[?？]$/.test(cur.textEn)) {
        cur.textEn = joinEn(cur.textEn, text);
        continue;
      }
      if (state === "answer_en") {
        seg.en = joinEn(seg.en, text);
        continue;
      }
      state = "answer_en";
      seg.en = joinEn(seg.en, text);
      continue;
    }

    // 纯中文行
    if (kind === "zh") {
      const zh = normalizeZh(text, cfg.slug);
      if (cur && state === "question_zh") {
        cur.textZh = normalizeZh(cur.textZh + zh, cfg.slug);
        continue;
      }
      if (cur && state === "answer_zh") {
        cur.answerSegments[segIdx].zh += zh;
        continue;
      }
      if (cur && state === "answer_en") {
        state = "answer_zh";
        cur.answerSegments[segIdx].zh += zh;
        continue;
      }
      if (cur && state === "fresh") {
        const seg = newSegment();
        if (SEGMENT_LABEL_RE.test(zh) || (zh.length <= 20 && !/[。！？]/.test(zh))) {
          seg.labelZh = zh;
          state = "fresh";
        } else {
          seg.zh += zh;
          state = "answer_zh";
        }
        continue;
      }
      warnings.push(`p${page} 无主中文行: ${text.slice(0, 40)}`);
      continue;
    }
  }
  finalize();
  return { slug: raw.slug, file: raw.file, part: cfg.part, season: cfg.season, items, groupAnswers: [], warnings };
}

/* ---------------- Cue 状态机（Part2） ---------------- */

function parseCueBook(raw: RawBook, cfg: BookConfig): ParsedBook {
  const lines = flatten(raw, cfg);
  const items: ParsedBook["items"] = [];
  const groupAnswers: GroupAnswers[] = [];
  const warnings: string[] = [];

  let groupZh = "";
  let cur: ParsedCue | null = null as ParsedCue | null;
  let state: "idle" | "describe" | "bullets" | "answer_en" | "answer_zh" = "idle";
  let segIdx = -1;
  let sawExplainBullet = false;
  let pool: GroupAnswers | null = null as GroupAnswers | null; // 当前组答案池
  let justSetGroup = false;

  const newSegment = (label = "") => {
    cur!.answerSegments.push({ labelZh: label, en: "", zh: "" });
    segIdx = cur!.answerSegments.length - 1;
    justSetGroup = false;
    return cur!.answerSegments[segIdx];
  };

  const newPoolSegment = (label = "") => {
    pool!.segments.push({ labelZh: label, en: "", zh: "" });
    justSetGroup = false;
    return pool!.segments[pool!.segments.length - 1];
  };

  const finalize = () => {
    if (cur && cur.cueEn) {
      cur.answerSegments = cur.answerSegments.filter((s) => s.en || s.zh);
      items.push(cur);
    }
    cur = null;
    segIdx = -1;
    state = "idle";
    sawExplainBullet = false;
  };

  const newCue = (labelZh: string, page: number) => {
    finalize();
    cur = { kind: "cue", groupZh, labelZh, cueEn: "", answerSegments: [], page };
    state = "describe";
    justSetGroup = false;
  };

  const setGroup = (zh: string, page: number) => {
    finalize();
    groupZh = zh;
    pool = { groupZh, segments: [], page };
    groupAnswers.push(pool);
    state = "idle";
    justSetGroup = true;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const next = lines[i + 1];
    const { kind, size, text, page } = line;
    const TRACE = process.env.ROASTDUCK_TRACE === cfg.slug && page <= Number(process.env.ROASTDUCK_TRACE_PAGE ?? 0);
    if (TRACE) console.error(`[trace p${page} state=${state} pool=${pool ? pool.segments.length : "null"} cur=${cur ? (cur.labelZh || cur.cueEn.slice(0, 12)) : "null"}] (${kind},${size}) ${text.slice(0, 44)}`);

    // 组标题（GROUP_RE 优先于任何状态）
    if (kind !== "en" && GROUP_RE.test(text)) {
      setGroup(normalizeZh(text, cfg.slug), page);
      continue;
    }
    // 组标题跨行续行（大字号中文，组刚建立）
    if (kind !== "en" && size >= cfg.groupHeaderSize && kind === "zh" && justSetGroup && pool && pool.segments.length === 0) {
      groupZh += text;
      pool.groupZh = groupZh;
      continue;
    }
    // 大字号中文行（答案区域）→ 段标签
    if (kind !== "en" && size >= cfg.groupHeaderSize && kind === "zh") {
      if (pool) newPoolSegment(normalizeZh(text, cfg.slug));
      else if (cur) newSegment(normalizeZh(text, cfg.slug));
      state = "idle";
      continue;
    }

    // Describe 行 → 新 cue（若当前 cue 刚由标签创建且尚无题干，则归属当前 cue）
    if (kind === "en" && DESCRIBE_RE.test(text)) {
      if (cur && state === "describe" && !cur.cueEn) {
        cur.cueEn = text;
      } else {
        newCue("", page);
        cur!.cueEn = text;
      }
      continue;
    }

    // 纯中文行
    if (kind === "zh") {
      const zh = normalizeZh(text, cfg.slug);
      const nextIsDescribe = next && next.kind === "en" && DESCRIBE_RE.test(next.text);
      if ((state === "answer_en" || state === "answer_zh") && !nextIsDescribe) {
        if (SEGMENT_LABEL_RE.test(zh) || (zh.length <= 16 && !/[。！？]/.test(zh))) {
          if (pool) newPoolSegment(zh);
          else if (cur) newSegment(zh);
          state = "idle";
        } else if (pool && pool.segments.length > 0) {
          pool.segments[pool.segments.length - 1].zh += zh;
          state = "answer_zh";
        } else if (cur && cur.answerSegments[segIdx]) {
          cur.answerSegments[segIdx].zh += zh;
          state = "answer_zh";
        }
        continue;
      }
      if ((state === "answer_en" || state === "answer_zh") && nextIsDescribe) {
        // 下一题的标签
        finalize();
        cur = { kind: "cue", groupZh, labelZh: zh.replace(/^\d{1,2}[.、]\s*/, ""), cueEn: "", answerSegments: [], page };
        state = "describe";
        continue;
      }
      if (state === "describe" || state === "bullets") {
        if (nextIsDescribe) {
          finalize();
          cur = { kind: "cue", groupZh, labelZh: zh.replace(/^\d{1,2}[.、]\s*/, ""), cueEn: "", answerSegments: [], page };
          state = "describe";
        } else {
          // cue 已收完：此行是组级答案段标签
          if (pool) newPoolSegment(zh);
          state = "idle";
        }
        continue;
      }
      if (state === "idle") {
        if (nextIsDescribe) {
          cur = { kind: "cue", groupZh, labelZh: zh.replace(/^\d{1,2}[.、]\s*/, ""), cueEn: "", answerSegments: [], page };
          state = "describe";
        } else if (pool && pool.segments.length > 0) {
          // 段标签后的中文答案续行
          pool.segments[pool.segments.length - 1].zh += zh;
          state = "answer_zh";
        } else {
          warnings.push(`p${page} cue 书孤立中文行: ${zh.slice(0, 30)}`);
        }
        continue;
      }
      continue;
    }

    // 英文 / mixed 行
    const parts = kind === "mixed" ? splitMixed(text) : null;
    if (parts && !parts.en && !parts.zh) {
      warnings.push(`p${page} 空混合行`);
      continue;
    }
    // 无英文的混合行（如「侧重app」）→ 按中文行处理
    if (parts && !parts.en) {
      const zh = normalizeZh(text, cfg.slug);
      if ((state === "answer_en" || state === "answer_zh") || (state === "describe" || state === "bullets")) {
        if (SEGMENT_LABEL_RE.test(zh) || (zh.length <= 16 && !/[。！？，]/.test(zh))) {
          if (pool) newPoolSegment(zh);
          else if (cur) newSegment(zh);
          state = "idle";
        } else if (pool && pool.segments.length > 0) {
          pool.segments[pool.segments.length - 1].zh += zh;
          state = "answer_zh";
        } else if (cur && cur.answerSegments[segIdx]) {
          cur.answerSegments[segIdx].zh += zh;
          state = "answer_zh";
        }
        continue;
      }
      warnings.push(`p${page} 无主混合中文行: ${zh.slice(0, 30)}`);
      continue;
    }
    // 短 mixed 行（如「5. *App/程序」）在 cue 收集区 → 新 cue 标签
    if (parts && state !== "answer_en" && state !== "answer_zh" && text.length <= 24) {
      const label = normalizeZh(parts.zh || parts.en, cfg.slug).replace(/^\d{1,2}[.、]\s*/, "").replace(/\*/g, "");
      if (label && !QUESTION_START_RE.test(parts.en)) {
        newCue(label, page);
        continue;
      }
    }
    const en = parts ? parts.en : text;
    if (!cur) {
      warnings.push(`p${page} 无主英文行: ${en.slice(0, 50)}`);
      continue;
    }
    if (state === "describe") {
      if (/^You should say:?$/i.test(en)) {
        cur!.cueEn = `${cur!.cueEn}\nYou should say:`.trim();
        state = "bullets";
        sawExplainBullet = false;
      } else {
        cur!.cueEn = joinEn(cur!.cueEn, en);
      }
      continue;
    }
    if (state === "bullets") {
      const isBullet = !sawExplainBullet && en.length <= 75 && !/[.!?]$/.test(en);
      if (isBullet) {
        cur!.cueEn = `${cur!.cueEn}\n${en}`.trim();
        if (/^And\s+(explain|describe|how|say)/i.test(en)) sawExplainBullet = true;
        continue;
      }
      // 答案英文开始：有组池 → 池；否则直接挂当前 cue
      if (pool) {
        const seg = newPoolSegment();
        seg.en = en;
      } else {
        const seg = newSegment();
        seg.en = en;
      }
      state = "answer_en";
      continue;
    }
    if (state === "answer_en") {
      const target =
        pool && pool.segments.length > 0
          ? pool.segments[pool.segments.length - 1]
          : cur!.answerSegments[segIdx];
      target.en = joinEn(target.en, en);
      continue;
    }
    // answer_zh → 英文续段；idle 态 → 答案英文开始（优先填充最近的空标签段）
    if (pool && pool.segments.length > 0) {
      const last = pool.segments[pool.segments.length - 1];
      if (state === "idle" && !last.en) {
        last.en = en;
      } else {
        newPoolSegment().en = en;
      }
    } else if (cur!.answerSegments[segIdx]) {
      cur!.answerSegments[segIdx].en = joinEn(cur!.answerSegments[segIdx].en, en);
    } else {
      newSegment().en = en;
    }
    state = "answer_en";
  }
  finalize();

  // 组级答案匹配：直接挂在 cue 上的段 + 池段统一按 标签/组条目/顺序 回配
  redistributeCueAnswers(items as ParsedCue[], groupAnswers);
  return { slug: raw.slug, file: raw.file, part: cfg.part, season: cfg.season, items, groupAnswers, warnings };
}

function cleanLabel(s: string): string {
  return s
    .replace(LABEL_PREFIX_RE, "")
    .replace(/[“”"'‘’。．.、:：\s*]+/g, "")
    .trim();
}

function redistributeCueAnswers(cues: ParsedCue[], groupAnswers: GroupAnswers[]) {
  const cueKey = (c: ParsedCue) => `${c.groupZh}::${c.cueEn}`;

  interface Bucket {
    cues: ParsedCue[];
    segs: Array<{ seg: AnswerSegment; owner: ParsedCue | null }>;
  }
  const buckets = new Map<string, Bucket>();
  for (const c of cues) {
    if (!buckets.has(c.groupZh)) buckets.set(c.groupZh, { cues: [], segs: [] });
    const b = buckets.get(c.groupZh)!;
    b.cues.push(c);
    for (const s of c.answerSegments) b.segs.push({ seg: s, owner: c });
    c.answerSegments = [];
  }
  for (const ga of groupAnswers) {
    const b = buckets.get(ga.groupZh);
    if (b) for (const s of ga.segments) b.segs.push({ seg: s, owner: null });
  }

  const orphanSegs: Array<{ groupZh: string; seg: AnswerSegment }> = [];
  for (const [name, b] of buckets) {
    const itemNames = name
      .replace(GROUP_RE, "")
      .split(/[，,；;、]/)
      .map((s) => cleanLabel(s))
      .filter(Boolean);

    // 无标签段且段数与 cue 数一致 → 按顺序分配
    const allUnlabeled = b.segs.every(({ seg }) => !cleanLabel(seg.labelZh));
    if (allUnlabeled && b.segs.length > 0 && b.segs.length === b.cues.length) {
      b.segs.forEach(({ seg }, i) => {
        const target = b.cues[i];
        target.answerSegments.push(seg);
        seg.cueId = cueKey(target);
      });
      continue;
    }

    let lastCore = "";
    for (const { seg } of b.segs) {
      // 无标签续段继承前一个有标签段（跨页/多段答案）
      const ownCore = cleanLabel(seg.labelZh);
      if (!ownCore && lastCore) seg.labelZh = lastCore;
      const core = cleanLabel(seg.labelZh);
      if (core) lastCore = core;
      let target: ParsedCue | null = null;
      if (core) {
        target =
          b.cues.find((c) => c.labelZh && (c.labelZh.includes(core) || core.includes(c.labelZh))) ?? null;
        if (!target) {
          const idx = itemNames.findIndex((n) => n && (n.includes(core) || core.includes(n)));
          if (idx >= 0 && idx < b.cues.length) target = b.cues[idx];
        }
      }
      if (target) {
        target.answerSegments.push(seg);
        seg.cueId = cueKey(target);
      } else {
        lastCore = "";
        orphanSegs.push({ groupZh: name, seg });
      }
    }
  }

  // 未匹配段保留在组级（组池），供下游做组级句子关联
  for (const ga of groupAnswers) ga.segments = [];
  for (const { groupZh, seg } of orphanSegs) {
    let ga = groupAnswers.find((g) => g.groupZh === groupZh);
    if (!ga) {
      ga = { groupZh, segments: [], page: 0 };
      groupAnswers.push(ga);
    }
    ga.segments.push(seg);
  }
}

/* ---------------- 主入口 ---------------- */

export function extractAll(): ParsedBook[] {
  const results: ParsedBook[] = [];
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const cfg of CONFIGS) {
    const rawPath = path.join(RAW_DIR, `${cfg.slug}.json`);
    if (!fs.existsSync(rawPath)) {
      console.error(`MISSING raw: ${rawPath}`);
      continue;
    }
    const raw = JSON.parse(fs.readFileSync(rawPath, "utf-8")) as RawBook;
    const parsed = cfg.strategy === "qa" ? parseQaBook(raw, cfg) : parseCueBook(raw, cfg);
    results.push(parsed);
    const outPath = path.join(OUT_DIR, `${cfg.slug}.json`);
    fs.writeFileSync(outPath, JSON.stringify(parsed, null, 1), "utf-8");
    const qCount = parsed.items.filter((i) => i.kind === "qa").length;
    const cueCount = parsed.items.filter((i) => i.kind === "cue").length;
    const withAnswer = parsed.items.filter((i) => i.answerSegments.length > 0).length;
    const poolSegs = parsed.groupAnswers.reduce((n, g) => n + g.segments.length, 0);
    console.log(
      `${cfg.slug}: items=${parsed.items.length} (qa=${qCount}, cue=${cueCount}, directAnswer=${withAnswer}), poolSegs=${poolSegs}, warnings=${parsed.warnings.length}`,
    );
  }
  return results;
}

export function itemId(prefix: string, text: string): string {
  return `${prefix}_${sha1Like(text)}`;
}

if (process.argv[1] && process.argv[1].endsWith("extract_content.ts")) {
  extractAll();
}
