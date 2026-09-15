import {NextResponse} from 'next/server';
import {z} from 'zod';
import {Readable} from 'node:stream';
import {createReadStream} from 'node:fs';
import {nodeDatabase} from '@/lib/platform/node/database';
import {restoreWebBackup} from '@/lib/backup/web-business';
import {localJson} from '@/lib/http/local-write';
import {backupError, backupPaths} from '@/lib/backup/http';
import {allocateBackupDownload, beginBackupUpload, cleanupExpiredBackupWork, getBackupUpload, publishBackupDownload} from '@/lib/backup/work-store';
import {applyBackupV2, BackupError, discardBackupStage, exportBackupV2, inspectBackupV2, inspectLegacyBackup, isBackupV2, MAX_ARCHIVE_BYTES, preserveBeforeRestore, stageBackupV2} from '@/lib/backup/stream-archive';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const password = z.string().min(10).max(1024);
const schema = z.discriminatedUnion('action', [
  z.object({action: z.literal('begin_import'), clientId: z.string().uuid(), bytes: z.number().int().positive().max(MAX_ARCHIVE_BYTES)}).strict(),
  z.object({action: z.enum(['export', 'export_v2']), password}).strict(),
  z.object({action: z.enum(['preview_import', 'restore_import']), password, uploadId: z.string().uuid()}).strict(),
  z.object({action: z.enum(['preview', 'restore']), password, archive: z.string().max(90_000_000)}).strict(),
]);
export async function POST(request: Request) {
  try {
    const input = schema.parse(await localJson(request, 91_000_000)), paths = backupPaths();
    await cleanupExpiredBackupWork(paths.workRoot).catch(() => undefined);
    if (input.action === 'begin_import') return NextResponse.json(await beginBackupUpload(paths.workRoot, input.clientId, input.bytes));
    if (input.action === 'export' || input.action === 'export_v2') {
      const download = await allocateBackupDownload(paths.workRoot);
      const result = await exportBackupV2(nodeDatabase, input.password, paths, download.file);
      await publishBackupDownload(paths.workRoot, download.id);
      if (input.action === 'export') return new Response(Readable.toWeb(createReadStream(download.file)) as ReadableStream<Uint8Array>, {headers: {'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="roastduck-business.rdbackup"', 'Cache-Control': 'no-store', 'Content-Length': String(result.bytes)}});
      return NextResponse.json({...result, url: `/api/data-backup/downloads/${download.id}`});
    }
    if (input.action === 'preview' || input.action === 'restore') {
      const bytes = Buffer.from(input.archive, 'base64');
      const preview = await restoreWebBackup(nodeDatabase, bytes, input.password);
      if (input.action === 'preview') return NextResponse.json(preview);
      const prior = await preserveBeforeRestore(nodeDatabase, input.password, paths);
      return NextResponse.json({...await restoreWebBackup(nodeDatabase, bytes, input.password, true), beforeRestoreMissingAudio: prior.missingAudio.length});
    }
    if (!('uploadId' in input)) throw new BackupError('备份操作无效。');
    const upload = await getBackupUpload(paths.workRoot, input.uploadId);
    if (!upload.complete) throw new BackupError('备份尚未上传完整，请继续上传后再检查。', 409);
    if (!await isBackupV2(upload.file)) {
      const preview = await inspectLegacyBackup(nodeDatabase, upload.file, input.password);
      if (input.action === 'preview_import') return NextResponse.json({...preview, format: 1, files: 0, missingAudio: []});
      const prior = await preserveBeforeRestore(nodeDatabase, input.password, paths);
      return NextResponse.json({...await inspectLegacyBackup(nodeDatabase, upload.file, input.password, true), format: 1, restoredFiles: 0, missingAudio: [], beforeRestoreMissingAudio: prior.missingAudio.length});
    }
    const staged = await stageBackupV2(upload.file, input.password, paths);
    try {
      const preview = await inspectBackupV2(nodeDatabase, staged);
      if (input.action === 'preview_import') return NextResponse.json({...preview, format: 2});
      const prior = await preserveBeforeRestore(nodeDatabase, input.password, paths);
      return NextResponse.json({...await applyBackupV2(nodeDatabase, staged, paths), format: 2, beforeRestoreMissingAudio: prior.missingAudio.length});
    } finally {await discardBackupStage(staged.directory, paths.workRoot);}
  } catch (error) {return backupError(error);}
}
