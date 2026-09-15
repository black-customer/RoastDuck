import { NextResponse } from 'next/server';
import { z } from 'zod';
import { fullAnswers } from '@/lib/answer-audio/node-service';
import { fullAnswerInputSchema } from '@/lib/answer-audio/contracts';
import { assertAudioLocal } from '@/lib/answer-audio/http';
import { localJson } from '@/lib/http/local-write';
import { webError } from '@/lib/http/web-error';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) { try { assertAudioLocal(request); const id = z.string().min(1).max(200).parse(new URL(request.url).searchParams.get('questionId')); return NextResponse.json(await fullAnswers.history(id), { headers: { 'Cache-Control': 'no-store' } }); } catch (error) { return webError(error); } }
export async function POST(request: Request) { try { const input = fullAnswerInputSchema.extend({ operation: z.literal('sourceLink') }).strict().parse(await localJson(request, 160000)); const { operation, ...source } = input; if (operation === 'sourceLink') return NextResponse.json(await fullAnswers.sourceLink(source)); } catch (error) { return webError(error); } }
