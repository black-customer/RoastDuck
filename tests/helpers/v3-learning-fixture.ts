import { createHash } from "node:crypto";
import { getDbReady } from "../../db/client";
import * as schema from "../../db/schema";
import { newCard } from "../../src/lib/learning/fsrs";

export const V3_E2E = {
  questionId: "question_e2e_v3",
  chunkId: "c_e2e_v3",
  answerId: "answer_e2e_v3",
  gapId: "answer_gap_e2e_v3",
  target: "I keep making steady progress every day.",
} as const;

function shortHash(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 12);
}

/**
 * 只在 V3 用例启动时注入，避免个人回答改变首页、V2 每日队列和既有口语题状态。
 * 独立 Chunk 预置为已介绍但未到期；按题队列仍可通过未完成的学习单位装载它。
 */
export async function seedV3LearningFixture(): Promise<void> {
  const db = await getDbReady();
  await db.insert(schema.questions).values({
    id: V3_E2E.questionId,
    bookId: "book_e2e",
    topicId: "topic_e2e_habits",
    part: 1,
    text: "How do you know your English is improving?",
    textZh: "你怎么知道自己的英语在进步？",
    normText: "how do you know your english is improving",
    status: "audited",
    blueprintJson: JSON.stringify([{ dimId: "progress", dimZh: "进步", dimEn: "progress" }]),
    sourceRefsJson: JSON.stringify(["e2e-v3-fixture"]),
  }).onConflictDoNothing();
  await db.insert(schema.questionSetLinks).values({
    questionId: V3_E2E.questionId,
    questionSetId: "qs_2026_01_04",
    sourceSlug: "part1_new_2026q1",
    sourceFile: "Part1新题.pdf",
    sourcePage: 9,
  }).onConflictDoNothing();

  await db.insert(schema.chunks).values({
    id: V3_E2E.chunkId,
    bookId: "book_e2e",
    canonicalChunk: "keep making steady progress",
    displayChunk: "keep making steady progress",
    unitType: "lexical_chunk",
    meaningZh: "取得稳定进步",
    englishGloss: "to improve consistently over time",
    pattern: "keep making steady progress + time expression",
    topicId: "topic_e2e_habits",
    ieltsPart: 1,
    qualityStatus: "approved",
    reviewProvenance: "human_reviewer",
    reviewerVersion: "e2e-v3-fixture-v1",
    reviewedAt: "2026-09-04T00:00:00.000Z",
    contentVersion: "e2e-v3",
    createdAt: "2026-09-04T00:00:00.000Z",
  }).onConflictDoNothing();
  await db.insert(schema.chunkExamples).values({
    id: "example_c_e2e_v3",
    chunkId: V3_E2E.chunkId,
    textEn: V3_E2E.target,
    textZh: "我每天都取得稳定进步。",
    sourceRef: "E2E V3 generated fixture",
    questionIdsJson: JSON.stringify([V3_E2E.questionId]),
    contextType: "generated_ielts",
    generated: 1,
  }).onConflictDoNothing();
  await db.insert(schema.chunkPronunciations).values({
    id: "pronunciation_c_e2e_v3",
    chunkId: V3_E2E.chunkId,
    ipa: "kiːp ˈmeɪkɪŋ ˈstedi ˈprɑːɡres",
    accent: "en-US",
    source: "e2e-v3-fixture",
    isPrimary: 1,
  }).onConflictDoNothing();
  await db.insert(schema.chunkTopicLinks).values({
    chunkId: V3_E2E.chunkId,
    topicId: "topic_e2e_habits",
    relation: "coverage",
    isPrimary: 1,
  }).onConflictDoNothing();
  await db.insert(schema.chunkQuestionLinks).values({
    chunkId: V3_E2E.chunkId,
    questionId: V3_E2E.questionId,
    relation: "coverage",
    answerDimensionId: "progress",
  }).onConflictDoNothing();
  await db.insert(schema.chunkSources).values({
    id: "source_c_e2e_v3",
    chunkId: V3_E2E.chunkId,
    sourceType: "question_bank",
    bookId: "book_e2e",
    questionId: V3_E2E.questionId,
    sourceContext: "E2E V3 generated fixture",
  }).onConflictDoNothing();
  await db.insert(schema.learningProgress).values({
    chunkId: V3_E2E.chunkId,
    fsrsJson: JSON.stringify(newCard()),
    mastery: "familiar",
    introDone: 1,
  }).onConflictDoNothing();

  await db.insert(schema.personalAnswers).values({
    id: V3_E2E.answerId,
    questionId: V3_E2E.questionId,
    inputLanguage: "en",
    rawText: "I make progress every day.",
    status: "ready",
    currentVersionId: "answer_version_e2e_v3",
    sourceKind: "historical_import",
  }).onConflictDoNothing();
  await db.insert(schema.answerVersions).values({
    id: "answer_version_e2e_v3",
    answerId: V3_E2E.answerId,
    versionNo: 1,
    kind: "normalized_transcript",
    textEn: "I make progress every day.",
  }).onConflictDoNothing();
  await db.insert(schema.gapClusters).values({
    id: "gap_cluster_e2e_v3",
    canonicalKey: "steady_progress_e2e",
    titleZh: "稳定取得进步",
    gapType: "lexical_gap",
  }).onConflictDoNothing();
  await db.insert(schema.answerGaps).values({
    id: V3_E2E.gapId,
    answerId: V3_E2E.answerId,
    answerVersionId: "answer_version_e2e_v3",
    clusterId: "gap_cluster_e2e_v3",
    gapType: "lexical_gap",
    evidenceText: "make progress",
    intentZh: "表达自己每天都在稳定进步",
    recommendedExpression: V3_E2E.target,
    explanationZh: "steady 让进步的持续性更明确。",
    confidence: 1,
    impactLevel: "medium",
    reviewerDecision: "approved",
    reviewerReason: "E2E 独立审核夹具",
    reviewerRunId: "e2e-gap-reviewer",
    learningFit: true,
    status: "open",
  }).onConflictDoNothing();
  await db.insert(schema.questionLearningUnits).values({
    id: "question_learning_unit_e2e_v3",
    questionId: V3_E2E.questionId,
    gapId: V3_E2E.gapId,
    chunkId: V3_E2E.chunkId,
    requirement: "required",
    priority: 100,
    source: "historical_answer_gap",
    status: "active",
  }).onConflictDoNothing();
  await db.insert(schema.learningExperimentAssignments).values({
    experimentId: "gap_retrieval_v3",
    chunkId: V3_E2E.chunkId,
    gapId: V3_E2E.gapId,
    questionId: V3_E2E.questionId,
    status: "active",
  }).onConflictDoNothing();

  const annotations: Array<typeof schema.textAnnotations.$inferInsert> = [];
  const lexemes = new Map<string, typeof schema.lexemes.$inferInsert>();
  const annotate = (contentType: "example" | "scenario_line", contentId: string, text: string) => {
    const phraseStart = text.toLowerCase().indexOf("keep making steady progress");
    const phraseEnd = phraseStart < 0 ? -1 : phraseStart + "keep making steady progress".length;
    if (phraseStart >= 0) annotations.push({
      id: `annotation_v3_${shortHash(`${contentType}|${contentId}|${phraseStart}|${phraseEnd}`)}`,
      contentType, contentId, startOffset: phraseStart, endOffset: phraseEnd,
      surface: text.slice(phraseStart, phraseEnd), chunkId: V3_E2E.chunkId,
      meaningZh: "持续取得稳定进步", ipa: "kiːp ˈmeɪkɪŋ ˈstedi ˈprɑːɡres", accent: "en-US",
    });
    for (const match of text.matchAll(/[A-Za-z]+(?:['’][A-Za-z]+)?/g)) {
      const start = match.index, end = start + match[0].length;
      if (phraseStart >= 0 && start >= phraseStart && end <= phraseEnd) continue;
      const normalized = match[0].toLowerCase().replace("’", "'");
      const lexemeId = `lexeme_v3_${shortHash(normalized)}`;
      lexemes.set(lexemeId, {
        id: lexemeId, surface: match[0], normalized, lemma: normalized,
        meaningZh: `测试词义：${normalized}`, accent: "en-US", source: "e2e-v3-fixture", status: "verified",
      });
      annotations.push({
        id: `annotation_v3_${shortHash(`${contentType}|${contentId}|${start}|${end}`)}`,
        contentType, contentId, startOffset: start, endOffset: end, surface: match[0], lexemeId,
        meaningZh: `测试词义：${normalized}`, accent: "en-US",
      });
    }
  };

  annotate("example", "example_c_e2e_v3", V3_E2E.target);
  for (const scenario of [
    { id: "scenario_e2e_v3_common", kind: "common_usage", setting: "同事午休时聊最近的学习计划", relationship: "同事", purpose: "说明自己每天都在稳定进步", lead: "How is your learning going?", leadZh: "你最近学得怎么样？", leadSpeaker: "Maya", targetSpeaker: "Leo" },
    { id: "scenario_e2e_v3_repair", kind: "question_repair", setting: "回答英语进步的雅思口语题", relationship: "考官与考生", purpose: "说明日常练习带来稳定进步", lead: "How do you know your English is improving?", leadZh: "你怎么知道自己的英语在进步？", leadSpeaker: "Examiner", targetSpeaker: "Candidate" },
  ] as const) {
    await db.insert(schema.learningScenarios).values({
      id: scenario.id, chunkId: V3_E2E.chunkId, questionId: V3_E2E.questionId, gapId: V3_E2E.gapId,
      scenarioKind: scenario.kind, settingZh: scenario.setting, relationshipZh: scenario.relationship,
      purposeZh: scenario.purpose, register: "neutral", accent: "en-US", isGenerated: true,
      reviewDecision: "approved", reviewReason: "E2E 独立语境审核夹具", reviewerRunId: `e2e-scenario-reviewer-${scenario.kind}`,
    }).onConflictDoNothing();
    const promptId = `${scenario.id}_prompt`, targetId = `${scenario.id}_target`;
    await db.insert(schema.learningScenarioLines).values([
      { id: promptId, scenarioId: scenario.id, lineOrder: 0, speaker: scenario.leadSpeaker, textEn: scenario.lead, textZh: scenario.leadZh, isTarget: false, annotationStatus: "complete" },
      { id: targetId, scenarioId: scenario.id, lineOrder: 1, speaker: scenario.targetSpeaker, textEn: V3_E2E.target, textZh: "我每天都在稳定进步。", isTarget: true, annotationStatus: "complete" },
    ]).onConflictDoNothing();
    annotate("scenario_line", promptId, scenario.lead);
    annotate("scenario_line", targetId, V3_E2E.target);
  }
  await db.insert(schema.lexemes).values([...lexemes.values()]).onConflictDoNothing();
  await db.insert(schema.textAnnotations).values(annotations).onConflictDoNothing();
}
