import { beforeAll, expect,it } from "vitest";
import { sql } from "drizzle-orm";
import { createClient } from "@libsql/client";
import { prepareTestDatabase } from "../helpers/temp-db";
import type { SourceRevision } from "@/lib/four-step/source-revisions";
import type { RecoverySource } from "@/lib/four-step/offline-contracts";
const temp=prepareTestDatabase("practice-source-recovery");
process.env.ROASTDUCK_DB=temp.url;process.env.ROASTDUCK_SKIP_DB_BACKUP="1";process.env.AI_PROVIDER="mock";
const raw="I like tea.Next question.I prefer coffee.";
const source:RecoverySource={key:"mixed-parent",kind:"personal_answer",createdAt:"2026-01-01T00:00:00Z",questionId:"split-q",questionEn:"What do you like?",questionZh:"喜欢什么？",part:1,english:raw,chinese:"",mode:"practice",index:0,hash:"source-fixture",en:[],zh:[]};
const review:SourceRevision={sourceIndex:0,sourceHash:source.hash,generatorContext:"test-generator",reviewerContext:"test-reviewer",reasonZh:"合成同题两次回答，源次序保留",pieces:[
  {start:0,end:11,kind:"answer",questionId:source.questionId,questionEn:source.questionEn,reasonZh:"首次"},
  {start:11,end:25,kind:"instruction",questionId:null,questionEn:null,reasonZh:"流程指令"},
  {start:25,end:raw.length,kind:"retry_answer",questionId:source.questionId,questionEn:source.questionEn,reasonZh:"后来回答"},
]};
let db:Awaited<ReturnType<typeof import("@db/client").getDbReady>>;
let compileSourceRevision:typeof import("@/lib/four-step/source-revisions").compileSourceRevision;
let applySourceRevision:typeof import("@/lib/four-step/source-revisions").applySourceRevision;
beforeAll(async()=>{
  ({compileSourceRevision,applySourceRevision}=await import("@/lib/four-step/source-revisions"));
  db=await(await import("@db/client")).getDbReady();
  const schema=await import("@db/schema");
  await db.insert(schema.questions).values({id:source.questionId,bookId:"retired",part:1,text:source.questionEn,textZh:source.questionZh,normText:"split-q"});
  await db.insert(schema.personalAnswers).values({id:source.key,questionId:source.questionId,inputLanguage:"en",rawText:raw,status:"ready",sourceSegmentId:"original-segment",createdAt:source.createdAt});
});
it("切分保持原文和两次真实顺序；旧链接能回看并进入各子回答，重复应用幂等",async()=>{
  const result=await applySourceRevision(source,review);
  expect(result.children).toHaveLength(2);
  expect((await applySourceRevision(source,review)).reused).toBe(true);
  const parent=(await db.all<{raw_text:string;superseded_by_revision_id:string}>(sql`SELECT * FROM personal_answers WHERE id=${source.key}`))[0];
  expect(parent.raw_text).toBe(raw);expect(parent.superseded_by_revision_id).toBe(result.id);
  const children=await db.all<{raw_text:string;created_at:string}>(sql`SELECT * FROM personal_answers WHERE source_revision_id=${result.id} ORDER BY source_order`);
  expect(children.map(c=>c.raw_text)).toEqual([raw.slice(0,11),raw.slice(25)]);
  expect(children.every(c=>c.created_at===source.createdAt)).toBe(true);
  const view=await(await import("@/lib/answers/service")).getPersonalAnswer(source.key);
  expect(view?.recovery?.replacements.map(c=>c.id)).toEqual(result.children);
  const activity=await(await import("@/lib/questions/activity")).getQuestionActivity(source.questionId);
  expect(activity).toMatchObject({totalAnswerCount:2,latestAnswerId:result.children[1]});
  expect(await db.all(sql`SELECT * FROM ai_runs`)).toHaveLength(0);
  expect(await db.all(sql`SELECT * FROM learning_item_schedule`)).toHaveLength(0);
});
it("漏字符、重叠、同上下文审核、不存在的题目和源漂移都不能应用",async()=>{
  expect(()=>compileSourceRevision(source,{...review,pieces:review.pieces.slice(1)})).toThrow("遗漏");
  expect(()=>compileSourceRevision(source,{...review,reviewerContext:review.generatorContext})).toThrow("独立");
  expect(()=>compileSourceRevision(source,{...review,sourceHash:"changed"})).toThrow("来源");
  const second={...source,key:"second-parent"};
  await db.run(sql`INSERT INTO personal_answers(id,question_id,input_language,raw_text,status) VALUES(${second.key},${source.questionId},'en',${raw},'ready')`);
  await expect(applySourceRevision(second,{...review,pieces:review.pieces.map(p=>p.questionId?{...p,questionId:"missing"}:p)})).rejects.toThrow("题目");
  expect(await db.all(sql`SELECT * FROM practice_source_revisions WHERE parent_answer_id=${second.key}`)).toHaveLength(0);
});
it("纯题目/指令归档不冒充已完成学习；没有实际回答时不生成子回答",async()=>{
  const noAnswer={...source,key:"question-list",english:"What do you like?",hash:"no-answer"};
  await db.run(sql`INSERT INTO personal_answers(id,question_id,input_language,raw_text,status) VALUES(${noAnswer.key},${source.questionId},'en',${noAnswer.english},'ready')`);
  const result=await applySourceRevision(noAnswer,{...review,sourceHash:noAnswer.hash,pieces:[{start:0,end:noAnswer.english.length,kind:"non_answer",questionId:null,questionEn:null,reasonZh:"只有题目没有回答"}]});
  expect(result.children).toHaveLength(0);
  expect((await(await import("@/lib/questions/activity")).getQuestionActivity(source.questionId))?.totalAnswerCount).toBe(3);
});
it("只读审计能检出切分子原文漂移",async()=>{
  const client=createClient({url:temp.url});
  try{
    const {auditSourceRevisions}=await import("@/lib/four-step/source-audit");
    expect(await auditSourceRevisions(client)).toMatchObject({ok:true,checked:2,children:2,nonAnswerParents:1});
    const child=compileSourceRevision(source,review).children[0];
    await db.run(sql`UPDATE personal_answers SET raw_text='changed' WHERE id=${child.id}`);
    expect((await auditSourceRevisions(client)).failures).toContainEqual({id:compileSourceRevision(source,review).id,reason:"child_original_changed"});
  }finally{client.close();}
});
