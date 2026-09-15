import fs from 'node:fs/promises';
import path from 'node:path';
import type { DatabasePort } from '@/lib/platform/database';
import { query as sql } from '@/lib/platform/sql';
import { LocalWriteError } from '@/lib/http/local-write';
import { ensureFullAnswer, validateAnswerRefs, assetView, type AssetRow } from '@/lib/full-answer-attempts/service';
import { AUDIO_CHUNK_BYTES, RECORDING_MAX_MS, uploadInputSchema, type UploadInput } from './contracts';
import { checkedId, audioAssetPath, inspectAudio, readRegularFile, sha256 } from './storage';

interface UploadRow { id: string; request_hash: string; metadata_json: string; status: 'receiving' | 'publishing' | 'complete'; asset_id: string | null }
const errorCode = (error: unknown) => (error as NodeJS.ErrnoException).code;
/** All filesystem targets derive solely from checked IDs; original names are display metadata. */
export function createAnswerAudioService(database: DatabasePort, root: () => string) {
  const directory = (id: string) => path.join(root(), 'uploads', checkedId(id));
  async function upload(id: string) {
    checkedId(id); const [row] = await database.read(tx => tx.all<UploadRow>(sql`SELECT * FROM answer_audio_uploads WHERE id=${id}`));
    if (!row) throw new LocalWriteError('上传记录不存在，请重新选择原文件', 404); return row;
  }
  async function asset(id: string) {
    checkedId(id); const [row] = await database.read(tx => tx.all<AssetRow>(sql`SELECT * FROM answer_audio_assets WHERE id=${id}`));
    if (!row) throw new LocalWriteError('原声不存在', 404); return row;
  }
  async function cleanUploadFiles(row: UploadRow, extension?: string) {
    const input = uploadInputSchema.parse(JSON.parse(row.metadata_json));
    const names = [...Array.from({ length: Math.ceil(input.byteLength / AUDIO_CHUNK_BYTES) }, (_, i) => `${i}.part`), 'assembled'];
    for (const name of names) { try { await fs.unlink(path.join(directory(row.id), name)); } catch (e) { if (errorCode(e) !== 'ENOENT') throw e; } }
    if (extension && row.asset_id !== row.id) { try { await fs.unlink(audioAssetPath(root(), row.id, extension)); } catch (e) { if (errorCode(e) !== 'ENOENT') throw e; } }
  }
  async function locked<T>(id: string, work: () => Promise<T>) {
    const dir = directory(id); await fs.mkdir(dir, { recursive: true });
    const lock = path.join(dir, 'write.lock'); let handle;
    try { handle = await fs.open(lock, 'wx'); }
    catch (e) {
      if (errorCode(e) !== 'EEXIST') throw e;
      // A checkpoint remains safe to retry after an interrupted process; short operations own this lease.
      const stat = await fs.stat(lock); if (Date.now() - stat.mtimeMs > 120000) { await fs.unlink(lock); return locked(id, work); }
      throw new LocalWriteError('这份原声正在保存，请稍后重试', 409);
    }
    try { return await work(); } finally { await handle.close(); await fs.unlink(lock).catch(() => undefined); }
  }
  async function status(row: UploadRow) {
    if (row.status === 'complete' && row.asset_id) { const stored = await asset(row.asset_id); return { uploadId: row.id, received: [] as number[], complete: true, fullAnswerId: stored.full_answer_id, asset: assetView(stored) }; }
    const input = uploadInputSchema.parse(JSON.parse(row.metadata_json)), received: number[] = [];
    for (let i = 0; i < Math.ceil(input.byteLength / AUDIO_CHUNK_BYTES); i++) {
      try { const stat = await fs.lstat(path.join(directory(row.id), `${i}.part`)); if (stat.isFile() && !stat.isSymbolicLink() && stat.size === Math.min(AUDIO_CHUNK_BYTES, input.byteLength - i * AUDIO_CHUNK_BYTES)) received.push(i); } catch (e) { if (errorCode(e) !== 'ENOENT') throw e; }
    }
    return { uploadId: row.id, received, complete: false, fullAnswerId: null, asset: null };
  }
  return {
    async begin(raw: UploadInput) {
      const input = uploadInputSchema.parse(raw), hash = sha256(Buffer.from(JSON.stringify(input)));
      const row = await database.write(async tx => {
        const [prior] = await tx.all<UploadRow>(sql`SELECT * FROM answer_audio_uploads WHERE id=${input.uploadId}`);
        if (prior) { if (prior.request_hash !== hash) throw new LocalWriteError('上传编号已用于其他原声', 409); return prior; }
        await validateAnswerRefs(tx, input);
        const at = new Date().toISOString(); await tx.run(sql`INSERT INTO answer_audio_uploads(id,request_hash,metadata_json,status,created_at,updated_at) VALUES(${input.uploadId},${hash},${JSON.stringify(input)},'receiving',${at},${at})`);
        return { id: input.uploadId, request_hash: hash, metadata_json: JSON.stringify(input), status: 'receiving' as const, asset_id: null };
      });
      return status(row);
    },
    async status(id: string) { return status(await upload(id)); },
    async chunk(id: string, index: number, bytes: Buffer) {
      if (!Number.isInteger(index) || index < 0 || index >= 50) throw new LocalWriteError('分片编号不正确', 400);
      return locked(id, async () => {
        const row = await upload(id), input = uploadInputSchema.parse(JSON.parse(row.metadata_json));
        if (row.status !== 'receiving') return status(row);
        const expected = Math.min(AUDIO_CHUNK_BYTES, input.byteLength - index * AUDIO_CHUNK_BYTES);
        if (expected <= 0 || bytes.length !== expected) throw new LocalWriteError('分片大小与原文件不一致', 400);
        const file = path.join(directory(id), `${index}.part`);
        try { const previous = await readRegularFile(file); if (sha256(previous) !== sha256(bytes)) throw new LocalWriteError('分片内容冲突，原文件保持不变', 409); }
        catch (e) { if (errorCode(e) !== 'ENOENT') throw e; const temp = file + '.writing'; const h = await fs.open(temp, 'w'); try { await h.writeFile(bytes); await h.sync(); } finally { await h.close(); } await fs.rename(temp, file); }
        return status(row);
      });
    },
    async complete(id: string) {
      return locked(id, async () => {
        const row = await upload(id); if (row.status === 'complete') { const stored = row.asset_id ? await asset(row.asset_id) : null; await cleanUploadFiles(row, stored?.extension); return status(row); }
        const input = uploadInputSchema.parse(JSON.parse(row.metadata_json));
        const chunks: Buffer[] = [];
        for (let i = 0; i < Math.ceil(input.byteLength / AUDIO_CHUNK_BYTES); i++) {
          try { const chunk = await readRegularFile(path.join(directory(id), `${i}.part`)); if (chunk.length !== Math.min(AUDIO_CHUNK_BYTES, input.byteLength - i * AUDIO_CHUNK_BYTES)) throw new Error('size'); chunks.push(chunk); }
          catch { throw new LocalWriteError('上传还未完整，已保存分片可以继续上传', 409); }
        }
        const bytes = Buffer.concat(chunks), inspected = await inspectAudio(bytes, input.declaredMime);
        if (input.source === 'recording' && inspected.durationSeconds !== null && inspected.durationSeconds > RECORDING_MAX_MS / 1000 + 2) throw new LocalWriteError('录音超过 10 分钟安全上限', 413);
        // Persist publication intent BEFORE filesystem mutation. A retry revalidates and completes it.
        await database.write(tx => tx.run(sql`UPDATE answer_audio_uploads SET status='publishing',updated_at=${new Date().toISOString()} WHERE id=${id}`));
        await fs.mkdir(path.join(root(), 'assets'), { recursive: true });
        const final = audioAssetPath(root(), id, inspected.extension);
        try { const old = await readRegularFile(final); if (sha256(old) !== inspected.sha256) throw new LocalWriteError('原声发布文件冲突', 409); }
        catch (e) { if (errorCode(e) !== 'ENOENT') throw e; const staged = path.join(directory(id), 'assembled'); const handle = await fs.open(staged, 'w'); try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); } await fs.rename(staged, final); }
        const stored = await database.write(async tx => {
          const fullAnswerId = await ensureFullAnswer(tx, { questionId: input.questionId, sourceKey: input.sourceKey, stage: input.stage, promptCondition: input.promptCondition, materialId: input.materialId, text: input.text, refs: input.refs });
          const [duplicate] = await tx.all<AssetRow>(sql`SELECT * FROM answer_audio_assets WHERE full_answer_id=${fullAnswerId} AND sha256=${inspected.sha256}`);
          if (duplicate) {
            // Tombstones deliberately win over retry and duplicate content.
            await tx.run(sql`UPDATE answer_audio_uploads SET status='complete',asset_id=${duplicate.id},updated_at=${new Date().toISOString()} WHERE id=${id}`); return duplicate;
          }
          if((await tx.all(sql`SELECT id FROM answer_audio_assets WHERE full_answer_id=${fullAnswerId}`)).length)throw new LocalWriteError('这次完整回答已有原声。请开始新一次完整回答，原声不会被覆盖。',409);
          const at = new Date().toISOString();
          await tx.run(sql`INSERT INTO answer_audio_assets(id,full_answer_id,upload_id,sha256,byte_length,mime_type,extension,duration_seconds,source,original_name,created_at) VALUES(${id},${fullAnswerId},${id},${inspected.sha256},${inspected.byteLength},${inspected.mimeType},${inspected.extension},${inspected.durationSeconds},${input.source},${input.originalName},${at})`);
          await tx.run(sql`UPDATE answer_audio_uploads SET status='complete',asset_id=${id},updated_at=${at} WHERE id=${id}`);
          return (await tx.all<AssetRow>(sql`SELECT * FROM answer_audio_assets WHERE id=${id}`))[0];
        });
        if (stored.id !== id) await fs.unlink(final).catch(() => undefined);
        // Remove only known, durable upload chunks after the published receipt exists.
        await cleanUploadFiles({ ...row, asset_id: stored.id }, stored.extension);
        return { uploadId: id, received: [], complete: true, fullAnswerId: stored.full_answer_id, asset: assetView(stored) };
      });
    },
    async read(id: string) {
      const row = await asset(id); if (row.removed_at || row.purged_at) throw new LocalWriteError('原声已移除', 410);
      let bytes: Buffer; try { bytes = await readRegularFile(audioAssetPath(root(), row.id, row.extension)); } catch { throw new LocalWriteError('原声文件缺失，可从含媒体的备份恢复', 404); }
      if (bytes.length !== row.byte_length || sha256(bytes) !== row.sha256) throw new LocalWriteError('原声文件校验失败，请从备份恢复', 409);
      return { row, bytes };
    },
    async change(id: string, action: 'note' | 'remove' | 'restore' | 'purge', note = '', confirmation?: string) {
      checkedId(id);
      if (action === 'purge' && confirmation !== '永久删除原声') throw new LocalWriteError('请单独确认永久删除原声', 400);
      const row = await database.write(async tx => {
        const [prior] = await tx.all<AssetRow>(sql`SELECT * FROM answer_audio_assets WHERE id=${id}`); if (!prior) throw new LocalWriteError('原声不存在', 404);
        if (action === 'restore' && prior.purged_at) throw new LocalWriteError('原声已永久删除，不能恢复', 409);
        if (action === 'note') await tx.run(sql`UPDATE answer_audio_assets SET note=${note.slice(0, 2000)} WHERE id=${id}`);
        else if (action === 'remove') await tx.run(sql`UPDATE answer_audio_assets SET removed_at=COALESCE(removed_at,${new Date().toISOString()}) WHERE id=${id}`);
        else if (action === 'restore') await tx.run(sql`UPDATE answer_audio_assets SET removed_at=NULL WHERE id=${id}`);
        else await tx.run(sql`UPDATE answer_audio_assets SET removed_at=COALESCE(removed_at,${new Date().toISOString()}),purged_at=COALESCE(purged_at,${new Date().toISOString()}) WHERE id=${id}`);
        return prior;
      });
      // Tombstone first: interruption never exposes old bytes or lets an old backup resurrect them.
      if (action === 'purge') {
        try { await fs.unlink(audioAssetPath(root(), id, row.extension)); } catch (e) { if (errorCode(e) !== 'ENOENT') throw e; }
        const relatedUploads = await database.read(tx => tx.all<UploadRow>(sql`SELECT * FROM answer_audio_uploads WHERE asset_id=${id}`));
        for (const related of relatedUploads) await cleanUploadFiles(related, row.extension);
      }
      return assetView(await asset(id));
    },
  };
}
