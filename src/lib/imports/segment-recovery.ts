import { z } from "zod";
import { ImportSegmentSchema, SegmentTypeSchema, normalizeForMatch, normalizeTranscript, sha256, stableId, type ImportSegment } from "./personal-import";

const PieceSchema = z.object({
  startOffset: z.number().int().nonnegative(), endOffset: z.number().int().positive(),
  type: SegmentTypeSchema, questionId: z.string().min(1).nullable(),
  questionText: z.string().min(1).nullable(),
  questionTextOrigin: z.enum(["source", "missing_question_description"]).nullable(),
  part: z.union([z.literal(1), z.literal(2), z.literal(3)]).nullable(),
  answerGroupKey: z.string().min(1).nullable(), reasonZh: z.string().min(1),
});
export const SegmentReviewSchema = z.object({
  version: z.literal("segment-review-v1"),
  reviewer: z.object({ runId: z.string().min(1), sessionId: z.string().min(1), promptVersion: z.literal("personal_segment.reviewer.v1") }),
  inputSha256: z.string().regex(/^[a-f0-9]{64}$/),
  sourceSnapshots: z.array(z.object({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) })).min(1),
  cases: z.array(z.object({
    originalSegmentId: z.string().min(1), replacesSegmentIds: z.array(z.string().min(1)).min(1),
    decision: z.enum(["split", "keep", "needs_attention"]), reasonZh: z.string().min(1),
    pieces: z.array(PieceSchema).min(1),
  })).min(1),
});
export type SegmentReview = z.infer<typeof SegmentReviewSchema>;
export type RecoveredSegment = ImportSegment & {
  originalSegmentIds: string[]; answerGroupKey: string | null;
  questionText: string | null; questionTextOrigin: "source" | "missing_question_description" | null;
  part: 1 | 2 | 3 | null; reasonZh: string | null; reviewed: boolean;
};
export interface SegmentRecovery {
  id: string; importId: string; sourceSha256: string; baseSegmentsSha256: string;
  reviewSha256: string; inputSha256: string; reviewer: SegmentReview["reviewer"];
  replacesSegmentIds: string[]; segments: RecoveredSegment[];
  attempts: Array<{
    id: string; groupKey: string; questionId: string; startOffset: number; endOffset: number;
    sourceOrder: number; originalSegmentIds: string[]; segmentIds: string[];
    rawText: string; normalizedText: string; excludedTypes: string[];
  }>;
}

function fail(message: string): never { throw new Error(`切分修订拒绝：${message}`); }

export function assertSegmentCoverage(text: string, segments: ImportSegment[]) {
  let cursor = 0;
  const ids = new Set<string>();
  segments.forEach((segment, index) => {
    if (ids.has(segment.id)) fail("重复片段 ID");
    ids.add(segment.id);
    if (segment.sourceOrder !== index || segment.startOffset !== cursor || segment.endOffset <= cursor || segment.endOffset > text.length) fail("偏移不连续或越界");
    if (segment.rawText !== text.slice(cursor, segment.endOffset)) fail("原文与偏移不一致");
    cursor = segment.endOffset;
  });
  if (cursor !== text.length) fail("源文本没有完整覆盖");
}

/** 只编译独立审阅的修订；不猜题、不生成 Gap、不访问文件或网络。 */
export function compileSegmentRecovery(input: {
  importId: string; text: string; baseSegments: unknown; review: unknown;
  sourcePath: string; inputSnapshotSha256: string; reviewSha256: string;
  questions: Array<{ id: string; part: number }>;
}): SegmentRecovery | null {
  const base = z.array(ImportSegmentSchema).parse(input.baseSegments);
  assertSegmentCoverage(input.text, base);
  const review = SegmentReviewSchema.parse(input.review);
  if (review.inputSha256 !== input.inputSnapshotSha256) fail("审核输入哈希不匹配");
  const sourceHash = sha256(input.text);
  if (!review.sourceSnapshots.some((s) => s.path.replaceAll("\\", "/") === input.sourcePath.replaceAll("\\", "/") && s.sha256 === sourceHash)) fail("源快照哈希不匹配");
  if (new Set(review.cases.map((c) => c.originalSegmentId)).size !== review.cases.length) fail("重复 case");
  const relevant = review.cases.filter((c) => base.some((s) => s.id === c.originalSegmentId));
  if (!relevant.length) return null;
  const replaced = new Set<string>();
  const replacement = new Map<string, RecoveredSegment[]>();
  const questionMap = new Map(input.questions.map((q) => [q.id, q]));
  const groupOwners = new Map<string, string>();
  for (const item of relevant) {
    if (item.decision === "needs_attention") fail("仍有待确认的切分");
    if (!item.replacesSegmentIds.includes(item.originalSegmentId)) fail("替代范围不含原片段");
    const old = item.replacesSegmentIds.map((id) => base.find((s) => s.id === id) ?? fail("替代了不存在的片段"));
    if (old.some((s, i) => (i > 0 && s.sourceOrder !== old[i - 1].sourceOrder + 1) || replaced.has(s.id))) fail("替代范围重叠或不连续");
    old.forEach((s) => replaced.add(s.id));
    let cursor = old[0].startOffset;
    const end = old.at(-1)!.endOffset;
    const pieces = item.pieces.map((piece): RecoveredSegment => {
      if (piece.startOffset !== cursor || piece.endOffset <= cursor || piece.endOffset > end) fail("审核片段遗漏、重叠或越界");
      cursor = piece.endOffset;
      if (piece.type === "unclassified") fail("已审核区间仍有未分类文本");
      const isAnswer = piece.type === "answer" || piece.type === "retry_answer";
      if (isAnswer && (!piece.answerGroupKey || !piece.questionText || !piece.part)) fail("正式回答缺少分组或题目");
      if (piece.answerGroupKey && !["answer", "retry_answer", "self_comment", "asr_uncertain"].includes(piece.type)) fail("流程片段不能并入回答组");
      if (piece.questionTextOrigin === "source" && (!piece.questionText || !normalizeForMatch(input.text).includes(normalizeForMatch(piece.questionText)))) fail("声称的原题未出现在源文本");
      if (piece.questionTextOrigin === "missing_question_description" && (!piece.questionText?.includes("缺失") || /[a-z]{4}/i.test(piece.questionText.replace(/^Part\s*[123]\s*/i, "")))) fail("缺题描述不得伪造英文原题");
      let questionId = piece.questionId;
      if (questionId && (!questionMap.has(questionId) || questionMap.get(questionId)!.part !== piece.part)) fail("题目 ID 或 Part 未核验");
      if (!questionId && piece.questionText) questionId = stableId("q_personal", input.importId, piece.part, piece.questionTextOrigin, normalizeForMatch(piece.questionText));
      if (piece.type === "question" && (!questionId || !piece.part || !piece.questionText)) fail("题干缺少关联");
      if (piece.answerGroupKey) {
        const owner = groupOwners.get(piece.answerGroupKey);
        if (owner && owner !== item.originalSegmentId) fail("回答组跨越多个修订 case");
        groupOwners.set(piece.answerGroupKey, item.originalSegmentId);
      }
      return {
        id: stableId("seg_revision", input.importId, piece.startOffset, piece.endOffset, piece.type, questionId, piece.answerGroupKey),
        sourceOrder: 0, startOffset: piece.startOffset, endOffset: piece.endOffset, type: piece.type,
        rawText: input.text.slice(piece.startOffset, piece.endOffset), normalizedText: normalizeForMatch(input.text.slice(piece.startOffset, piece.endOffset)),
        questionId, matchMethod: questionId ? (piece.questionId ? "reviewer" : "personal_import") : null,
        matchConfidence: questionId ? (piece.questionTextOrigin === "missing_question_description" ? 0 : 1) : null,
        originalSegmentIds: old.filter((s) => s.startOffset < piece.endOffset && s.endOffset > piece.startOffset).map((s) => s.id),
        answerGroupKey: piece.answerGroupKey, questionText: piece.questionText, questionTextOrigin: piece.questionTextOrigin,
        part: piece.part, reasonZh: piece.reasonZh, reviewed: true,
      };
    });
    if (cursor !== end) fail("修订末尾未覆盖");
    replacement.set(old[0].id, pieces);
  }
  const segments = base.flatMap((s): RecoveredSegment[] => replacement.get(s.id) ?? (replaced.has(s.id) ? [] : [{
    ...s, originalSegmentIds: [s.id], answerGroupKey: null, questionText: null,
    questionTextOrigin: null, part: null, reasonZh: null, reviewed: false,
  }])).map((s, i) => ({ ...s, sourceOrder: i }));
  assertSegmentCoverage(input.text, segments);
  const groups = new Map<string, RecoveredSegment[]>();
  for (const segment of segments) {
    if (segment.answerGroupKey) groups.set(segment.answerGroupKey, [...(groups.get(segment.answerGroupKey) ?? []), segment]);
  }
  const attempts = [...groups.entries()].map(([groupKey, pieces]) => {
    const answers = pieces.filter((s) => s.type === "answer" || s.type === "retry_answer");
    if (!answers.length || !answers[0].questionId) fail("回答组没有正式回答");
    if (new Set(pieces.map((p) => p.questionId)).size !== 1) fail("回答组包含不同题目");
    if (pieces.some((p, i) => i > 0 && p.sourceOrder !== pieces[i - 1].sourceOrder + 1)) fail("同一回答组跨越了其他题目或指令");
    const startOffset = pieces[0].startOffset, endOffset = pieces.at(-1)!.endOffset;
    return {
      id: stableId("answer_recovered", input.importId, startOffset, endOffset, answers[0].questionId, ...answers.map((s) => s.id)),
      groupKey, questionId: answers[0].questionId, startOffset, endOffset, sourceOrder: pieces[0].sourceOrder,
      originalSegmentIds: [...new Set(pieces.flatMap((s) => s.originalSegmentIds))], segmentIds: pieces.map((s) => s.id),
      rawText: input.text.slice(startOffset, endOffset), normalizedText: normalizeTranscript(answers.map((s) => s.rawText).join(" ")),
      excludedTypes: [...new Set(pieces.filter((s) => !answers.includes(s)).map((s) => s.type))],
    };
  });
  return {
    id: stableId("import_revision", input.importId, sourceHash, input.reviewSha256), importId: input.importId,
    sourceSha256: sourceHash, baseSegmentsSha256: sha256(JSON.stringify(base)), reviewSha256: input.reviewSha256,
    inputSha256: review.inputSha256, reviewer: review.reviewer, replacesSegmentIds: [...replaced], segments, attempts,
  };
}
