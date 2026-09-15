import { NextResponse } from 'next/server';
import { z } from 'zod';
import { answerAudio } from '@/lib/answer-audio/node-service';
import { assertAudioLocal, audioRange } from '@/lib/answer-audio/http';
import { localJson } from '@/lib/http/local-write';
import { webError } from '@/lib/http/web-error';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, { params }: Context) {
  try {
    assertAudioLocal(request); const { row, bytes } = await answerAudio.read((await params).id);
    let range; try { range = audioRange(request.headers.get('range'), bytes.length); } catch { return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${bytes.length}` } }); }
    const body = range ? bytes.subarray(range.start, range.end + 1) : bytes;
    return new Response(new Uint8Array(body), { status: range ? 206 : 200, headers: {
      'Content-Type': row.mime_type, 'Content-Length': String(body.length), 'Cache-Control': 'private, no-store', 'Accept-Ranges': 'bytes',
      'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin',
      ...(range ? { 'Content-Range': `bytes ${range.start}-${range.end}/${bytes.length}` } : {}),
      ...(new URL(request.url).searchParams.has('download') ? { 'Content-Disposition': `attachment; filename="answer-${row.id}.${row.extension}"` } : {}),
    } });
  } catch (error) { return webError(error); }
}
export async function PATCH(request: Request, { params }: Context) {
  try { const input = z.object({ operation: z.enum(['note', 'remove', 'restore', 'purge']), note: z.string().max(2000).optional(), confirmation: z.string().optional() }).strict().parse(await localJson(request)); return NextResponse.json({ asset: await answerAudio.change((await params).id, input.operation, input.note, input.confirmation) }); } catch (error) { return webError(error); }
}
