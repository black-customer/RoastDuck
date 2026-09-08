/* eslint-disable @typescript-eslint/no-explicit-any -- 合成故障注入覆盖非法持久状态与事件，不用于生产类型。 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { prepareTestDatabase } from './helpers/temp-db';

process.env.ROASTDUCK_DB = prepareTestDatabase('review-remediation').url;
process.env.ROASTDUCK_SKIP_DB_BACKUP = '1';
process.env.AI_PROVIDER = 'mock';
process.env.ROASTDUCK_QUEUE_DIR = path.resolve('test-results/remediation-queue-'+randomUUID());
process.env.ROASTDUCK_AGENT_WORK_DIR = path.resolve('test-results/remediation-agent-'+randomUUID());
let db: any, s: any, session: any, progress: any, processor: any;
const a = 'c_aaaaaaaaaaaa', b = 'c_bbbbbbbbbbbb';
const personalBook = 'book_personal_ielts_answers';
beforeAll(async () => {
  s = await import('@db/schema');
  db = await (await import('@db/client')).getDbReady();
  session = await import('@/lib/learning/session-service');
  progress = await import('@/lib/learning/progress');
  processor = await import('@/lib/answers/processor');
});
beforeEach(async () => {
  for (const table of ['learning_round_settlements','chunk_sources','content_amendments','learning_events','learning_sessions','review_log','learning_progress','question_learning_units','learning_scenario_lines','learning_scenarios','personal_chunk_links','personal_answer_sentences','personal_answers','answer_versions','chunk_examples','chunk_pronunciations','chunk_question_links','chunks','questions','topics']) await db.run(sql.raw(`DELETE FROM ${table}`));
  await db.insert(s.userSettings).values({id:1}).onConflictDoNothing();
  await db.update(s.userSettings).set({dailyNewTarget:20,dailyReviewCap:100,personalNewRatio:0.4,autoCollectDifficulties:false});
  await db.insert(s.books).values({id:'review_book',titleZh:'测试',titleEn:'Review test',sourceType:'question_bank'}).onConflictDoNothing();
  await db.insert(s.questions).values({id:'review_question',bookId:'review_book',part:1,text:'How do you study?',normText:'how do you study',textZh:'你如何学习？'});
});
async function chunk(id=a, bookId='review_book', createdAt='2026-01-01T00:00:00.000Z') {
  await db.insert(s.chunks).values({id,bookId,displayChunk:'make steady progress',canonicalChunk:`make steady progress ${id}`,unitType:'lexical_chunk',meaningZh:'稳步进步',englishGloss:'to improve steadily',qualityStatus:'approved',reviewProvenance:'independent_reviewer',reviewerVersion:'review-fixture',createdAt});
  await db.insert(s.chunkExamples).values({id:`ce_${id}`,chunkId:id,textEn:'I make steady progress every day.',textZh:'我每天稳步进步。',generated:1,contextType:'generated_ielts'});
  await db.insert(s.chunkQuestionLinks).values({chunkId:id,questionId:'review_question'});
  if(bookId===personalBook){
    const answerId=`review_answer_${id}`,versionId=`review_version_${id}`,sentenceId=`review_sentence_${id}`;
    await db.insert(s.personalAnswers).values({id:answerId,questionId:'review_question',inputLanguage:'en',rawText:'I make steady progress every day.',status:'ready',currentVersionId:versionId});
    await db.insert(s.answerVersions).values({id:versionId,answerId,versionNo:1,kind:'raw',textEn:'I make steady progress every day.'});
    await db.insert(s.personalAnswerSentences).values({id:sentenceId,answerId,answerVersionId:versionId,questionId:'review_question',sentenceIndex:0,textEn:'I make steady progress every day.'});
    await db.insert(s.personalChunkLinks).values({chunkId:id,answerId,sentenceId,origin:'personal',status:'active',generatorRunId:'review_gen',reviewerRunId:'review_reviewer'});
  }
}
async function reachPractice(id: string) {
  await db.insert(s.learningSessions).values({id,sessionDate:'2026-09-03',mode:'learn',queueJson:JSON.stringify([a]),step:'context_audio_input',experienceVersion:'context_audio_v2',scopeType:'question',scopeId:'review_question'});
  const events = [
    {type:'mark_audio_heard',playback:'played'}, {type:'rate_comprehension',rating:'understood'},
    {type:'continue_to_chunk'},{type:'continue_to_shadowing'},
    {type:'complete_shadowing',attempts:1,microphoneMode:'recorded',fallbackReason:null},
    {type:'complete_contextual_recall',attempts:1,microphoneMode:'recorded',fallbackReason:null},
  ];
  let v: any;
  for (const event of events) v=await session.applySessionEvent(id,{...event,clientEventId:randomUUID()});
  return v;
}
it('回归：完成整轮后按题学习项记录首轮完成时间',async()=>{
  await chunk();
  await db.insert(s.questionLearningUnits).values({id:'review_unit',questionId:'review_question',chunkId:a,source:'review_fixture',status:'active'});
  const id=randomUUID(),v=await reachPractice(id);
  await session.applySessionEvent(id,{type:'submit_practice',clientEventId:randomUUID(),stepVersion:v.step.stepVersion,practiceId:v.step.practice.id,answer:'make steady progress'});
  await session.applySessionEvent(id,{type:'continue_outcome',clientEventId:randomUUID()});
  await session.applySessionEvent(id,{type:'continue_scheduled',clientEventId:randomUUID()});
  expect((await db.select().from(s.learningProgress))[0].introDone).toBe(1);
  expect((await db.select().from(s.questionLearningUnits))[0].firstRoundCompletedAt).not.toBeNull();
  expect((await session.createOrResumeSession({ mode: 'learn', scope: 'question', questionId: 'review_question', restart: true })).status).toBe('completed');
});
it('回归：并发提交同一步骤的正确答案只写一次复习结算日志',async()=>{
  await chunk();
  const id=randomUUID(),v=await reachPractice(id);
  const event={type:'submit_practice',stepVersion:v.step.stepVersion,practiceId:v.step.practice.id,answer:'make steady progress'};
  const results=await Promise.allSettled([session.applySessionEvent(id,{...event,clientEventId:randomUUID()}),session.applySessionEvent(id,{...event,clientEventId:randomUUID()})]);
  const logs=await db.select().from(s.reviewLog);
  expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
  expect(logs).toHaveLength(1);
});
it('回归：个人编辑撤销审核资格并退出队列',async()=>{
  await chunk(a,personalBook);
  await processor.updatePersonalChunk(a,{display:'I is very happy',meaningZh:'新的未审核内容'});
  const row=(await db.select().from(s.chunks))[0];
  expect(row.qualityStatus).toBe('pending_review');
  expect(row.reviewerVersion).toBeNull();
  expect(await db.select().from(s.contentAmendments)).toHaveLength(1);
  expect((await progress.getTodayQueue()).fresh).not.toContain(a);
});
it('回归：隐藏个人关联后词书消失，新学队列也不包含该项',async()=>{
  await chunk(a,personalBook);
  await db.insert(s.questionLearningUnits).values({ id: 'hidden_unit', questionId: 'review_question', chunkId: a, source: 'synthetic', status: 'active' });
  await processor.hidePersonalChunk(a);
  expect((await processor.listPersonalBook()).items).toHaveLength(0);
  expect((await progress.getTodayQueue()).fresh).not.toContain(a);
  expect((await db.select().from(s.questionLearningUnits))[0].status).toBe('hidden');
  expect((await session.createOrResumeSession({ mode: 'learn', scope: 'question', questionId: 'review_question', restart: true })).status).toBe('completed');
});
it('回归：较早公共 Chunk 超过预取窗口时仍保留个人配额',async()=>{
  await db.update(s.userSettings).set({dailyNewTarget:2,personalNewRatio:0.5});
  for(let i=0;i<16;i++) await chunk(`c_old_${i}`);
  await chunk(a,personalBook,'2026-09-01T00:00:00.000Z');
  const queue=await progress.getTodayQueue();
  expect(queue.fresh).toHaveLength(2);
  expect(queue.fresh).toContain(a);
});
it('回归：当天已达到新学数量后不再提供新学额度',async()=>{
  await db.update(s.userSettings).set({dailyNewTarget:1});
  await chunk(a); await chunk(b);
  await progress.applyLearningOutcome(a,'good',{sessionId:'already-learned',comprehension:'understood',errors:0,assists:0,shadowingAttempts:1,microphoneMode:'recorded',skills:{}});
  expect((await progress.getTodayQueue()).fresh).toHaveLength(0);
});
it('回归：进程中断遗留 pending 消息，租约过期后显式重试恢复',async()=>{
  const speaking=await import('@/lib/speaking/service');
  const created=await speaking.createSpeakingSession({clientRequestId:randomUUID(),questionId:'review_question',answerId:null});
  const clientMessageId=randomUUID(),text='I make steady progress every day.';
  await db.insert(s.companionMessages).values({id:randomUUID(),threadId:created.companionThreadId!,sequenceNo:10,role:'user',messageKind:'text',text,inputLanguage:'en',status:'pending',clientMessageId,sourceType:'speaking_session',sourceId:created.id,metadataJson:JSON.stringify({deliveryAttempt:1,leaseExpiresAt:'2026-01-01T00:00:00.000Z',speakingSessionId:created.id}),createdAt:'2026-01-01T00:00:00.000Z'});
  await db.update(s.speakingSessions).set({status:'teacher_responding',updatedAt:'2026-01-01T00:00:00.000Z'}).where(eq(s.speakingSessions.id,created.id));
  await speaking.sendSpeakingMessage(created.id,{clientMessageId,text,inputLanguage:'en',messageKind:'text',retry:true});
  expect((await speaking.getSpeakingSession(created.id))!.status).toBe('conversing');
});
it('回归：重试已完成的回答处理保留 ready 状态',async()=>{
  const service=await import('@/lib/answers/service');
  const clientRequestId=randomUUID(),input={clientRequestId,questionId:'review_question',inputLanguage:'en' as const,rawText:'I stay focused.'};
  const created=await service.createPersonalAnswer(input);
  const first=await processor.processPersonalAnswer(created.answer!.id,clientRequestId,true,{compilePersonalChunks:false});
  expect(first.status).toBe('ready');
  await service.createPersonalAnswer(input);
  const second=await processor.processPersonalAnswer(created.answer!.id,clientRequestId,true,{compilePersonalChunks:false});
  expect(second.status).toBe('ready');
  expect(second.currentVersionId).toBe(first.currentVersionId);
});
it('回归：老师正常回复后仍可展开提示',async()=>{
  const speaking=await import('@/lib/speaking/service');
  const created=await speaking.createSpeakingSession({clientRequestId:randomUUID(),questionId:'review_question',answerId:null});
  const answered=await speaking.sendSpeakingMessage(created.id,{clientMessageId:randomUUID(),text:'I stay focused.',inputLanguage:'en',messageKind:'text',retry:false});
  expect(answered.status).toBe('conversing');
  expect((await speaking.applySpeakingEvent(created.id,{type:'reveal_hint',clientEventId:randomUUID(),level:1}))!.hintLevel).toBe(1);
});
it('回归：修改输入或版本后允许重新审核',async()=>{
  const queue=await import('@pipeline/src/lib/queue');
  const dir=path.join(process.env.ROASTDUCK_QUEUE_DIR!,'content_enrichment','done');
  fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'review-old-complete.json'),JSON.stringify({batchId:'review-old-complete',stage:'content_enrichment',promptVersion:'v1',inputs:[{unitKey:a,display:'old value'}],output:{}}));
  expect(queue.createBatches({stage:'content_enrichment',promptVersion:'v2',units:[{unitKey:a,display:'new value'}],batchSize:1,maxBatches:1,getUnitKey:(u:any)=>u.unitKey})).toBe(1);
});
it('回归：公共去重不删除个人 Chunk 及其学习关联',async()=>{
  await chunk(a);await chunk(b,personalBook);
  await db.update(s.chunks).set({canonicalChunk:'make steady progress'});
  await progress.applyLearningOutcome(b,'good',{sessionId:'review-dedup',comprehension:'understood',errors:0,assists:0,shadowingAttempts:1,microphoneMode:'recorded',skills:{}});
  const {dedupDeterministic}=await import('@pipeline/src/compiler/dedup');
  expect(await dedupDeterministic()).toBe(0);
  expect(await db.select().from(s.chunks).where(eq(s.chunks.id,b))).toHaveLength(1);
  expect((await db.select().from(s.personalChunkLinks))[0].chunkId).toBe(b);
  expect((await db.select().from(s.learningProgress))[0].chunkId).toBe(b);
});

it('学习事务失败时同时回滚进度、结算及会话步骤', async () => {
  await chunk();
  const id=randomUUID(), view=await reachPractice(id);
  await db.run(sql.raw("CREATE TRIGGER fail_review BEFORE INSERT ON review_log BEGIN SELECT RAISE(ABORT,'injected'); END"));
  try {
    await expect(session.applySessionEvent(id,{type:'submit_practice',clientEventId:randomUUID(),stepVersion:view.step.stepVersion,practiceId:view.step.practice.id,answer:'make steady progress'})).rejects.toThrow();
    expect(await db.select().from(s.learningProgress)).toHaveLength(0);
    expect(await db.all(sql`SELECT * FROM learning_round_settlements`)).toHaveLength(0);
    expect((await session.getSessionView(id)).step.stepVersion).toBe(view.step.stepVersion);
  } finally { await db.run(sql.raw('DROP TRIGGER fail_review')); }
});
it('公共去重保护同词书中已有学习进度的稳定 ID', async () => {
  await chunk(a); await chunk(b);
  await db.update(s.chunks).set({qualityStatus:'pending_review'});
  await progress.getOrCreateProgress(b);
  const {mergeChunks}=await import('@pipeline/src/compiler/chunkRepo');
  expect(await mergeChunks(a,b)).toBe(false);
  expect(await db.select().from(s.chunks)).toHaveLength(2);
});
it('直接并发结算仍然幂等', async () => {
  await chunk();
  const metrics={sessionId:randomUUID(),comprehension:'understood',errors:0,assists:0,shadowingAttempts:1,microphoneMode:'recorded',skills:{}};
  await Promise.all([progress.applyLearningOutcome(a,'good',metrics),progress.applyLearningOutcome(a,'good',metrics)]);
  expect(await db.select().from(s.reviewLog)).toHaveLength(1);
});

it('过期消息恢复后旧请求不能覆盖新回复；活跃租约不能抢占', async () => {
  const speaking = await import('@/lib/speaking/service');
  const factory = await import('@/lib/ai/provider-factory');
  const { runtimeAnswerMockResolver } = await import('@/lib/answers/runtime-mock');
  const { vi } = await import('vitest');
  const created = await speaking.createSpeakingSession({ clientRequestId: randomUUID(), questionId: 'review_question', answerId: null });
  const base = factory.createAiProvider({ mockResolver: runtimeAnswerMockResolver });
  let release!: () => void, started!: () => void, calls = 0;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const spy = vi.spyOn(factory, 'createAiProvider').mockReturnValue({ providerName: 'mock', model: base.model, async generate(request) {
    if (++calls === 1) { started(); await wait; }
    return base.generate(request);
  } });
  const input = { clientMessageId: randomUUID(), text: 'I stay focused.', inputLanguage: 'en' as const, messageKind: 'text' as const, retry: false };
  const old = speaking.sendSpeakingMessage(created.id, input).catch((error: unknown) => error);
  try {
    await entered;
    await expect(speaking.sendSpeakingMessage(created.id, { ...input, retry: true })).rejects.toMatchObject({ code: 'message_in_progress' });
    await db.run(sql`UPDATE companion_messages SET metadata_json = json_set(metadata_json, '$.leaseExpiresAt', '2000-01-01T00:00:00Z') WHERE thread_id = ${created.companionThreadId} AND role = 'user'`);
    const retried = await speaking.sendSpeakingMessage(created.id, { ...input, retry: true });
    expect(retried.turnCount).toBe(1);
    release();
    expect(await old).toBeInstanceOf(Error);
    const final = (await speaking.getSpeakingSession(created.id))!;
    expect(final.turnCount).toBe(1);
    expect(final.status).toBe('conversing');
    expect(final.messages.filter((message) => message.clientMessageId === input.clientMessageId)).toHaveLength(1);
    expect(final.messages.find((message) => message.clientMessageId === input.clientMessageId)?.metadata.deliveryAttempt).toBe(2);
  } finally { release(); await old; spy.mockRestore(); }
});

it('当天复习数量达到上限后不会重新发满额度', async () => {
  await chunk(a); await chunk(b);
  const metrics = { sessionId: 'previous', comprehension: 'understood', errors: 0, assists: 0, shadowingAttempts: 1, microphoneMode: 'recorded', skills: {} };
  await progress.applyLearningOutcome(a, 'good', metrics);
  await progress.applyLearningOutcome(b, 'good', metrics);
  await db.run(sql`UPDATE review_log SET trained_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day')`);
  await db.run(sql`UPDATE learning_progress SET fsrs_json = json_set(fsrs_json,'$.due','2000-01-01T00:00:00Z')`);
  await db.update(s.userSettings).set({ dailyReviewCap: 1 });
  expect((await progress.getTodayQueue()).due).toHaveLength(1);
  await progress.applyLearningOutcome(a, 'good', { ...metrics, sessionId: 'today' });
  expect((await progress.getTodayQueue()).due).toHaveLength(0);
});
