import { AUDIO_CHUNK_BYTES, AUDIO_MAX_BYTES, type UploadInput, type FullAnswerInput } from './contracts';

export interface AudioDraft { id: string; sourceKey: string; questionId: string; mimeType: string; originalName: string; source: 'recording' | 'upload'; state: 'recording' | 'interrupted' | 'ready'; byteLength: number; chunkCount: number; createdAt: string; recordedAt?:string|null; answerInput?: FullAnswerInput; uploadInput?: UploadInput }
const DB_NAME = 'roastduck-answer-audio-v1';
const request = <T>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error ?? new Error('本机存储失败')); });
async function database() { const r = indexedDB.open(DB_NAME, 1); r.onupgradeneeded = () => { const db = r.result; db.createObjectStore('drafts', { keyPath: 'id' }); db.createObjectStore('chunks', { keyPath: ['id', 'index'] }); }; return request(r); }
async function work<T>(stores: string[], mode: IDBTransactionMode, run: (tx: IDBTransaction) => Promise<T>): Promise<T> {
  const db = await database(), tx = db.transaction(stores, mode);
  const complete = new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error ?? new Error('本机存储已中止')); });
  try { const result = await run(tx); await complete; return result; } catch (error) { try { tx.abort(); } catch { /* already closed */ } await complete.catch(() => undefined); throw error; } finally { db.close(); }
}
export const saveDraft = (draft: AudioDraft) => work(['drafts'], 'readwrite', async tx => { await request(tx.objectStore('drafts').put(draft)); });
export async function appendDraftChunk(id: string, blob: Blob) {
  return work(['drafts', 'chunks'], 'readwrite', async tx => {
    const drafts = tx.objectStore('drafts'), draft = await request(drafts.get(id)) as AudioDraft | undefined;
    if (!draft) throw new Error('录音草稿不存在'); if (draft.byteLength + blob.size > AUDIO_MAX_BYTES) throw new Error('录音达到 50 MiB 上限；已存片段仍可下载');
    await request(tx.objectStore('chunks').put({ id, index: draft.chunkCount, blob }));
    const next = { ...draft, chunkCount: draft.chunkCount + 1, byteLength: draft.byteLength + blob.size }; await request(drafts.put(next)); return next;
  });
}
export const readDraft = (id: string) => work(['drafts'], 'readonly', tx => request(tx.objectStore('drafts').get(id)) as Promise<AudioDraft | undefined>);
export const listDrafts = (sourceKey: string, questionId: string) => work(['drafts'], 'readonly', async tx => (await request(tx.objectStore('drafts').getAll()) as AudioDraft[]).filter(d => d.sourceKey === sourceKey && d.questionId === questionId));
export const listQuestionDrafts = (questionId: string) => work(['drafts'], 'readonly', async tx => (await request(tx.objectStore('drafts').getAll()) as AudioDraft[]).filter(d => d.questionId === questionId));
export const readDraftBlob = (draft: AudioDraft) => work(['chunks'], 'readonly', async tx => { const rows = await request(tx.objectStore('chunks').getAll(IDBKeyRange.bound([draft.id, 0], [draft.id, Number.MAX_SAFE_INTEGER]))) as Array<{ index: number; blob: Blob }>; rows.sort((a, b) => a.index - b.index); if (rows.length !== draft.chunkCount) throw new Error('录音分片不完整，请保留已存片段'); return new Blob(rows.map(r => r.blob), { type: draft.mimeType }); });
export const removeDraft = (id: string) => work(['drafts', 'chunks'], 'readwrite', async tx => { await request(tx.objectStore('drafts').delete(id)); await request(tx.objectStore('chunks').delete(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]))); });
export async function persistFile(file: File, sourceKey: string, questionId: string, answerInput?: FullAnswerInput) {
  if (!file.size || file.size > AUDIO_MAX_BYTES) throw new Error('请选择不超过 50 MiB 的音频文件');
  let draft: AudioDraft = { id: crypto.randomUUID(), sourceKey, questionId, mimeType: file.type, originalName: file.name, source: 'upload', state: 'interrupted', byteLength: 0, chunkCount: 0, createdAt: new Date().toISOString(), answerInput };
  await saveDraft(draft); for (let offset = 0; offset < file.size; offset += AUDIO_CHUNK_BYTES) draft = await appendDraftChunk(draft.id, file.slice(offset, offset + AUDIO_CHUNK_BYTES));
  draft = { ...draft, state: 'ready' }; await saveDraft(draft); return draft;
}
export async function uploadAudioDraft(draft: AudioDraft, input: Omit<UploadInput, 'uploadId' | 'byteLength' | 'originalName' | 'source' | 'declaredMime' | 'recordingComplete'>, onProgress: (done: number, total: number) => void) {
  if (draft.state !== 'ready') throw new Error('中断片段不能当作完整回答，请下载保留或重新录音');
  const metadata: UploadInput = draft.uploadInput ?? { ...input, uploadId: draft.id, byteLength: draft.byteLength, originalName: draft.originalName, source: draft.source, declaredMime: draft.mimeType, recordingComplete: true,recordedAt:draft.source==='recording'?draft.createdAt:draft.recordedAt??null,recordedAtSource:draft.source==='recording'?'recording':draft.recordedAt?'user_provided':'unknown' };
  if (!draft.uploadInput) await saveDraft({ ...draft, uploadInput: metadata });
  const json = async (url: string, init?: RequestInit) => { const response = await fetch(url, init); const body = await response.json(); if (!response.ok) throw new Error(body.error ?? '保存失败，原声仍保留在本机草稿中'); return body; };
  const start = await json('/api/answer-audio/uploads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(metadata) });
  if (start.complete) return start as { fullAnswerId: string; asset: { removedAt: string | null; purgedAt: string | null } };
  const blob = await readDraftBlob(draft), total = Math.ceil(blob.size / AUDIO_CHUNK_BYTES), received = new Set<number>(start.received);
  for (let i = 0; i < total; i++) { if (!received.has(i)) await json(`/api/answer-audio/uploads/${draft.id}?index=${i}`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: blob.slice(i * AUDIO_CHUNK_BYTES, (i + 1) * AUDIO_CHUNK_BYTES) }); onProgress(i + 1, total); }
  return json(`/api/answer-audio/uploads/${draft.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operation: 'complete' }) }) as Promise<{ fullAnswerId: string; asset: { removedAt: string | null; purgedAt: string | null } }>;
}
