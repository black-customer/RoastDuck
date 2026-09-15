import { LocalWriteError } from '@/lib/http/local-write';
import { AUDIO_CHUNK_BYTES } from './contracts';

/** Apply loopback Host, Origin and Fetch Metadata checks to reads and binary writes. */
export function assertAudioLocal(request: Request) {
  const url = new URL(request.url), host = request.headers.get('host');
  let endpoint: URL; try { endpoint = host ? new URL(`${url.protocol}//${host}`) : url; } catch { throw new LocalWriteError('本机地址不正确', 403); }
  const origin = request.headers.get('origin'), site = request.headers.get('sec-fetch-site');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname) || origin && origin !== endpoint.origin || site === 'cross-site' || site === 'same-site') throw new LocalWriteError('原声只允许本机同源页面访问', 403);
}
export async function readAudioChunk(request: Request) {
  assertAudioLocal(request);
  if (request.headers.get('content-type') !== 'application/octet-stream') throw new LocalWriteError('音频分片格式不正确', 415);
  if (Number(request.headers.get('content-length')) > AUDIO_CHUNK_BYTES) throw new LocalWriteError('音频分片过大', 413);
  const reader = request.body?.getReader(); if (!reader) throw new LocalWriteError('音频分片为空', 400);
  const chunks: Uint8Array[] = []; let size = 0;
  try { while (true) { const result = await reader.read(); if (result.done) break; size += result.value.length; if (size > AUDIO_CHUNK_BYTES) { await reader.cancel(); throw new LocalWriteError('音频分片过大', 413); } chunks.push(result.value); } } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}
export function audioRange(header: string | null, size: number): { start: number; end: number } | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header); if (!m || !m[1] && !m[2]) throw new LocalWriteError('Range 不可用', 416);
  const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  const end = m[1] ? m[2] ? Math.min(Number(m[2]), size - 1) : size - 1 : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) throw new LocalWriteError('Range 不可用', 416);
  return { start, end };
}
