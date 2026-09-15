import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {afterEach, describe, expect, it} from 'vitest';
import {portableTestDatabase} from './helpers/portable-db';
import {applyBackupV2, discardBackupStage, exportBackupV2, inspectBackupV2, inspectLegacyBackup, isBackupV2, preserveBeforeRestore, stageBackupV2, type BackupPaths} from '@/lib/backup/stream-archive';
import {appendBackupChunk, beginBackupUpload, getBackupUpload, BACKUP_CHUNK_BYTES} from '@/lib/backup/work-store';
import {exportWebBackup, WEB_BACKUP_TABLES} from '@/lib/backup/web-business';

const password = 'synthetic-backup-password';
const roots: string[] = [];
const databases: Array<ReturnType<typeof portableTestDatabase>> = [];
afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== path.resolve('test-results') || !path.basename(root).startsWith('media-backup-')) throw new Error('Unsafe test cleanup');
    await fs.rm(root, {recursive: true, force: true});
  }
});
async function fixture() {
  await fs.mkdir('test-results', {recursive: true});
  const root = await fs.mkdtemp(path.resolve('test-results/media-backup-')); roots.push(root);
  const db = portableTestDatabase(); databases.push(db);
  db.connection.exec("INSERT INTO _schema_migrations(version,name,checksum) VALUES(36,'isolated-backup-fixture','fixture')");
  const paths: BackupPaths = {audioRoot: path.join(root, 'imports/private/answer-audio'), workRoot: path.join(root, 'imports/private/backup-work'), backupRoot: path.join(root, 'backups')};
  await fs.mkdir(path.join(paths.audioRoot, 'assets'), {recursive: true});
  return {root, paths, ...db};
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function question(f: Fixture) {
  f.connection.exec("INSERT OR IGNORE INTO questions(id,book_id,part,text,text_zh,norm_text) VALUES('q','removed',1,'What do you enjoy?','你喜欢什么？','q')");
}
async function audio(f: Fixture, size = 1024, id = randomUUID(), fullAnswerId = randomUUID()) {
  question(f);
  const file = path.join(f.paths.audioRoot, 'assets', id + '.wav'), handle = await fs.open(file, 'wx');
  const hash = createHash('sha256'), chunk = randomBytes(Math.min(size, 1024 * 1024));
  try {
    for (let remaining = size; remaining > 0;) {
      const part = chunk.subarray(0, Math.min(chunk.length, remaining));
      await handle.write(part); hash.update(part); remaining -= part.length;
    }
  } finally {await handle.close();}
  const sha256 = hash.digest('hex');
  f.connection.prepare("INSERT INTO full_answer_attempts(id,question_id,source_key,stage,prompt_condition,created_at,updated_at) VALUES(?,'q',?,'initial','no_hint','2026-09-15T00:00:00.000Z','2026-09-15T00:00:00.000Z')").run(fullAnswerId, 'test:' + fullAnswerId);
  f.connection.prepare("INSERT INTO answer_audio_assets(id,full_answer_id,upload_id,sha256,byte_length,mime_type,extension,source,original_name,created_at) VALUES(?,?,?,?,?,'audio/wav','wav','upload','synthetic.wav','2026-09-15T00:00:00.000Z')").run(id, fullAnswerId, id, sha256, size);
  return {id, fullAnswerId, file, sha256, size};
}
async function digest(file: string) {
  const {createReadStream} = await import('node:fs'); const hash = createHash('sha256');
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}
async function archive(from: Fixture) {
  const file = path.join(from.root, randomUUID() + '.rdbackup');
  const result = await exportBackupV2(from.database, password, from.paths, file);
  return {file, ...result};
}

describe('streamed original-audio backups', () => {
  it('round trips an encrypted archive larger than 64 MiB with original hashes and no AI/sync work', async () => {
    const from = await fixture(), to = await fixture();
    const first = await audio(from, 34 * 1024 * 1024), tenth = await audio(from, 34 * 1024 * 1024);
    const exported = await archive(from);
    expect(exported.bytes).toBeGreaterThan(64 * 1024 * 1024);
    expect(exported.files).toBe(2); expect(exported.missingAudio).toEqual([]);
    expect(await isBackupV2(exported.file)).toBe(true);
    const staged = await stageBackupV2(exported.file, password, to.paths);
    expect(await inspectBackupV2(to.database, staged)).toMatchObject({added: 5, files: 2, applied: false});
    expect(to.connection.prepare('SELECT * FROM full_answer_attempts').all()).toHaveLength(0);
    expect(await applyBackupV2(to.database, staged, to.paths)).toMatchObject({added: 5, restoredFiles: 2, missingAudio: []});
    for (const asset of [first, tenth]) expect(await digest(path.join(to.paths.audioRoot, 'assets', asset.id + '.wav'))).toBe(asset.sha256);
    expect(await applyBackupV2(to.database, staged, to.paths)).toMatchObject({added: 0, restoredFiles: 0, retainedFiles: 2});
    expect(to.connection.prepare('SELECT * FROM ai_runs').all()).toHaveLength(0);
    expect(to.connection.prepare('SELECT * FROM app_device').all()).toHaveLength(0);
    await discardBackupStage(staged.directory, to.paths.workRoot);
  }, 60_000);

  it('rejects wrong passwords and damaged/truncated authentication before restoring or preserving a pre-backup', async () => {
    const from = await fixture(), to = await fixture(); await audio(from);
    const exported = await archive(from);
    await expect(stageBackupV2(exported.file, 'incorrect-password', to.paths)).rejects.toThrow(/密码/);
    const corrupt = path.join(from.root, 'corrupt.rdbackup'); await fs.copyFile(exported.file, corrupt);
    const handle = await fs.open(corrupt, 'r+'); const stat = await handle.stat();
    try {await handle.write(Buffer.alloc(16), 0, 16, stat.size - 16);} finally {await handle.close();}
    await expect(stageBackupV2(corrupt, password, to.paths)).rejects.toThrow(/损坏/);
    await fs.truncate(corrupt, stat.size - 19);
    await expect(stageBackupV2(corrupt, password, to.paths)).rejects.toThrow();
    expect(to.connection.prepare('SELECT * FROM questions').all()).toHaveLength(0);
    expect(await fs.readdir(to.paths.workRoot)).toEqual([]);
    await expect(fs.stat(to.paths.backupRoot)).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('explicitly carries missing original files while preserving their answer metadata', async () => {
    const from = await fixture(), to = await fixture(), asset = await audio(from); await fs.unlink(asset.file);
    const exported = await archive(from);
    expect(exported).toMatchObject({files: 0, missingAudio: [{id: asset.id, reason: 'file_missing'}]});
    const staged = await stageBackupV2(exported.file, password, to.paths);
    expect(await applyBackupV2(to.database, staged, to.paths)).toMatchObject({added: 3, restoredFiles: 0, missingAudio: [{id: asset.id, reason: 'file_missing'}]});
    expect(to.connection.prepare('SELECT id FROM answer_audio_assets').get()).toEqual({id: asset.id});
    await expect(fs.stat(path.join(to.paths.audioRoot, 'assets', asset.id + '.wav'))).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('does not resurrect a locally purged asset from an earlier archive and restores removed audio as removed', async () => {
    const from = await fixture(), to = await fixture(), asset = await audio(from), removed = await audio(from);
    const exported = await archive(from), staged = await stageBackupV2(exported.file, password, to.paths);
    await applyBackupV2(to.database, staged, to.paths);
    to.connection.prepare("UPDATE answer_audio_assets SET purged_at='2026-09-16T00:00:00Z',removed_at='2026-09-16T00:00:00Z' WHERE id=?").run(asset.id);
    to.connection.prepare("UPDATE answer_audio_assets SET removed_at='2026-09-16T00:00:00Z' WHERE id=?").run(removed.id);
    await fs.unlink(path.join(to.paths.audioRoot, 'assets', asset.id + '.wav'));
    await fs.unlink(path.join(to.paths.audioRoot, 'assets', removed.id + '.wav'));
    expect(await applyBackupV2(to.database, staged, to.paths)).toMatchObject({added: 0, skippedDeleted: 1, restoredFiles: 1});
    await expect(fs.stat(path.join(to.paths.audioRoot, 'assets', asset.id + '.wav'))).rejects.toMatchObject({code: 'ENOENT'});
    expect(to.connection.prepare('SELECT removed_at,purged_at FROM answer_audio_assets WHERE id=?').get(removed.id)).toEqual({removed_at: '2026-09-16T00:00:00Z', purged_at: null});
  });

  it('incoming permanent-deletion markers win only for the same immutable asset identity', async () => {
    const from = await fixture(), to = await fixture(), asset = await audio(from);
    const initial = await archive(from), firstStage = await stageBackupV2(initial.file, password, to.paths);
    await applyBackupV2(to.database, firstStage, to.paths);
    from.connection.prepare("UPDATE answer_audio_assets SET purged_at='2026-09-16T00:00:00Z',removed_at='2026-09-16T00:00:00Z' WHERE id=?").run(asset.id);
    await fs.unlink(asset.file);
    const deleted = await archive(from), deletedStage = await stageBackupV2(deleted.file, password, to.paths);
    expect(deleted.files).toBe(0);
    expect(await applyBackupV2(to.database, deletedStage, to.paths)).toMatchObject({deletionMarkers: 1, skippedDeleted: 1});
    expect(to.connection.prepare('SELECT purged_at FROM answer_audio_assets WHERE id=?').get(asset.id)).toEqual({purged_at: '2026-09-16T00:00:00Z'});
    await expect(fs.stat(path.join(to.paths.audioRoot, 'assets', asset.id + '.wav'))).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('fails safely when staged bytes change and rolls back answer rows', async () => {
    const from = await fixture(), to = await fixture(), asset = await audio(from);
    const exported = await archive(from), staged = await stageBackupV2(exported.file, password, to.paths);
    await fs.writeFile(staged.files.get(asset.id)!, randomBytes(asset.size));
    await expect(applyBackupV2(to.database, staged, to.paths)).rejects.toThrow(/暂存音频/);
    expect(to.connection.prepare('SELECT * FROM full_answer_attempts').all()).toHaveLength(0);
    await expect(fs.stat(path.join(to.paths.audioRoot, 'assets', asset.id + '.wav'))).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('reads v1 backups and creates a v2 pre-restore backup including current originals', async () => {
    const from = await fixture(), to = await fixture(); question(from);
    const legacy = path.join(from.root, 'legacy.rdbackup'); await fs.writeFile(legacy, await exportWebBackup(from.database, password));
    expect(await isBackupV2(legacy)).toBe(false);
    expect(await inspectLegacyBackup(to.database, legacy, password)).toMatchObject({added: 1, applied: false});
    const original = await audio(to);
    const prior = await preserveBeforeRestore(to.database, password, to.paths);
    expect(prior.files).toBe(1);
    const staged = await stageBackupV2(prior.file, password, from.paths);
    expect(staged.files.has(original.id)).toBe(true);
    expect(WEB_BACKUP_TABLES).toEqual(expect.arrayContaining(['sentence_feedback_events', 'context_practice_tasks', 'coaching_practice_links', 'full_answer_attempts', 'answer_audio_assets']));
    expect(WEB_BACKUP_TABLES).not.toContain('answer_audio_uploads');
  });

  it('resumes raw binary uploads and verifies duplicated chunks without base64', async () => {
    const f = await fixture(), id = randomUUID(), first = randomBytes(BACKUP_CHUNK_BYTES), last = randomBytes(12);
    expect(await beginBackupUpload(f.paths.workRoot, id, first.length + last.length)).toMatchObject({offset: 0});
    expect(await appendBackupChunk(f.paths.workRoot, id, 0, first)).toEqual({nextOffset: first.length, complete: false});
    expect(await appendBackupChunk(f.paths.workRoot, id, 0, first)).toEqual({nextOffset: first.length, complete: false});
    await expect(appendBackupChunk(f.paths.workRoot, id, 0, randomBytes(first.length))).rejects.toThrow(/不一致/);
    expect(await beginBackupUpload(f.paths.workRoot, id, first.length + last.length)).toMatchObject({offset: first.length});
    expect(await appendBackupChunk(f.paths.workRoot, id, first.length, last)).toEqual({nextOffset: first.length + last.length, complete: true});
    const saved = await getBackupUpload(f.paths.workRoot, id);
    expect(saved.complete).toBe(true);
    expect(await digest(saved.file)).toBe(createHash('sha256').update(first).update(last).digest('hex'));
    await expect(beginBackupUpload(f.paths.workRoot, id, 1)).rejects.toThrow(/另一份/);
  });

  it.each(['v1','v2'] as const)('fills empty role speech preferences from %s without replacing existing user choices', async format => {
    const from = await fixture(), to = await fixture();
    const archived = JSON.stringify({version: 4, learning: {voice: 'Mia', accent: 'en-GB'}, teacher: {voice: 'Chloe', accent: 'en-US'}, playbackRate: 1.1});
    const existing = JSON.stringify({version: 4, learning: {voice: 'Milo', accent: 'en-US'}, teacher: {voice: 'Dean', accent: 'en-GB'}, playbackRate: .85});
    from.connection.prepare('INSERT INTO user_settings(id,auto_play,speech_preferences_json) VALUES(1,0,?)').run(archived);
    to.connection.exec('INSERT INTO user_settings(id,auto_play,speech_preferences_json) VALUES(1,1,NULL)');
    let restore: (apply: boolean) => Promise<unknown>;
    if (format === 'v1') {
      const bytes = await exportWebBackup(from.database, password);
      const {restoreWebBackup} = await import('@/lib/backup/web-business');
      restore = apply => restoreWebBackup(to.database, bytes, password, apply);
    } else {
      const exported = await archive(from), staged = await stageBackupV2(exported.file, password, to.paths);
      restore = apply => apply ? applyBackupV2(to.database, staged, to.paths) : inspectBackupV2(to.database, staged);
    }
    expect(await restore(false)).toMatchObject({added: 0, settingsToRestore: 1});
    expect(to.connection.prepare('SELECT speech_preferences_json FROM user_settings WHERE id=1').get()).toEqual({speech_preferences_json: null});
    expect(await restore(true)).toMatchObject({added: 0, restoredSettings: 1});
    expect(to.connection.prepare('SELECT speech_preferences_json,auto_play FROM user_settings WHERE id=1').get()).toEqual({speech_preferences_json: archived, auto_play: 1});
    to.connection.prepare('UPDATE user_settings SET speech_preferences_json=? WHERE id=1').run(existing);
    expect(await restore(true)).toMatchObject({restoredSettings: 0});
    expect(to.connection.prepare('SELECT speech_preferences_json FROM user_settings WHERE id=1').get()).toEqual({speech_preferences_json: existing});
  });

  it('preserves explicit recording time and leaves it unknown in older archives without the columns', async () => {
    const from = await fixture(), to = await fixture(), legacyTo = await fixture(), asset = await audio(from);
    const recordedAt = '2026-09-10T08:30:00.000Z';
    from.connection.prepare("UPDATE answer_audio_assets SET recorded_at=?,recorded_at_source='user_provided' WHERE id=?").run(recordedAt, asset.id);
    const current = await archive(from), currentStage = await stageBackupV2(current.file, password, to.paths);
    await applyBackupV2(to.database, currentStage, to.paths);
    expect(to.connection.prepare('SELECT recorded_at,recorded_at_source FROM answer_audio_assets WHERE id=?').get(asset.id)).toEqual({recorded_at: recordedAt, recorded_at_source: 'user_provided'});
    from.connection.exec('ALTER TABLE answer_audio_assets DROP COLUMN recorded_at; ALTER TABLE answer_audio_assets DROP COLUMN recorded_at_source');
    const old = await archive(from), oldStage = await stageBackupV2(old.file, password, legacyTo.paths);
    await applyBackupV2(legacyTo.database, oldStage, legacyTo.paths);
    expect(legacyTo.connection.prepare('SELECT recorded_at,recorded_at_source FROM answer_audio_assets WHERE id=?').get(asset.id)).toEqual({recorded_at: null, recorded_at_source: 'unknown'});
  });
});
