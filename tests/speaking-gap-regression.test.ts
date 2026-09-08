import { beforeAll, describe, expect, it } from "vitest";
import { assertInsideTestResults, prepareTestDatabase } from "./helpers/temp-db";

const database = prepareTestDatabase("practice-gap-detection");
assertInsideTestResults(database.file);
process.env.ROASTDUCK_DB = database.url;
process.env.ROASTDUCK_SKIP_DB_BACKUP = "1";
process.env.AI_PROVIDER = "mock";

let db: Awaited<ReturnType<typeof import("@db/client").getDbReady>>;
let schema: typeof import("@db/schema");
let practiceService: typeof import("@/lib/speaking-practice/service");

const testQuestionId = "q_test_work_or_study";

beforeAll(async () => {
  schema = await import("@db/schema");
  db = await (await import("@db/client")).getDbReady();
  practiceService = await import("@/lib/speaking-practice/service");

  // Seed books and a test question
  await db.insert(schema.books).values({
    id: "book1_ielts_complete",
    titleZh: "雅思完整题库",
    titleEn: "IELTS Complete Speaking",
    sourceType: "question_bank",
  }).onConflictDoNothing();

  await db.insert(schema.questions).values({
    id: testQuestionId,
    bookId: "book1_ielts_complete",
    part: 1,
    text: "Do you work or are you a student?",
    textZh: "你是工作还是学生？",
    normText: "do you work or are you a student",
  }).onConflictDoNothing();
});

describe("IELTS Speaking Gap Detection Regression Suite (Spec Section 64)", () => {
  it("Case 1: Missing hyphen in spoken form (fourth year student) is NOT a gap", async () => {
    const attempt = await practiceService.createSpeakingAttempt({
      questionId: testQuestionId,
      mode: "practice",
      answerText: "I'm a fourth year student.",
      intendedMeaningZh: "我是大四学生。",
    });

    expect(attempt.gapCount).toBe(0);
    expect(attempt.analysis.gaps).toHaveLength(0);
  });

  it("Case 2: Natural alternative (I study computer science) is NOT a gap merely because wording differs", async () => {
    const attempt = await practiceService.createSpeakingAttempt({
      questionId: testQuestionId,
      mode: "practice",
      answerText: "I study computer science.",
      intendedMeaningZh: "我是学计算机的。",
    });

    expect(attempt.gapCount).toBe(0);
    expect(attempt.analysis.gaps).toHaveLength(0);
  });

  it("Case 3: Explicit Chinese gap (井盖) detected as gap -> manhole cover", async () => {
    const attempt = await practiceService.createSpeakingAttempt({
      questionId: testQuestionId,
      mode: "practice",
      answerText: "I saw a 井盖 on the street.",
      intendedMeaningZh: "我在路上看到了一个井盖。",
    });

    expect(attempt.gapCount).toBe(1);
    expect(attempt.analysis.gaps).toHaveLength(1);
    expect(attempt.analysis.gaps[0].targetEnglish).toBe("manhole cover");
    expect(attempt.analysis.gaps[0].intentZh).toBe("井盖");
    expect(attempt.analysis.naturalVersion).toContain("manhole cover");
  });

  it("Case 4: Detects meaningful unexpressed intentions from Chinese input", async () => {
    const attempt = await practiceService.createSpeakingAttempt({
      questionId: testQuestionId,
      mode: "practice",
      answerText: "I'm a student.",
      intendedMeaningZh: "我是大四学生，在青岛读计算机，之前从化学转到了计算机专业。",
    });

    expect(attempt.gapCount).toBe(0); // Clear preparation intentions are not confirmed mistakes.
    expect(attempt.analysis.learningTargetCount).toBeGreaterThanOrEqual(2);
    const unexpressed = attempt.analysis.gaps.find((g) => g.gapType === "unexpressed_intention");
    expect(unexpressed).toBeDefined();
    expect(attempt.analysis.learningItems.some((li) => li.targetEnglish.includes("switch majors"))).toBe(true);
  });

  it("Case 5: Exam-style mode recognizes paraphrasing without classifying as total communication failure", async () => {
    const attempt = await practiceService.createSpeakingAttempt({
      questionId: testQuestionId,
      mode: "exam_style",
      answerText: "I couldn't remember the exact word, but it's a round metal thing covering a hole in the road.",
      intendedMeaningZh: "路上有个圆形的金属盖子盖住地上的洞（井盖）。",
    });

    expect(attempt.analysis.examFeedback).not.toBeNull();
    expect(attempt.analysis.examFeedback?.paraphrasing).toContain("释义");
    expect(attempt.analysis.examFeedback?.strengths.some((s) => s.includes("Paraphrasing"))).toBe(true);
    // Gap can still be captured as useful learning material
    expect(attempt.analysis.learningItems.some((li) => li.targetEnglish === "manhole cover")).toBe(true);
  });

  it("Case 6: Capitalization differences (china university of petroleum) are NOT speaking gaps", async () => {
    const attempt = await practiceService.createSpeakingAttempt({
      questionId: testQuestionId,
      mode: "practice",
      answerText: "I study at china university of petroleum.",
      intendedMeaningZh: "我在中国石油大学读书。",
    });

    expect(attempt.gapCount).toBe(0);
    expect(attempt.analysis.gaps).toHaveLength(0);
  });

  it("Case 7: AI reference is stylistically more sophisticated -> no automatic gap", async () => {
    const attempt = await practiceService.createSpeakingAttempt({
      questionId: testQuestionId,
      mode: "practice",
      answerText: "I study computer science at university.",
      intendedMeaningZh: "我在大学读计算机科学。",
    });

    expect(attempt.gapCount).toBe(0);
    expect(attempt.analysis.gaps).toHaveLength(0);
  });

  it("Case 8: Same underlying gap appearing multiple times in one attempt counts as 1 distinct gap", async () => {
    const attempt = await practiceService.createSpeakingAttempt({
      questionId: testQuestionId,
      mode: "practice",
      answerText: "I saw a 井盖, then another 井盖, and walked around the 井盖.",
      intendedMeaningZh: "我看到一个井盖，又看到一个井盖，然后绕过了那个井盖。",
    });

    expect(attempt.gapCount).toBe(1);
    expect(attempt.analysis.gaps).toHaveLength(1);
  });
});

describe("Attempt Independence, Adaptive Cloze, and Semantic Translation Evaluation", () => {
  it("Every new attempt is independent and does not overwrite previous attempts", async () => {
    const attempt1 = await practiceService.createSpeakingAttempt({
      questionId: testQuestionId,
      mode: "practice",
      answerText: "Attempt 1 about food.",
      intendedMeaningZh: "关于食物的第一版回答。",
    });

    const attempt2 = await practiceService.createSpeakingAttempt({
      questionId: testQuestionId,
      mode: "exam_style",
      answerText: "Attempt 2 about weather.",
      intendedMeaningZh: "关于天气的第二版回答。",
    });

    expect(attempt1.id).not.toBe(attempt2.id);

    const attemptsList = await practiceService.listQuestionAttempts(testQuestionId);
    expect(attemptsList.length).toBeGreaterThanOrEqual(2);
    expect(attemptsList.some((a) => a.id === attempt1.id)).toBe(true);
    expect(attemptsList.some((a) => a.id === attempt2.id)).toBe(true);
  });

  it("Adaptive Cloze targets the detected gap and provides Chinese hint", async () => {
    const attempt = await practiceService.createSpeakingAttempt({
      questionId: testQuestionId,
      mode: "practice",
      answerText: "I saw a 井盖 on the street.",
      intendedMeaningZh: "我在街上看到了一个井盖。",
    });

    expect(attempt.analysis.clozeItems.length).toBeGreaterThanOrEqual(1);
    const cloze = attempt.analysis.clozeItems[0];
    expect(cloze.clozeSentence).toMatch(/_{4,}/);
    expect(cloze.hintZh).toBe("井盖");
    expect(cloze.answer).toBe("manhole cover");
  });

  it("Full Translation evaluates semantically and accepts valid natural alternatives", async () => {
    const attempt = await practiceService.createSpeakingAttempt({
      questionId: testQuestionId,
      mode: "practice",
      answerText: "I'm a fourth year student.",
      intendedMeaningZh: "我是大四学生。",
    });

    // Valid alternative English
    const evalResult = await practiceService.evaluateTranslation(
      attempt.id,
      "I'm in my fourth year at university.",
    );

    expect(evalResult.passed).toBe(true);
    expect(evalResult.communicatedIntention).toBe(true);
  });
});
