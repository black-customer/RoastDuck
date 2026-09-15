import { z } from 'zod';

export const AUDIO_MAX_BYTES = 50 * 1024 * 1024;
export const AUDIO_CHUNK_BYTES = 1024 * 1024;
export const RECORDING_MAX_MS = 10 * 60 * 1000;
export const AUDIO_ACCEPT = 'audio/webm,audio/ogg,audio/mpeg,audio/mp4,audio/wav,.webm,.ogg,.mp3,.m4a,.wav';
export const stageSchema = z.enum(['initial', 'guided', 'independent', 'transfer']);
export type AnswerStage = z.infer<typeof stageSchema>;
export const stageLabels: Record<AnswerStage, string> = { initial: '首次表达', guided: '中文辅助重答', independent: '无提示重答', transfer: '相关新题' };
export const sourceRefsSchema = z.object({ draftId: z.string().max(200).optional(), attemptId: z.string().max(200).optional(), coachingMessageId: z.string().max(200).optional(), taskId: z.string().max(200).optional() }).strict();
export const fullAnswerInputSchema = z.object({
  questionId: z.string().min(1).max(200), sourceKey: z.string().min(1).max(300), stage: stageSchema,
  promptCondition: z.string().min(1).max(500), materialId: z.string().max(200).nullable().optional(),
  text: z.string().max(30000).default(''), refs: sourceRefsSchema.default({}),
}).strict();
export type FullAnswerInput = z.infer<typeof fullAnswerInputSchema>;
export const uploadInputSchema = fullAnswerInputSchema.extend({
  uploadId: z.string().uuid(), byteLength: z.number().int().min(1).max(AUDIO_MAX_BYTES),
  source: z.enum(['recording', 'upload']), originalName: z.string().max(240), declaredMime: z.string().max(100),
  recordingComplete: z.literal(true),
  recordedAt: z.string().datetime({offset:true}).nullable().optional(),
  recordedAtSource: z.enum(['recording','user_provided','unknown']).optional(),
}).strict();
export type UploadInput = z.infer<typeof uploadInputSchema>;
export interface AudioAsset { id: string; fullAnswerId: string; sha256: string; byteLength: number; mimeType: string; extension: string; durationSeconds: number | null; source: 'recording' | 'upload'; originalName: string; note: string; createdAt: string; recordedAt?:string|null;recordedAtSource?:'recording'|'user_provided'|'unknown';removedAt: string | null; purgedAt: string | null; unavailable?: boolean }
export interface FullAnswer { id: string; questionId: string; sourceKey: string; stage: AnswerStage; promptCondition: string; materialId: string | null; text: string; refs: z.infer<typeof sourceRefsSchema>; taskPrompt?: string | null; createdAt: string; updatedAt: string; audio: AudioAsset[];legacy?:boolean;countsAsAttempt?:boolean;sourceHref?:string }
export function audioDuration(seconds: number | null) { if (seconds === null) return '时长未知'; const rounded = Math.round(seconds); return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, '0')}`; }
/** Prefer the earliest/latest available recordings under one observed condition. */
export function comparisonDefaults(attempts: FullAnswer[]): [string, string] {
  const available = attempts.filter(a=>a.countsAsAttempt!==false).flatMap(a => a.audio.filter(s => !s.removedAt && !s.purgedAt && !s.unavailable).map(s => ({ id: s.id, answerId:a.id, condition: a.promptCondition, stage: a.stage, taskId: a.refs.taskId ?? null, createdAt: s.recordedAt??s.createdAt })));
  available.sort((a, b) => a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id));
  const latest = available.at(-1); if (!latest) return ['', ''];
  const same=(candidate:typeof latest)=>available.filter(a=>a.condition===candidate.condition&&a.stage===candidate.stage&&a.taskId===candidate.taskId);
  const sameEarlier=same(latest).find(a=>a.answerId!==latest.answerId);
  if(sameEarlier)return [sameEarlier.id,latest.id];
  for(const candidate of [...available].reverse()){
    const earlier=same(candidate).find(a=>a.answerId!==candidate.answerId);if(earlier)return [earlier.id,candidate.id];
  }
  const other=available.find(a=>a.answerId!==latest.answerId);
  return other?[other.id,latest.id]:[latest.id,''];
}
