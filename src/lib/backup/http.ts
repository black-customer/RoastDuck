import path from 'node:path';
import {NextResponse} from 'next/server';
import {z} from 'zod';
import {answerAudioRoot} from '@/lib/answer-audio/storage';
import {LocalWriteError} from '@/lib/http/local-write';
import {webError} from '@/lib/http/web-error';
import {BackupError, type BackupPaths} from './stream-archive';
import {BACKUP_CHUNK_BYTES} from './work-store';

export function backupPaths(): BackupPaths {
  const audioRoot = answerAudioRoot();
  return {audioRoot, workRoot: path.join(path.dirname(audioRoot), 'backup-work'), backupRoot: path.join(path.resolve(audioRoot, '../../..'), 'backups')};
}
export function backupError(error: unknown) {
  if (error instanceof BackupError) return NextResponse.json({error: error.message}, {status: error.status});
  if (error instanceof z.ZodError) return NextResponse.json({error: '备份格式或请求参数无效，现有资料未修改。'}, {status: 400});
  if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return NextResponse.json({error: '备份暂存文件不存在，请重新选择文件。'}, {status: 404});
  if ((error as NodeJS.ErrnoException)?.code === 'ENOSPC') return NextResponse.json({error: '本机空间不足，备份操作未完成。请释放空间后重试。'}, {status: 507});
  return webError(error);
}
/** Loopback/Origin policy for non-JSON bodies and private native downloads. */
export function assertBackupRequest(request: Request, binary = false) {
  const url = new URL(request.url), origin = request.headers.get('origin');
  const endpoint = request.headers.get('host') ? new URL(`${url.protocol}//${request.headers.get('host')}`) : url;
  if (!['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname) || origin && origin !== endpoint.origin || request.headers.get('sec-fetch-site') === 'cross-site') throw new LocalWriteError('只允许本机页面访问私人备份。', 403);
  if (binary && (!/^application\/octet-stream(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '') || request.headers.get('x-roastduck-backup') !== '1')) throw new LocalWriteError('备份上传需要本机页面发起的二进制请求。', 403);
}
export async function readBackupChunk(request: Request) {
  assertBackupRequest(request, true);
  if (Number(request.headers.get('content-length') ?? 0) > BACKUP_CHUNK_BYTES) throw new LocalWriteError('备份分块过大。', 413);
  const reader = request.body?.getReader(); if (!reader) throw new LocalWriteError('备份分块为空。', 400);
  const parts: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      length += next.value.byteLength;
      if (length > BACKUP_CHUNK_BYTES) {await reader.cancel(); throw new LocalWriteError('备份分块过大。', 413);}
      parts.push(next.value);
    }
  } finally {reader.releaseLock();}
  const bytes = new Uint8Array(length); let offset = 0;
  for (const part of parts) {bytes.set(part, offset); offset += part.byteLength;}
  return bytes;
}
