import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseBuffer } from 'music-metadata';
import { LocalWriteError } from '@/lib/http/local-write';
import { AUDIO_MAX_BYTES } from './contracts';

export const audioExtensions = ['webm', 'ogg', 'mp3', 'm4a', 'wav'] as const;
export function answerAudioRoot() {
  const db = process.env.ROASTDUCK_DB ?? 'file:./data/app.db';
  const dbPath = db.startsWith('file:') ? path.resolve(db.slice(5)) : '';
  const testRoot = path.resolve('test-results') + path.sep;
  if (process.env.VITEST && !dbPath.startsWith(testRoot)) throw new Error('自动化原声必须位于 test-results，拒绝真实资料目录');
  return dbPath.startsWith(testRoot) ? path.join(path.dirname(dbPath), 'imports/private/answer-audio') : path.resolve('data/imports/private/answer-audio');
}
export function checkedId(id: string) { if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new LocalWriteError('音频编号不正确', 400); return id; }
export function audioAssetPath(root: string, id: string, extension: string) {
  checkedId(id); if (!audioExtensions.includes(extension as typeof audioExtensions[number])) throw new LocalWriteError('音频格式不正确', 400);
  return path.join(root, 'assets', `${id}.${extension}`);
}
export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
/** Container signature plus real audio metadata parsing; never trust MIME or extension alone. */
export async function inspectAudio(bytes: Buffer, declaredMime = '') {
  if (!bytes.length || bytes.length > AUDIO_MAX_BYTES) throw new LocalWriteError('音频需要在 1 字节至 50 MiB 之间', 413);
  let extension: typeof audioExtensions[number], mimeType: string;
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WAVE') { extension = 'wav'; mimeType = 'audio/wav'; if (bytes.length < 44 || bytes.readUInt32LE(4) + 8 > bytes.length) throw new LocalWriteError('WAV 文件不完整', 415); }
  else if (bytes.subarray(0, 4).toString('hex') === '1a45dfa3') { extension = 'webm'; mimeType = 'audio/webm'; }
  else if (bytes.subarray(0, 4).toString() === 'OggS') { extension = 'ogg'; mimeType = 'audio/ogg'; }
  else if (bytes.subarray(4, 8).toString() === 'ftyp') { extension = 'm4a'; mimeType = 'audio/mp4'; }
  else if (bytes.subarray(0, 3).toString() === 'ID3' || bytes[0] === 255 && (bytes[1] & 0xe0) === 0xe0) { extension = 'mp3'; mimeType = 'audio/mpeg'; }
  else throw new LocalWriteError('文件内容不是支持的 MP3、M4A、WAV、WebM 或 Ogg 音频', 415);
  const claimed = declaredMime.split(';')[0].trim().toLowerCase();
  const aliases: Record<string, string[]> = { wav: ['audio/wav', 'audio/wave', 'audio/x-wav'], mp3: ['audio/mpeg', 'audio/mp3'], m4a: ['audio/mp4', 'audio/x-m4a', 'video/mp4'], webm: ['audio/webm', 'video/webm'], ogg: ['audio/ogg', 'application/ogg'] };
  if (claimed && claimed !== 'application/octet-stream' && !aliases[extension].includes(claimed)) throw new LocalWriteError('声明类型与音频内容不一致，请选择原始音频文件', 415);
  try {
    const metadata = await parseBuffer(bytes, { mimeType, size: bytes.length }, { duration: true, skipCovers: true });
    const f = metadata.format;
    if (!f.codec && !f.numberOfChannels || f.trackInfo?.some(track => track.type === 1)) throw new Error('not audio');
    const durationSeconds = typeof f.duration === 'number' && Number.isFinite(f.duration) && f.duration > 0 ? f.duration : null;
    return { extension, mimeType, durationSeconds, sha256: sha256(bytes), byteLength: bytes.length };
  } catch { throw new LocalWriteError('音频文件无法验证或包含视频，请使用完整的原始音频文件', 415); }
}
export async function readRegularFile(file: string) { const stat = await fs.lstat(file); if (!stat.isFile() || stat.isSymbolicLink()) throw new LocalWriteError('原声文件不可用', 409); return fs.readFile(file); }
