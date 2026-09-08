import { sha256, type ImportSegment } from "../../src/lib/imports/personal-import";
import { compileSegmentRecovery, type SegmentReview } from "../../src/lib/imports/segment-recovery";

export function segmentRecoveryFixture(importId = "fixture-import") {
  const chunks = ["I cook. ", "[aside] ", "I bake. ", "Try again: ", "I bake daily."];
  const text = chunks.join("");
  const segment: ImportSegment = { id: `old-${importId}`, sourceOrder: 0, startOffset: 0, endOffset: text.length, type: "answer", rawText: text, normalizedText: text.toLowerCase(), questionId: "recovery-q", matchMethod: "exact", matchConfidence: 1 };
  let cursor = 0;
  const review: SegmentReview = {
    version: "segment-review-v1", reviewer: { runId: "fixture-reviewer", sessionId: "independent-fixture", promptVersion: "personal_segment.reviewer.v1" },
    inputSha256: sha256("fixture-input"), sourceSnapshots: [{ path: "fixture-source", sha256: sha256(text) }],
    cases: [{ originalSegmentId: segment.id, replacesSegmentIds: [segment.id], decision: "split", reasonZh: "合成测试：初答、插话与重答分别归类", pieces: chunks.map((chunk, index) => {
      const startOffset = cursor; cursor += chunk.length;
      return { startOffset, endOffset: cursor, type: index === 1 ? "self_comment" : index === 3 ? "instruction" : index === 4 ? "retry_answer" : "answer", questionId: index === 3 ? null : "recovery-q", questionText: index === 3 ? null : "原问句缺失：烹饪", questionTextOrigin: index === 3 ? null : "missing_question_description", part: index === 3 ? null : 1, answerGroupKey: index === 3 ? null : index === 4 ? "retry" : "initial", reasonZh: "合成分类证据" };
    }) }],
  };
  const input = { importId, text, baseSegments: [segment], review, sourcePath: "fixture-source", inputSnapshotSha256: review.inputSha256, reviewSha256: sha256(JSON.stringify(review)), questions: [{ id: "recovery-q", part: 1 }] };
  return { text, segment, review, input, compile: () => compileSegmentRecovery(input)! };
}
