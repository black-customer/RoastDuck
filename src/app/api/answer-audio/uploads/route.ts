import { NextResponse } from 'next/server';
import { answerAudio } from '@/lib/answer-audio/node-service';
import { uploadInputSchema } from '@/lib/answer-audio/contracts';
import { localJson } from '@/lib/http/local-write';
import { webError } from '@/lib/http/web-error';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) { try { return NextResponse.json(await answerAudio.begin(uploadInputSchema.parse(await localJson(request, 160000)))); } catch (error) { return webError(error); } }
