import { NextResponse } from 'next/server';
import { answerAudio } from '@/lib/answer-audio/node-service';
import { assertAudioLocal, readAudioChunk } from '@/lib/answer-audio/http';
import { localJson } from '@/lib/http/local-write';
import { webError } from '@/lib/http/web-error';
import { z } from 'zod';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, { params }: Context) { try { assertAudioLocal(request); return NextResponse.json(await answerAudio.status((await params).id), { headers: { 'Cache-Control': 'no-store' } }); } catch (error) { return webError(error); } }
export async function PUT(request: Request, { params }: Context) { try { const index = z.coerce.number().int().min(0).max(49).parse(new URL(request.url).searchParams.get('index')); return NextResponse.json(await answerAudio.chunk((await params).id, index, await readAudioChunk(request))); } catch (error) { return webError(error); } }
export async function POST(request: Request, { params }: Context) { try { z.object({ operation: z.literal('complete') }).strict().parse(await localJson(request)); return NextResponse.json(await answerAudio.complete((await params).id)); } catch (error) { return webError(error); } }
