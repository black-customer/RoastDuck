import {Readable} from 'node:stream';
import {createReadStream} from 'node:fs';
import {assertBackupRequest, backupError, backupPaths} from '@/lib/backup/http';
import {getBackupDownload} from '@/lib/backup/work-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, context: {params: Promise<{id: string}>}) {
  try {
    assertBackupRequest(request);
    const saved = await getBackupDownload(backupPaths().workRoot, (await context.params).id);
    return new Response(Readable.toWeb(createReadStream(saved.file)) as ReadableStream<Uint8Array>, {headers: {
      'Content-Type': 'application/octet-stream', 'Content-Length': String(saved.bytes),
      'Content-Disposition': `attachment; filename="roastduck-${new Date(saved.createdAt).toISOString().slice(0, 10)}.rdbackup"`,
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin',
    }});
  } catch (error) {return backupError(error);}
}
