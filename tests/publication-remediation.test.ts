import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { prepareTestDatabase } from './helpers/temp-db';
import type { QualityBatchOutput } from '@pipeline/src/lib/schemas';

process.env.ROASTDUCK_DB = prepareTestDatabase('publication-remediation').url;
process.env.ROASTDUCK_SKIP_DB_BACKUP = '1';
process.env.AI_PROVIDER = 'mock';
const root = path.resolve('test-results', `publication-${randomUUID()}`);
process.env.ROASTDUCK_QUEUE_DIR = path.join(root, 'queue');
process.env.ROASTDUCK_AGENT_WORK_DIR = path.join(root, 'work');
let db: Awaited<ReturnType<typeof import('@db/client').getDbReady>>;
let schema: typeof import('@db/schema');
let quality: typeof import('@pipeline/src/compiler/quality_review');
let workflow: typeof import('@pipeline/src/agent/workflow');
let queue: typeof import('@pipeline/src/lib/queue');
const a = 'c_reviewaaaaaa', b = 'c_reviewbbbbbb';
beforeAll(async () => {
  db = await (await import('@db/client')).getDbReady();
  schema = await import('@db/schema');
  quality = await import('@pipeline/src/compiler/quality_review');
  workflow = await import('@pipeline/src/agent/workflow');
  queue = await import('@pipeline/src/lib/queue');
  await db.insert(schema.books).values({ id: 'review-public-book', titleZh: '合成测试', titleEn: 'Test', sourceType: 'question_bank' });
});
beforeEach(async () => {
  for (const table of ['chunks', 'chunk_examples', 'chunk_sources', 'chunk_pronunciations']) await db.run(sql`DELETE FROM ${sql.identifier(table)}`);
  for (const id of [a, b]) {
    await db.insert(schema.chunks).values({ id, bookId: 'review-public-book', canonicalChunk: id, displayChunk: 'stay focused', unitType: 'lexical_chunk', meaningZh: '保持专注', englishGloss: 'keep paying attention', qualityStatus: 'pending_review' });
    await db.insert(schema.chunkExamples).values({ id: `example_${id}`, chunkId: id, textEn: 'I stay focused.', textZh: '我保持专注。', contextType: 'generated_ielts', generated: 1 });
    await db.insert(schema.chunkSources).values({ id: `source_${id}`, chunkId: id, bookId: 'review-public-book', sourceType: 'question_bank', sourceContext: '合成测试来源' });
    await db.insert(schema.chunkPronunciations).values({ id: `pron_${id}`, chunkId: id, ipa: 'steɪ ˈfoʊkəst', accent: 'en-US', source: 'synthetic' });
  }
});

async function packet(verdicts: QualityBatchOutput['verdicts'], executorSessionId = `reviewer_${randomUUID()}`) {
  const batchId = `batch-${randomUUID()}`;
  queue.writeBatch({ batchId, stage: 'quality_review', promptVersion: quality.QUALITY_PROMPT_VERSION, createdAt: new Date().toISOString(), inputs: (await quality.getReviewInputs()).filter((item) => item.chunkId === a), output: null });
  workflow.prepareAgentPackets({ stage: 'quality_review', batchId });
  const dir = path.join(root, 'work', 'packets', 'quality_review', batchId);
  const template = JSON.parse(fs.readFileSync(path.join(dir, 'submission.template.json'), 'utf8'));
  const file = path.join(dir, 'submission.json');
  fs.writeFileSync(file, JSON.stringify({ ...template, runId: `agent_run_test_${randomUUID()}`, executor: { kind: 'codex_agent', sessionId: executorSessionId }, output: { verdicts } }));
  return { file, dir, batchId };
}

it.each([
  [{ chunkId: b, verdict: 'approved', reason: '不属于本批' }],
  [],
  [{ chunkId: a, verdict: 'approved', reason: '重复' }, { chunkId: a, verdict: 'approved', reason: '重复' }],
  [{ chunkId: a, verdict: 'edited', reason: '修改了其他条目', exampleEdits: [{ exampleId: `example_${b}`, textEn: 'Changed.' }] }],
] as Array<QualityBatchOutput['verdicts']>)('有效身份也不能绕过逐项裁决校验 %#', async (...verdicts) => {
  const p = await packet(verdicts as QualityBatchOutput['verdicts']);
  await expect(workflow.importAgentSubmission(p.file)).rejects.toThrow();
  expect((await db.select().from(schema.chunks)).every((item) => item.qualityStatus === 'pending_review')).toBe(true);
});

it('批准绑定完整证据和当前内容，清空版本或内容漂移均失效', async () => {
  const p = await packet([{ chunkId: a, verdict: 'approved', reason: '本测试仅验证证据结构，不代表真实内容审核' }]);
  await workflow.importAgentSubmission(p.file);
  expect(await quality.auditPublicationEvidence()).toEqual([]);
  await db.update(schema.chunks).set({ displayChunk: 'unreviewed mutation' }).where(eq(schema.chunks.id, a));
  expect(await quality.auditPublicationEvidence()).toMatchObject([{ chunkId: a }]);
  await db.update(schema.chunks).set({ displayChunk: 'stay focused', reviewerVersion: null, reviewedAt: null }).where(eq(schema.chunks.id, a));
  expect(await quality.auditPublicationEvidence()).toMatchObject([{ chunkId: a }]);
});

it('审核期间内容变化时拒绝过期结果', async () => {
  const p = await packet([{ chunkId: a, verdict: 'approved', reason: '合成结构测试' }]);
  await db.update(schema.chunks).set({ meaningZh: '已改变的中文' }).where(eq(schema.chunks.id, a));
  await expect(workflow.importAgentSubmission(p.file)).rejects.toThrow(/当前内容/);
});

it('撤销旧规则脚本冒充独立 Reviewer 的身份', async () => {
  const p = await packet([{ chunkId: a, verdict: 'approved', reason: '规则批准' }], 'agent_session_independent_reviewer_batch_fixture');
  await expect(workflow.importAgentSubmission(p.file)).rejects.toThrow(/旧规则脚本/);
  expect((await db.select().from(schema.chunks)).every((item) => item.qualityStatus === 'pending_review')).toBe(true);
});

it('发布审计发现 Prompt 原件被修改', async () => {
  const p = await packet([{ chunkId: a, verdict: 'approved', reason: '合成结构测试' }]);
  await workflow.importAgentSubmission(p.file);
  fs.appendFileSync(path.join(p.dir, 'prompt.snapshot.md'), '\nchanged');
  expect(await quality.auditPublicationEvidence()).toMatchObject([{ chunkId: a }]);
});

it('危险旧脚本退出且不修改历史审核文件', () => {
  const dir = path.join(root, 'retired', 'pipeline', 'agent-work', 'packets', 'quality_review');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'proof.json');
  fs.writeFileSync(file, '{"preserve":true}');
  const pending = path.join(root, 'retired', 'pipeline', 'queue', 'quality_review', 'pending');
  fs.mkdirSync(pending, { recursive: true });
  const candidate = path.join(pending, 'candidate.json');
  fs.writeFileSync(candidate, '{"output":null}');
  for (const script of ['process-quality-review.ts', 'ai-drain.ts']) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', path.resolve('scripts', script)], { cwd: path.join(root, 'retired'), encoding: 'utf8', env: { ...process.env, DEEPSEEK_API_KEY: '', MIMO_API_KEY: '' } });
    expect(result.status).toBe(1);
    expect(fs.readFileSync(file, 'utf8')).toBe('{"preserve":true}');
    expect(fs.readFileSync(candidate, 'utf8')).toBe('{"output":null}');
  }
});

it('公共 drain 拒绝真实 Provider，调用数及 ai_runs 都为零', async () => {
  const { runAiDrain } = await import('@pipeline/src/ai/drain');
  const generate = vi.fn();
  await expect(runAiDrain({ providerName: 'deepseek', model: 'deepseek-v4-flash', generate }, { maxBatches: 1, maxCostUsd: 1, concurrency: 1, apply: false, dryRun: false })).rejects.toThrow(/禁用/);
  expect(generate).not.toHaveBeenCalled();
  expect(await db.select().from(schema.aiRuns)).toHaveLength(0);
});
