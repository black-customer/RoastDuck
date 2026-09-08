import { z } from "zod";
import type { LearningMaterialRow } from "@/lib/speaking-practice/schemas";

export const FOUR_STEP_VERSION = "four_step_v1";
export const stepNames = ["语块提取", "整句提取", "全文填空", "整段表达"] as const;
export const trainingEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("submit"), clientEventId: z.string().min(8).max(120), stepVersion: z.number().int().nonnegative(), input: z.string().trim().min(1).max(8000),retryUnknown:z.boolean().optional() }),
  z.object({type:z.literal("pause"),clientEventId:z.string().min(8).max(120),stepVersion:z.number().int().nonnegative()}),
  z.object({ type: z.literal("assist"), clientEventId: z.string().min(8).max(120), stepVersion: z.number().int().nonnegative() }),
  z.object({ type: z.literal("continue"), clientEventId: z.string().min(8).max(120), stepVersion: z.number().int().nonnegative() }),
  z.object({ type: z.literal("recall"), clientEventId: z.string().min(8).max(120), stepVersion: z.number().int().nonnegative() }),
]);
export type TrainingEvent = z.infer<typeof trainingEventSchema>;
export const judgeSchema = z.object({
  verdict: z.enum(["correct", "incorrect", "uncertain"]),
  meaningPreserved: z.boolean(), feedbackZh: z.string().min(1).max(1800),
});
export type JudgeResult = z.infer<typeof judgeSchema>;
export const materialReviewSchema = z.object({
  approved: z.boolean(), reasonZh: z.string().min(1).max(2000),
  rows: z.array(z.object({ index: z.number().int().nonnegative(), approved: z.boolean(), reasonZh: z.string().min(1).max(1000) })),
});

export interface TrainingTask {
  id: string; rowIndices: number[]; promptZh: string; answer: string; variants: string[];
  before?: string; after?: string;
}
export interface TrainingState {
  draftVersion?:number;
  hintVisible?: boolean;
  cursor: number; passed: boolean; input: string; assistance: number;
  feedback: JudgeResult | null;
  tasks: TrainingTask[][];
  evidence: Array<{ taskId: string; rows: number[]; step: number; verdict: string; assisted: number }>;
}
export interface TrainingView {
  draftVersion?:number;
  pendingEvent?:TrainingEvent|null;
  id: string; materialId: string; sourceType: string; sourceId: string; questionId: string | null;
  mode: string; status: string; step: number; stepVersion: number; taskIndex: number; taskCount: number;
  promptZh: string; before?: string; after?: string; draft: string; passed: boolean;
  feedback: JudgeResult | null; hint: string | null; answer: string | null; busy: boolean;
  completedAt: string | null;
}

export function normalizeExpression(value: string) {
  return value.normalize("NFKC").toLowerCase().replace(/[’‘]/g, "'").replace(/[“”]/g, '"')
    .replace(/[\p{P}\p{S}]/gu, " ").replace(/\s+/g, " ").trim();
}

/** 整词边界＋词形由已审核变体给出，不把子串猜测当作挖空证据。 */
export function findTargetSpan(text: string, targets: string[]) {
  for (const target of targets.filter(Boolean).sort((a, b) => b.length - a.length)) {
    const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "iu").exec(text);
    if (match) return { start: match.index, end: match.index + match[0].length, surface: match[0] };
  }
  return null;
}

/** 同一表达重复出现时也遮住，避免其余原文泄露当前空格答案。 */
export function maskOtherTargets(text: string, targets: string[]) {
  let result = "";
  let remainder = text;
  for (let span = findTargetSpan(remainder, targets); span; span = findTargetSpan(remainder, targets)) {
    result += remainder.slice(0, span.start) + "[同一表达]";
    remainder = remainder.slice(span.end);
  }
  return result + remainder;
}

export function buildTasks(rows: LearningMaterialRow[], naturalVersion: string, intentZh: string): TrainingTask[][] {
  const chunks: TrainingTask[] = rows.map((row, i) => ({ id: `chunk_${i}`, rowIndices: [i], promptZh: row.chineseChunk, answer: row.englishChunk, variants: row.acceptableVariants }));
  const sentences: TrainingTask[] = [];
  for (const [i, row] of rows.entries()) {
    const found = sentences.find((task) => normalizeExpression(task.answer) === normalizeExpression(row.naturalEnglishSentence) && task.promptZh===row.yourChineseSentence);
    if (found) found.rowIndices.push(i);
    else sentences.push({ id: `sentence_${i}`, rowIndices: [i], promptZh: row.yourChineseSentence, answer: row.naturalEnglishSentence, variants: [] });
  }
  const cloze: TrainingTask[] = [];
  for (const [i, row] of rows.entries()) {
    const targets=row.surfaceInSentence ? [row.surfaceInSentence] : [row.englishChunk,...row.acceptableVariants];
    const span = findTargetSpan(naturalVersion, targets);
    // 独立语块的可接受变体不一定适合当前空格（如 a + 复数名词）。非原表面形交由上下文 Judge。
    if (span) cloze.push({ id: `cloze_${i}`, rowIndices: [i], promptZh: row.chineseChunk, answer: span.surface, variants: [],
      before: maskOtherTargets(naturalVersion.slice(0, span.start), targets),
      after: maskOtherTargets(naturalVersion.slice(span.end), targets) });
  }
  return [chunks, sentences, cloze, [{ id: "full", rowIndices: rows.map((_, i) => i), promptZh: intentZh || [...new Set(rows.map((r) => r.yourChineseSentence))].join("\n"), answer: naturalVersion, variants: [] }]];
}
