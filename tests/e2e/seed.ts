/** 为 Playwright 创建完全隔离、可重复的最小已审核内容库。 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const testResultsDirectory = path.resolve("test-results");
const databasePath = path.join(testResultsDirectory, "e2e.db");
if (path.dirname(databasePath) !== testResultsDirectory) throw new Error("E2E 数据库越出 test-results");
fs.mkdirSync(testResultsDirectory, { recursive: true });
// 不能删除：本机工具链把 fs.rmSync / fs.unlinkSync 重定向到回收站，在临时目录里会抛错。
// E2E 的库路径由 playwright.config.ts 写死，也不能换新文件名。
// 因此改为截断清零——SQLite 把 0 字节文件视为全新的空库。
for (const candidate of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`, `${databasePath}-journal`]) {
  fs.writeFileSync(candidate, "");
}
// libSQL 的 Windows file URL 使用项目相对路径，避免反斜杠绝对路径被解释成另一数据源。
process.env.ROASTDUCK_DB = "file:./test-results/e2e.db";
process.env.ROASTDUCK_SKIP_DB_BACKUP = "1";

const [{ getDbReady }, schema] = await Promise.all([import("../../db/client"), import("../../db/schema")]);
const db = await getDbReady();

const fixtures = [
  {
    id: "c_e2e_progress",
    display: "make steady progress",
    meaning: "取得稳定进步",
    gloss: "to improve consistently over time",
    ipa: "meɪk ˈstedi ˈprəʊɡres",
    sentence: "I make steady progress every day.",
    sentenceZh: "我每天都取得稳定进步。",
  },
  {
    id: "c_e2e_habit",
    display: "build a useful habit",
    meaning: "养成有用的习惯",
    gloss: "to develop a helpful repeated behavior",
    ipa: "bɪld ə ˈjuːsfəl ˈhæbɪt",
    sentence: "I build a useful habit by reading nightly.",
    sentenceZh: "我通过每晚阅读来养成有用的习惯。",
  },
  {
    id: "c_e2e_focus",
    display: "stay focused",
    meaning: "保持专注",
    gloss: "to keep your attention on the task",
    ipa: "steɪ ˈfəʊkəst",
    sentence: "I stay focused when I silence notifications.",
    sentenceZh: "我把通知静音时能保持专注。",
  },
] as const;

await db.insert(schema.books).values({
  id: "book_e2e",
  titleZh: "E2E 句子先行词书",
  titleEn: "E2E Sentence-first Book",
  sourceType: "question_bank",
  descriptionZh: "只用于自动化测试，不属于产品内容。",
  contentVersion: "e2e-v1",
  status: "beta",
  defaultAccent: "en-GB",
});
await db.insert(schema.topics).values({
  id: "topic_e2e_habits",
  bookId: "book_e2e",
  nameZh: "学习习惯",
  nameEn: "Study habits",
  ieltsPart: 1,
  domainsJson: JSON.stringify([{ domainId: "routine", nameZh: "日常习惯", nameEn: "routine" }]),
  status: "audited",
});
await db.insert(schema.questions).values({
  id: "question_e2e_habits",
  bookId: "book_e2e",
  topicId: "topic_e2e_habits",
  part: 1,
  text: "What helps you study effectively?",
  textZh: "什么能帮助你高效学习？",
  normText: "what helps you study effectively",
  status: "audited",
  blueprintJson: JSON.stringify([{ dimId: "routine", dimZh: "习惯", dimEn: "routine" }]),
  sourceRefsJson: JSON.stringify(["e2e-fixture"]),
});
await db.insert(schema.questionSetLinks).values({
  questionId: "question_e2e_habits",
  questionSetId: "qs_2026_01_04",
  sourceSlug: "part1_new_2026q1",
  sourceFile: "Part1新题.pdf",
  sourcePage: 8,
});

for (let index = 0; index < fixtures.length; index += 1) {
  const fixture = fixtures[index];
  const exampleId = `example_${fixture.id}`;
  await db.insert(schema.chunks).values({
    id: fixture.id,
    bookId: "book_e2e",
    canonicalChunk: fixture.display,
    displayChunk: fixture.display,
    unitType: "lexical_chunk",
    meaningZh: fixture.meaning,
    englishGloss: fixture.gloss,
    pattern: `${fixture.display} + context`,
    topicId: "topic_e2e_habits",
    ieltsPart: 1,
    qualityStatus: "approved",
    reviewProvenance: "human_reviewer",
    reviewerVersion: "e2e-fixture-v1",
    reviewedAt: "2026-08-30T00:00:00.000Z",
    contentVersion: "e2e-v1",
    createdAt: `2026-08-30T00:00:0${index}.000Z`,
  });
  await db.insert(schema.chunkExamples).values({
    id: exampleId,
    chunkId: fixture.id,
    textEn: fixture.sentence,
    textZh: fixture.sentenceZh,
    sourceRef: "E2E generated fixture",
    questionIdsJson: JSON.stringify(["question_e2e_habits"]),
    contextType: "generated_ielts",
    generated: 1,
  });
  await db.insert(schema.chunkPronunciations).values({
    id: `pronunciation_${fixture.id}`,
    chunkId: fixture.id,
    ipa: fixture.ipa,
    accent: "en-GB",
    source: "e2e-fixture",
    isPrimary: 1,
  });
  await db.insert(schema.chunkTopicLinks).values({
    chunkId: fixture.id,
    topicId: "topic_e2e_habits",
    relation: "coverage",
    isPrimary: 1,
  });
  await db.insert(schema.chunkQuestionLinks).values({
    chunkId: fixture.id,
    questionId: "question_e2e_habits",
    relation: "coverage",
    answerDimensionId: "routine",
  });
  await db.insert(schema.chunkSources).values({
    id: `source_${fixture.id}`,
    chunkId: fixture.id,
    sourceType: "question_bank",
    bookId: "book_e2e",
    questionId: "question_e2e_habits",
    sourceContext: "E2E generated fixture",
  });
}

type AnnotationInput = typeof schema.textAnnotations.$inferInsert;
type LexemeInput = typeof schema.lexemes.$inferInsert;
const annotationRows: AnnotationInput[] = [];
const lexemeRows = new Map<string, LexemeInput>();

function shortHash(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 12);
}

function annotate(contentType: "example" | "question", contentId: string, text: string, target?: typeof fixtures[number]) {
  const phraseStart = target ? text.toLowerCase().indexOf(target.display.toLowerCase()) : -1;
  const phraseEnd = phraseStart >= 0 && target ? phraseStart + target.display.length : -1;
  if (target && phraseStart >= 0) {
    annotationRows.push({
      id: `annotation_${shortHash(`${contentType}|${contentId}|${phraseStart}|${phraseEnd}`)}`,
      contentType,
      contentId,
      startOffset: phraseStart,
      endOffset: phraseEnd,
      surface: text.slice(phraseStart, phraseEnd),
      chunkId: target.id,
      meaningZh: target.meaning,
      ipa: target.ipa,
      accent: "en-GB",
    });
  }

  for (const match of text.matchAll(/[A-Za-z]+(?:['’][A-Za-z]+)?/g)) {
    const start = match.index;
    const end = start + match[0].length;
    if (phraseStart >= 0 && start >= phraseStart && end <= phraseEnd) continue;
    const normalized = match[0].toLowerCase().replace("’", "'");
    const lexemeId = `lexeme_${shortHash(normalized)}`;
    lexemeRows.set(lexemeId, {
      id: lexemeId,
      surface: match[0],
      normalized,
      lemma: normalized,
      meaningZh: `测试词义：${normalized}`,
      accent: "en-GB",
      source: "e2e-fixture",
      status: "verified",
    });
    annotationRows.push({
      id: `annotation_${shortHash(`${contentType}|${contentId}|${start}|${end}`)}`,
      contentType,
      contentId,
      startOffset: start,
      endOffset: end,
      surface: match[0],
      lexemeId,
      meaningZh: `测试词义：${normalized}`,
      accent: "en-GB",
    });
  }
}

for (const fixture of fixtures) annotate("example", `example_${fixture.id}`, fixture.sentence, fixture);
annotate("question", "question_e2e_habits", "What helps you study effectively?");
for(const questionId of ["light-e2e-new","light-e2e-review","light-e2e-recovery","light-e2e-weak"]) annotate("question",questionId,"What would you like to do?");
await db.insert(schema.lexemes).values([...lexemeRows.values()]);
await db.insert(schema.textAnnotations).values(annotationRows);

console.log(`E2E 隔离数据库已创建：${path.relative(process.cwd(), databasePath)}（${fixtures.length} 个已审核测试 Chunk）`);

// 轻学习使用独立合成题目；不复制私人答案、不调用Runtime。
const { publishLightFixture } = await import("../helpers/light-material");
for (const [index,[target,meaning]] of [["brush my teeth","刷牙"],["rinse my mouth","漱口"],["wipe the table","擦桌子"],["turn off the light","关灯"],["make my bed","整理床铺"]].entries()) {
  await publishLightFixture(db,`light-e2e-new-${index}`,target,meaning,"light-e2e-new");
}
for (const [index,[target,meaning]] of [["take a shower","洗澡"],["put on sunscreen","涂防晒"],["change my mind","改变主意"],["catch a train","赶上火车"],["miss the bus","错过公交车"]].entries()) {
  await publishLightFixture(db,`light-e2e-weak-${index}`,target,meaning,"light-e2e-weak");
}
for (const [index,[target,meaning]] of [["take a break","休息一下"],["wash my hands","洗手"],["charge my phone","给手机充电"]].entries()) {
  await publishLightFixture(db,`light-e2e-review-${index}`,target,meaning,"light-e2e-review");
}
const light = await import("../../src/lib/light-study/service");
// Old-enough real self-rating fixture: do not assume all first ratings have a 24h interval.
const earlier = new Date(Date.now()-14*86400000);
await publishLightFixture(db,"light-e2e-recovery-0","make an appointment","预约","light-e2e-recovery");
let introduction = await light.createLightSession({scope:{type:"question",id:"light-e2e-review"},mode:"learn",clientRequestId:"e2e-seed-exposure"},earlier);
while(introduction.status==="active") {
  introduction=await light.applyLightEvent(introduction.id,{type:"reveal",clientEventId:`e2e-seed-show-${introduction.index}`,version:introduction.version},earlier);
  introduction=await light.applyLightEvent(introduction.id,{type:"rate",rating:"remembered",clientEventId:`e2e-seed-next-${introduction.index}`,version:introduction.version},earlier);
}
let recoveryIntro=await light.createLightSession({scope:{type:"question",id:"light-e2e-recovery"},mode:"learn",clientRequestId:"e2e-seed-recovery"},earlier);
recoveryIntro=await light.applyLightEvent(recoveryIntro.id,{type:"reveal",clientEventId:"e2e-seed-recovery-show",version:recoveryIntro.version},earlier);
if((await light.applyLightEvent(recoveryIntro.id,{type:"rate",rating:"remembered",clientEventId:"e2e-seed-recovery-next",version:recoveryIntro.version},earlier)).status!=="completed")throw new Error("恢复夹具未完成初次接触");
const lightOverview = await light.lightOverview({type:"all"});
if(lightOverview.totalCount!==14 || lightOverview.newCount!==10 || lightOverview.dueCount!==4) throw new Error("轻学习E2E夹具未完整准备");
console.log("轻学习隔离材料已核验：14项，其中10项新学、4项到期；Runtime调用0。");
