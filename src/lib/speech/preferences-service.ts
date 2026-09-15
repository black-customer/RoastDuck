import type {DatabasePort} from '@/lib/platform/database';
import {query as sql} from '@/lib/platform/sql';
import {roleSpeechPreferencesSchema} from './contracts';
export function createSpeechPreferenceService(database:DatabasePort){return {
  async get(){return database.read(async tx=>{const [row]=await tx.all<{speech_preferences_json:string|null}>(sql`SELECT speech_preferences_json FROM user_settings WHERE id=1`);if(!row?.speech_preferences_json)return null;try{const parsed=roleSpeechPreferencesSchema.safeParse(JSON.parse(row.speech_preferences_json));return parsed.success?parsed.data:null;}catch{return null;}});},
  async save(raw:unknown){const preferences=roleSpeechPreferencesSchema.parse(raw);await database.write(tx=>tx.run(sql`INSERT INTO user_settings(id,speech_preferences_json,updated_at) VALUES(1,${JSON.stringify(preferences)},${new Date().toISOString()}) ON CONFLICT(id) DO UPDATE SET speech_preferences_json=excluded.speech_preferences_json,updated_at=excluded.updated_at`));return preferences;},
};}
