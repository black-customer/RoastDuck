import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { portableTestDatabase } from './helpers/portable-db';
import { query as sql } from '@/lib/platform/sql';
import type { DatabasePort } from '@/lib/platform/database';
import { createAnswerAudioService } from '@/lib/answer-audio/service';
import { createFullAnswerService } from '@/lib/full-answer-attempts/service';
import { answerAudioRoot, audioAssetPath, inspectAudio } from '@/lib/answer-audio/storage';
import { audioRange, assertAudioLocal, readAudioChunk } from '@/lib/answer-audio/http';
import { AUDIO_CHUNK_BYTES, comparisonDefaults, audioDuration, type UploadInput, type FullAnswer } from '@/lib/answer-audio/contracts';
import {linkFullAnswer,pendingFullAnswerLinks,retryFullAnswerLink} from '@/lib/answer-audio/source-link-client';

const opened: Array<ReturnType<typeof portableTestDatabase>> = [];
afterEach(() => { opened.splice(0).forEach(f => f.close()); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function wav(seconds = 1) { const size = seconds * 8000 * 2, b = Buffer.alloc(44 + size); b.write('RIFF', 0); b.writeUInt32LE(36 + size, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24); b.writeUInt32LE(16000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(size, 40); return b; }
async function fixture(transform?: (database: DatabasePort) => DatabasePort) {
  const f = portableTestDatabase(); opened.push(f);
  await f.database.write(tx => tx.run(sql`INSERT INTO questions(id,book_id,part,text,text_zh,norm_text) VALUES('audio-q','retired',1,'What do you enjoy?','你喜欢做什么？','audio-q')`));
  await fs.mkdir(path.resolve('test-results/answer-audio'), { recursive: true }); const root = await fs.mkdtemp(path.resolve('test-results/answer-audio/case-'));
  const database = transform ? transform(f.database) : f.database;
  const service = createAnswerAudioService(database, () => root), answers = createFullAnswerService(database);
  const bytes = wav();
  const input = (changes: Partial<UploadInput> = {}): UploadInput => ({ uploadId: randomUUID(), questionId: 'audio-q', sourceKey: 'test-answer', stage: 'initial', promptCondition: '首次表达', text: '', refs: {}, source: 'upload', originalName: '../../outside.wav', declaredMime: 'audio/wav', recordingComplete: true, byteLength: bytes.length, ...changes });
  return { ...f, service, answers, input, bytes, root };
}
it('validates real audio contents, duration and path boundaries; rejects spoofed or incomplete files', async () => {
  await expect(inspectAudio(wav())).resolves.toMatchObject({ mimeType: 'audio/wav', durationSeconds: 1, extension: 'wav' });
  await expect(inspectAudio(wav(), 'audio/mpeg')).rejects.toThrow('不一致');
  await expect(inspectAudio(Buffer.from('<svg onload="alert(1)">'))).rejects.toThrow('文件内容');
  await expect(inspectAudio(wav().subarray(0, 45))).rejects.toThrow('不完整');
  expect(() => audioAssetPath('root', '../secrets', 'wav')).toThrow('编号');
  expect(() => audioAssetPath('root', randomUUID(), '../json')).toThrow('格式');
  vi.stubEnv('ROASTDUCK_DB', 'file:./data/app.db'); expect(() => answerAudioRoot()).toThrow('自动化');
  vi.stubEnv('ROASTDUCK_DB', 'file:./test-results/audio/app.db'); expect(answerAudioRoot()).toContain(path.join('test-results', 'audio', 'imports', 'private', 'answer-audio'));
});
it('stores audio-only once, resumes repeat chunks and associates later text without changing stable IDs', async () => {
  const f = await fixture(), input = f.input();
  await f.service.begin(input); await f.service.chunk(input.uploadId, 0, f.bytes);
  expect((await f.service.status(input.uploadId)).received).toEqual([0]);
  await f.service.chunk(input.uploadId, 0, f.bytes);
  expect((await f.answers.history('audio-q')).attempts).toHaveLength(0);
  const done = await f.service.complete(input.uploadId); expect(done.complete).toBe(true); expect(done.fullAnswerId).toBeTruthy();
  expect((await f.service.read(input.uploadId)).bytes).toEqual(f.bytes);
  expect((await f.service.begin(input)).fullAnswerId).toBe(done.fullAnswerId);
  const linked = await f.answers.sourceLink({ questionId: 'audio-q', sourceKey: input.sourceKey, stage: 'initial', promptCondition: input.promptCondition, text: 'This is my added text.', refs: {} });
  expect(linked.fullAnswerId).toBe(done.fullAnswerId);
  const history = await f.answers.history('audio-q'); expect(history.attempts).toHaveLength(1); expect(history.attempts[0]).toMatchObject({ text: 'This is my added text.' }); expect(history.attempts[0].audio).toHaveLength(1);
  expect(await fs.readdir(path.join(f.root, 'assets'))).toEqual([`${input.uploadId}.wav`]);
});
it('deduplicates content for the same answer and preserves removal/purge tombstones across retries', async () => {
  const f = await fixture(), first = f.input(); await f.service.begin(first); await f.service.chunk(first.uploadId, 0, f.bytes); await f.service.complete(first.uploadId);
  const duplicate = f.input(); await f.service.begin(duplicate); await f.service.chunk(duplicate.uploadId, 0, f.bytes); expect((await f.service.complete(duplicate.uploadId)).asset?.id).toBe(first.uploadId);
  expect((await f.answers.history('audio-q')).attempts[0].audio).toHaveLength(1);
  await f.service.change(first.uploadId, 'note', '只看过中文'); await f.service.change(first.uploadId, 'remove'); await expect(f.service.read(first.uploadId)).rejects.toThrow('移除');
  await f.service.change(first.uploadId, 'restore'); expect((await f.service.read(first.uploadId)).row.note).toBe('只看过中文');
  await expect(f.service.change(first.uploadId, 'purge')).rejects.toThrow('确认');
  await f.service.change(first.uploadId, 'purge', '', '永久删除原声'); await expect(f.service.change(first.uploadId, 'restore')).rejects.toThrow('永久删除');
  const afterPurge = f.input(); await f.service.begin(afterPurge); await f.service.chunk(afterPurge.uploadId, 0, f.bytes); const retried = await f.service.complete(afterPurge.uploadId); expect(retried.asset?.purgedAt).toBeTruthy();
  expect(await fs.readdir(path.join(f.root, 'assets'))).toEqual([]); expect((await f.answers.history('audio-q')).attempts).toHaveLength(1);
});
it('a new full recording needs a new answer identity, while retrying the original stays idempotent',async()=>{
  const f=await fixture(),first=f.input();await f.service.begin(first);await f.service.chunk(first.uploadId,0,f.bytes);await f.service.complete(first.uploadId);
  const changed=Buffer.from(f.bytes);changed[changed.length-1]=1;
  const second=f.input();await f.service.begin(second);await f.service.chunk(second.uploadId,0,changed);
  await expect(f.service.complete(second.uploadId)).rejects.toThrow('开始新一次');
  expect((await f.answers.history('audio-q')).attempts).toHaveLength(1);
  const fresh=f.input({sourceKey:'a-real-new-answer'});await f.service.begin(fresh);await f.service.chunk(fresh.uploadId,0,changed);await f.service.complete(fresh.uploadId);
  expect((await f.answers.history('audio-q')).attempts).toHaveLength(2);
});
it('keeps a durable publishing checkpoint and safely completes after a database publication failure', async () => {
  let fail = true;
  const f = await fixture(database => ({ read: work => database.read(work), write: work => database.write(tx => work({ all: command => tx.all(command), run: command => { if (fail && command.sql.includes('INSERT INTO answer_audio_assets')) { fail = false; throw new Error('synthetic publication interruption'); } return tx.run(command); } })) }));
  const input = f.input(); await f.service.begin(input); await f.service.chunk(input.uploadId, 0, f.bytes);
  await expect(f.service.complete(input.uploadId)).rejects.toThrow('synthetic');
  expect((await f.answers.history('audio-q')).attempts).toHaveLength(0);
  const [checkpoint] = await f.database.read(tx => tx.all<{ status: string }>(sql`SELECT status FROM answer_audio_uploads WHERE id=${input.uploadId}`)); expect(checkpoint.status).toBe('publishing');
  const recovered = await f.service.complete(input.uploadId); expect(recovered.complete).toBe(true); expect((await f.answers.history('audio-q')).attempts).toHaveLength(1);
});
it('resumes multiple original-file chunks without creating a draft answer and enforces the recording duration limit', async () => {
  const f = await fixture(), longFile = wav(70), input = f.input({ byteLength: longFile.length });
  await f.service.begin(input); await f.service.chunk(input.uploadId, 1, longFile.subarray(AUDIO_CHUNK_BYTES));
  expect((await f.service.status(input.uploadId)).received).toEqual([1]); await expect(f.service.complete(input.uploadId)).rejects.toThrow('未完整');
  await f.service.chunk(input.uploadId, 0, longFile.subarray(0, AUDIO_CHUNK_BYTES)); const done = await f.service.complete(input.uploadId); expect(done.asset?.durationSeconds).toBe(70);
  const tooLong = wav(603), recording = f.input({ sourceKey: 'long-recording', source: 'recording', byteLength: tooLong.length });
  await f.service.begin(recording); for (let index = 0; index < Math.ceil(tooLong.length / AUDIO_CHUNK_BYTES); index++) await f.service.chunk(recording.uploadId, index, tooLong.subarray(index * AUDIO_CHUNK_BYTES, (index + 1) * AUDIO_CHUNK_BYTES));
  await expect(f.service.complete(recording.uploadId)).rejects.toThrow('10 分钟'); expect((await f.answers.history('audio-q')).attempts).toHaveLength(1);
});
it('rejects conflicting uploads, incomplete chunks, cross-question references and edits to existing text', async () => {
  const f = await fixture(), input = f.input(); await f.service.begin(input);
  await expect(f.service.begin({ ...input, originalName: 'different.wav' })).rejects.toThrow('编号');
  await expect(f.service.complete(input.uploadId)).rejects.toThrow('未完整');
  await expect(f.service.chunk(input.uploadId, 0, f.bytes.subarray(1))).rejects.toThrow('大小');
  await f.service.chunk(input.uploadId, 0, f.bytes); const changed = Buffer.from(f.bytes); changed[100] = 1; await expect(f.service.chunk(input.uploadId, 0, changed)).rejects.toThrow('冲突');
  await expect(f.service.begin(f.input({ refs: { draftId: 'wrong' } }))).rejects.toThrow('草稿');
  await f.service.complete(input.uploadId);
  await f.answers.sourceLink({ questionId: 'audio-q', sourceKey: input.sourceKey, stage: 'initial', promptCondition: input.promptCondition, text: 'original', refs: {} });
  await expect(f.answers.sourceLink({ questionId: 'audio-q', sourceKey: input.sourceKey, stage: 'initial', promptCondition: input.promptCondition, text: 'changed', refs: {} })).rejects.toThrow('新版本');
});
it('protects binary requests and Range reads with loopback Host/Origin and byte limits', async () => {
  const request = (headers: Record<string, string> = {}) => new Request('http://127.0.0.1:3000/api/answer-audio/id', { headers });
  expect(() => assertAudioLocal(request({ host: 'evil.example' }))).toThrow('同源');
  expect(() => assertAudioLocal(request({ origin: 'http://127.0.0.1:4000' }))).toThrow('同源');
  expect(() => assertAudioLocal(request({ 'sec-fetch-site': 'cross-site' }))).toThrow('同源');
  expect(() => assertAudioLocal(request({ host: 'localhost:3000', origin: 'http://localhost:3000' }))).not.toThrow();
  expect(audioRange('bytes=2-4', 10)).toEqual({ start: 2, end: 4 }); expect(audioRange('bytes=-3', 10)).toEqual({ start: 7, end: 9 }); expect(() => audioRange('bytes=10-', 10)).toThrow(); expect(() => audioRange('bytes=0-1,4-5', 10)).toThrow();
  await expect(readAudioChunk(new Request('http://localhost:3000', { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: Buffer.alloc(AUDIO_CHUNK_BYTES + 1) }))).rejects.toThrow('过大');
});
it('compares only available same-condition and same-task recordings, with honest unknown duration', () => {
  const attempt = (id: string, stage: FullAnswer['stage'], condition: string, taskId?: string): FullAnswer => ({ id, questionId: 'q', sourceKey: id, stage, promptCondition: condition, materialId: null, text: '', refs: taskId ? { taskId } : {}, createdAt: id, updatedAt: id, audio: [{ id: `audio-${id}`, fullAnswerId: id, sha256: '', byteLength: 1, mimeType: 'audio/wav', extension: 'wav', durationSeconds: null, source: 'upload', originalName: '', note: '', createdAt: id, removedAt: null, purgedAt: null }] });
  expect(comparisonDefaults([attempt('1', 'initial', 'no hint'), attempt('2', 'guided', 'Chinese'), attempt('3', 'initial', 'no hint')])).toEqual(['audio-1', 'audio-3']);
  expect(comparisonDefaults([attempt('1', 'transfer', 'no hint', 'task-a'), attempt('2', 'transfer', 'no hint', 'task-b')])).toEqual(['audio-1', 'audio-2']);
  expect(audioDuration(null)).toBe('时长未知'); expect(audioDuration(61)).toBe('1:01');
});
it('retains a failed history link for explicit recovery and never re-submits text to AI',async()=>{
  const values=new Map<string,string>();vi.stubGlobal('localStorage',{getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>values.set(key,value),removeItem:(key:string)=>values.delete(key),get length(){return values.size;},key:(index:number)=>[...values.keys()][index]??null});
  const fetcher=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({error:'synthetic offline'}),{status:503})).mockResolvedValueOnce(new Response(JSON.stringify({fullAnswerId:'stable-answer'}),{status:200}));vi.stubGlobal('fetch',fetcher);
  const input={questionId:'q',sourceKey:'answer:q:client',stage:'initial' as const,promptCondition:'首次表达',text:'Original saved text.',refs:{attemptId:'saved-attempt'}};
  await expect(linkFullAnswer(input)).rejects.toThrow('synthetic offline');expect(pendingFullAnswerLinks('q')).toEqual([input]);
  expect(await retryFullAnswerLink(input.sourceKey)).toEqual({fullAnswerId:'stable-answer'});expect(pendingFullAnswerLinks('q')).toEqual([]);
  expect(fetcher.mock.calls.map(call=>call[0])).toEqual(['/api/full-answer-attempts','/api/full-answer-attempts']);
  expect(fetcher.mock.calls[0][1].body).toBe(fetcher.mock.calls[1][1].body);
});
