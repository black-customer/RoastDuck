import {z} from 'zod';
import {sha256Text} from '@/lib/platform/hash';
// Explicit business allowlist. No books/chunks, API requests, private file imports or credential tables.
export const SYNC_ENTITIES=[
  'topics','questions','question_sets','question_set_links','question_favorites',
  'personal_answers','answer_versions','practice_answer_sources','practice_source_revisions',
  'speaking_question_attempts','answer_drafts','practice_submissions',
  'free_talk_conversations','device_sync_chat_branches','free_talk_messages','companion_threads','companion_messages','companion_memories','companion_memory_control',
  'ai_runs','ai_jobs','practice_materials','practice_material_stages','practice_material_revisions','practice_offline_runs','practice_material_items',
  'learning_items','gap_events','light_study_sessions','light_study_events','light_study_progress',
  'four_step_sessions','four_step_events','four_step_settlements','four_step_judgements','learning_item_schedule',
  'difficult_notes','audio_assets',
] as const;
export type SyncEntity=typeof SYNC_ENTITIES[number];
export type SyncRow=Record<string,string|number|null>;
export const syncChangeSchema=z.object({
  id:z.string().regex(/^[a-f0-9]{64}$/),deviceId:z.string().min(1).max(160),entity:z.enum(SYNC_ENTITIES),key:z.string().min(1).max(500),
  parents:z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(32),row:z.record(z.string().regex(/^[a-z_][a-z0-9_]*$/),z.union([z.string().max(2_000_000),z.number().finite(),z.null()])).nullable(),at:z.string().datetime(),
}).strict();
export type SyncChange=z.infer<typeof syncChangeSchema>;
export function canonical(value:unknown):string{
  if(value===null||typeof value!=='object')return JSON.stringify(value);
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical((value as Record<string,unknown>)[key])).join(',')+'}';
}
export const contentHash=(value:unknown)=>sha256Text(canonical(value));
export const changeHash=(change:Omit<SyncChange,'id'>)=>contentHash(change);
export const ownedEntities=new Set<SyncEntity>(['light_study_sessions','four_step_sessions','practice_materials']);
