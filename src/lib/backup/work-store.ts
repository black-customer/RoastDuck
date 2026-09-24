import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {z} from 'zod';
import {BackupError, discardBackupStage, MAX_ARCHIVE_BYTES} from './stream-archive';

export const BACKUP_CHUNK_BYTES = 4 * 1024 * 1024;
const idSchema = z.string().uuid();
const uploadSchema = z.object({id: idSchema, bytes: z.number().int().positive().max(MAX_ARCHIVE_BYTES), createdAt: z.number(), expiresAt: z.number()}).strict();
const downloadSchema = z.object({id: idSchema, bytes: z.number().int().positive(), createdAt: z.number(), expiresAt: z.number()}).strict();
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function directory(root: string, group: 'uploads' | 'downloads') {
  await fs.mkdir(root, {recursive: true, mode: 0o700});
  const target = path.join(root, group); await fs.mkdir(target, {recursive: true, mode: 0o700});
  if (await fs.realpath(target) !== path.join(await fs.realpath(root), group)) throw new BackupError('备份暂存目录无效。');
  return target;
}
async function location(root: string, group: 'uploads' | 'downloads', id: string) {
  idSchema.parse(id); return path.join(await directory(root, group), id);
}
async function readJson(file: string) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new BackupError('备份检查点无效。');
  return JSON.parse(await fs.readFile(file, 'utf8'));
}
async function lock<T>(file: string, work: () => Promise<T>): Promise<T> {
  let handle;
  try {handle = await fs.open(file, 'wx', 0o600);}
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const owner = await readJson(file).catch(() => null) as {pid?: number} | null;
    let alive = true;
    if (owner?.pid && Number.isSafeInteger(owner.pid)) {
      try {process.kill(owner.pid, 0);} catch (reason) {if ((reason as NodeJS.ErrnoException).code === 'ESRCH') alive = false;}
    }
    if (alive) throw new BackupError('备份分块正在保存，请稍后重试。', 409);
    await fs.unlink(file).catch((error: NodeJS.ErrnoException) => {if (error.code !== 'ENOENT') throw error;});
    try {handle = await fs.open(file, 'wx', 0o600);}
    catch (error) {
      // 另一个进程同时清走了死锁文件；重试一次拿锁而不是裸抛 EEXIST。
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {handle = await fs.open(file, 'wx', 0o600);} catch {throw new BackupError('备份分块正在保存，请稍后重试。', 409);}
    }
  }
  try {await handle.writeFile(JSON.stringify({pid: process.pid})); return await work();}
  finally {await handle.close(); await fs.unlink(file).catch(() => undefined);}
}
export async function beginBackupUpload(root: string, id: string, bytes: number) {
  const checkpoint = uploadSchema.parse({id, bytes, createdAt: Date.now(), expiresAt: Date.now() + 48 * 60 * 60 * 1000});
  const base = await location(root, 'uploads', id);
  return lock(base + '.lock', async () => {
    const prior = await readJson(base + '.json').catch((error: NodeJS.ErrnoException) => {if (error.code === 'ENOENT') return null; throw error;});
    if (prior) {
      const saved = uploadSchema.parse(prior);
      if (saved.bytes !== bytes) throw new BackupError('上传编号已用于另一份备份。', 409);
      if (saved.expiresAt < Date.now()) throw new BackupError('备份上传已过期，请重新选择文件。', 410);
    } else {
      await fs.writeFile(base + '.json', JSON.stringify(checkpoint), {flag: 'wx', mode: 0o600});
    }
    const handle = await fs.open(base + '.rdbackup', 'a', 0o600); await handle.close();
    return {id, offset: (await fs.stat(base + '.rdbackup')).size, bytes};
  });
}
export async function getBackupUpload(root: string, id: string) {
  const base = await location(root, 'uploads', id), record = uploadSchema.parse(await readJson(base + '.json'));
  if (record.expiresAt < Date.now()) throw new BackupError('备份上传已过期，请重新选择文件。', 410);
  const file = base + '.rdbackup', stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > record.bytes) throw new BackupError('备份上传文件无效。');
  return {...record, file, offset: stat.size, complete: stat.size === record.bytes};
}
/** Retransmitting an acknowledged chunk verifies its bytes without appending it again. */
export async function appendBackupChunk(root: string, id: string, offset: number, bytes: Uint8Array) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !bytes.length || bytes.length > BACKUP_CHUNK_BYTES) throw new BackupError('备份分块大小或位置无效。');
  const base = await location(root, 'uploads', id);
  return lock(base + '.lock', async () => {
    const upload = await getBackupUpload(root, id);
    if (offset + bytes.length > upload.bytes) throw new BackupError('备份分块超过声明大小。');
    const handle = await fs.open(upload.file, 'r+');
    try {
      if (offset < upload.offset) {
        if (offset + bytes.length > upload.offset) throw new BackupError('上次分块未完整保存，请按服务器位置继续上传。', 409);
        const prior = Buffer.alloc(bytes.length); const read = await handle.read(prior, 0, prior.length, offset);
        if (read.bytesRead !== bytes.length || digest(prior) !== digest(bytes)) throw new BackupError('重复上传的分块内容不一致。', 409);
      } else if (offset === upload.offset) {
        let written = 0;
        while (written < bytes.length) {
          const next = await handle.write(bytes, written, bytes.length - written, offset + written);
          if (!next.bytesWritten) throw new BackupError('备份分块未完整保存，请重试。', 503);
          written += next.bytesWritten;
        }
        await handle.sync();
      } else {
        // 跳过位置会造成文件空洞，必须按服务器返回的位置续传。
        throw new BackupError('分块位置越界，请按服务器位置继续上传。', 409);
      }
      const nextOffset = (await handle.stat()).size;
      return {nextOffset, complete: nextOffset === upload.bytes};
    } finally {await handle.close();}
  });
}
export async function allocateBackupDownload(root: string) {
  const id = randomUUID(), base = await location(root, 'downloads', id);
  return {id, file: base + '.rdbackup'};
}
export async function publishBackupDownload(root: string, id: string) {
  const base = await location(root, 'downloads', id), bytes = (await fs.stat(base + '.rdbackup')).size;
  const record = downloadSchema.parse({id, bytes, createdAt: Date.now(), expiresAt: Date.now() + 24 * 60 * 60 * 1000});
  await fs.writeFile(base + '.json', JSON.stringify(record), {flag: 'wx', mode: 0o600});
  return record;
}
/** Reads only an already published artifact. It never creates an export. */
export async function getBackupDownload(root: string, id: string) {
  idSchema.parse(id);
  // No mkdir on GET: an absent directory/artifact is simply unavailable.
  const group = path.join(root, 'downloads');
  if (await fs.realpath(group) !== path.join(await fs.realpath(root), 'downloads')) throw new BackupError('备份下载目录无效。');
  const base = path.join(group, id), record = downloadSchema.parse(await readJson(base + '.json'));
  if (record.expiresAt < Date.now()) throw new BackupError('备份下载链接已过期，请重新导出。', 410);
  const file = base + '.rdbackup', stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== record.bytes) throw new BackupError('备份下载文件无效。');
  return {...record, file};
}

const lastCleanup = new Map<string, number>();
/** Expire only our temporary work files. Preserved pre-restore backups and original
 * assets are outside this directory and are never visited by this cleanup. */
export async function cleanupExpiredBackupWork(root: string, now = Date.now()) {
  if (now - (lastCleanup.get(root) ?? 0) < 15 * 60 * 1000) return;
  lastCleanup.set(root, now);
  const entries = await fs.readdir(root, {withFileTypes: true}).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const entry of entries) {
    if (entry.isDirectory() && /^stage-[a-zA-Z0-9_-]+$/.test(entry.name)) {
      const target = path.join(root, entry.name);
      if (now - (await fs.stat(target)).mtimeMs > 24 * 60 * 60 * 1000) await discardBackupStage(target, root);
    }
  }
  for (const group of ['uploads', 'downloads'] as const) {
    if (!entries.some(entry => entry.name === group && entry.isDirectory())) continue;
    const groupRoot = path.join(root, group);
    if (await fs.realpath(groupRoot) !== path.join(await fs.realpath(root), group)) continue;
    const names = await fs.readdir(groupRoot);
    for (const name of names) {
      if (!name.endsWith('.rdbackup')) continue;
      const id = name.slice(0, -9); if (!idSchema.safeParse(id).success) continue;
      const base = path.join(groupRoot, id), checkpoint = await readJson(base + '.json').catch(() => null) as {expiresAt?: number} | null;
      const stat = await fs.lstat(base + '.rdbackup');
      const expired = checkpoint?.expiresAt ? checkpoint.expiresAt < now : now - stat.mtimeMs > 24 * 60 * 60 * 1000;
      if (!expired || !stat.isFile() || stat.isSymbolicLink() || await fs.stat(base + '.lock').then(() => true, () => false)) continue;
      await fs.unlink(base + '.rdbackup');
      await fs.unlink(base + '.json').catch((error: NodeJS.ErrnoException) => {if (error.code !== 'ENOENT') throw error;});
    }
  }
}
