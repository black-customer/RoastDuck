import {NextResponse} from 'next/server';
import {z} from 'zod';
import {nodeDatabase} from '@/lib/platform/node/database';
import {localJson} from '@/lib/http/local-write';
import {webError} from '@/lib/http/web-error';
import {assertAudioLocal} from '@/lib/answer-audio/http';
import {createSpeechPreferenceService} from '@/lib/speech/preferences-service';
import {roleSpeechPreferencesSchema} from '@/lib/speech/contracts';
const preferences=createSpeechPreferenceService(nodeDatabase);
export const dynamic='force-dynamic';
export async function GET(request:Request){try{assertAudioLocal(request);return NextResponse.json({preferences:await preferences.get()},{headers:{'Cache-Control':'no-store'}});}catch(error){return webError(error);}}
export async function PATCH(request:Request){try{const input=z.object({preferences:roleSpeechPreferencesSchema}).strict().parse(await localJson(request));return NextResponse.json({preferences:await preferences.save(input.preferences)});}catch(error){return webError(error);}}
