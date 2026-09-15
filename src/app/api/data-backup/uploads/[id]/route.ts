import {NextResponse} from 'next/server';
import {z} from 'zod';
import {backupError, backupPaths, readBackupChunk} from '@/lib/backup/http';
import {appendBackupChunk} from '@/lib/backup/work-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function PUT(request: Request, context: {params: Promise<{id: string}>}) {
  try {
    const id = z.string().uuid().parse((await context.params).id);
    const offset = z.coerce.number().int().nonnegative().parse(new URL(request.url).searchParams.get('offset'));
    const bytes = await readBackupChunk(request);
    return NextResponse.json(await appendBackupChunk(backupPaths().workRoot, id, offset, bytes));
  } catch (error) {return backupError(error);}
}
