import {beforeAll,expect,it,vi} from 'vitest';
import {createClient,type Client} from '@libsql/client';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {prepareTestDatabase,assertInsideTestResults} from '../helpers/temp-db';
import {migrationHistory} from '../helpers/legacy-schema';
import {V36_DDL} from '../../db/migrations/v36-context-and-original-audio';
import {ensureSchema} from '../../db/migrate';

const temporary=prepareTestDatabase('v36-context-audio');
let client:Client;
beforeAll(async()=>{
  assertInsideTestResults(temporary.file);
  process.env.ROASTDUCK_SKIP_DB_BACKUP='1';process.env.AI_PROVIDER='mock';
  client=createClient({url:temporary.url});await ensureSchema(client,temporary.url);
  // Reconstruct physical v35 ONLY in this new, explicitly isolated database.
  for(const statement of [...V36_DDL].reverse()){
    const column=/^ALTER TABLE ([a-z_][a-z0-9_]*) ADD COLUMN ([a-z_][a-z0-9_]*)/.exec(statement.trim());
    if(column){await client.execute(`ALTER TABLE "${column[1]}" DROP COLUMN "${column[2]}"`);continue;}
    const match=/^CREATE (?:UNIQUE )?(TABLE|INDEX) ([a-z_][a-z0-9_]*)/i.exec(statement.trim());
    if(!match)throw new Error('Update the explicit migration fixture for new DDL');
    await client.execute(`DROP ${match[1]} "${match[2]}"`);
  }
  await client.execute('DELETE FROM _schema_migrations WHERE version=36');
  await client.execute("INSERT INTO questions(id,book_id,part,text,norm_text) VALUES('stable-q','retired',1,'What do you like?','stable-q')");
  await client.execute("INSERT INTO speaking_question_attempts(id,question_id,mode,answer_text,intended_meaning_zh,status) VALUES('stable-a','stable-q','practice','Synthetic original answer.','合成原意。','completed')");
  await client.execute("INSERT INTO sentence_study_progress(sentence_id,first_seen_at,last_seen_at,due_at,fsrs_json,version,last_rating) VALUES('stable-s','2026-09-01','2026-09-02','2026-09-30','{\"synthetic\":true}',4,'remembered')");
},15000);

it('backs up v35, preserves original evidence and old schedules, adds empty v36 tables, and is repeatable',async()=>{
  const network=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('No Runtime during migration'));
  try{
    const before=await migrationHistory(client,35);
    const snapshot=async()=>createHash('sha256').update(JSON.stringify([
      (await client.execute('SELECT * FROM speaking_question_attempts ORDER BY id')).rows,
      (await client.execute('SELECT * FROM sentence_study_progress ORDER BY sentence_id')).rows,
    ])).digest('hex');
    const original=await snapshot();process.env.ROASTDUCK_SKIP_DB_BACKUP='0';
    await ensureSchema(client,temporary.url);
    expect(await snapshot()).toBe(original);expect(await migrationHistory(client,35)).toEqual(before);
    const record=(await client.execute('SELECT * FROM _schema_migrations WHERE version=36')).rows[0];
    const backup=String(record.backup_path);expect(path.dirname(backup)).toBe(path.join(temporary.directory,'backups'));expect(fs.existsSync(backup)).toBe(true);
    const old=createClient({url:`file:${backup}`});
    try{expect((await old.execute('SELECT MAX(version) AS v FROM _schema_migrations')).rows[0].v).toBe(35);expect((await old.execute('SELECT answer_text FROM speaking_question_attempts')).rows[0].answer_text).toBe('Synthetic original answer.');}finally{old.close();}
    for(const table of ['sentence_exposures','sentence_exposure_events','full_answer_attempts','answer_audio_assets','context_practice_tasks'])expect((await client.execute(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0].n).toBe(0);
    await ensureSchema(client,temporary.url);expect(await snapshot()).toBe(original);expect((await client.execute('SELECT COUNT(*) AS n FROM _schema_migrations WHERE version=36')).rows[0].n).toBe(1);
    await client.execute("UPDATE _schema_migrations SET checksum='synthetic-corruption' WHERE version=36");
    await expect(ensureSchema(client,temporary.url)).rejects.toThrow('checksum');
    expect(network).not.toHaveBeenCalled();
  }finally{network.mockRestore();client.close();}
},15000);
