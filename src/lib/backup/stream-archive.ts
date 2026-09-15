import {createReadStream, createWriteStream, constants} from 'node:fs';
import fs, {type FileHandle} from 'node:fs/promises';
import path from 'node:path';
import {createCipheriv, createDecipheriv, createHash, pbkdf2, randomBytes, randomUUID} from 'node:crypto';
import {promisify} from 'node:util';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createGzip, createGunzip} from 'node:zlib';
import {createInterface} from 'node:readline';
import {z} from 'zod';
import type {DatabasePort, SqlReader, SqlWriter} from '@/lib/platform/database';
import {credentialValue} from '@/lib/app-services/shared';
import {WEB_BACKUP_TABLES, rowSchema, restoreWebBackup, missingSpeechPreferences} from './web-business';

// v1 remains readable. v2 uses the same password derivation and authenticated cipher,
// with bounded binary frames instead of an in-memory JSON/base64 envelope.
const MAGIC = Buffer.from('RDBAK2\r\n');
const ITERATIONS = 310_000;
const MAX_FRAME = 32 * 1024 * 1024;
const MAX_MEDIA = 100 * 1024 * 1024;
export const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024 * 1024;
const MAX_ROWS = 2_000_000;
const derive = promisify(pbkdf2);
const uuid = z.string().uuid();
const extension = z.enum(['webm', 'ogg', 'mp3', 'm4a', 'wav']);
type Row = z.infer<typeof rowSchema>;
type RecordRow = {table: string; row: Row};
const recordSchema = z.object({table: z.string(), row: rowSchema}).strict();
const assetSchema = z.object({
  id: uuid, upload_id: z.string().min(1), full_answer_id: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  byte_length: z.number().int().positive().max(MAX_MEDIA), extension,
  removed_at: z.string().nullable(), purged_at: z.string().nullable(),
});
type Asset = z.infer<typeof assetSchema>;
const headSchema = z.object({
  kind: z.literal('archive'), format: z.literal('roastduck-web-business-v2'),
  version: z.number().int().positive(), createdAt: z.string().datetime(),
}).strict();
type Head = z.infer<typeof headSchema>;
export type MissingAudio = {id: string; reason: 'file_missing' | 'file_conflict'};
export interface BackupPaths {audioRoot: string; workRoot: string; backupRoot: string}
export interface StagedBackup {
  directory: string; rowsPath: string; header: Head; assets: Asset[];
  files: Map<string, string>; missingAudio: MissingAudio[];
}
export class BackupError extends Error {
  constructor(message: string, readonly status = 400) {super(message);}
}
function checkPassword(password: string) {
  if (password.length < 10 || password.length > 1024) throw new BackupError('备份密码需为 10–1024 个字符。密码无法找回。');
}
async function key(password: string, salt: Buffer) {
  checkPassword(password);
  return derive(password, salt, ITERATIONS, 32, 'sha256');
}
async function readExactly(handle: FileHandle, bytes: Buffer, position: number) {
  let offset = 0;
  while (offset < bytes.length) {
    const next = await handle.read(bytes, offset, bytes.length - offset, position + offset);
    if (!next.bytesRead) throw new BackupError('备份文件不完整，现有资料未修改。');
    offset += next.bytesRead;
  }
}
function frame(value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > MAX_FRAME) throw new BackupError('单条业务记录过大，备份未完成。');
  const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}
function allowedTable(table: string) {
  if (!(WEB_BACKUP_TABLES as readonly string[]).includes(table)) throw new BackupError('备份包含不支持的业务表，现有数据未修改。');
}
function validRecord(raw: unknown): RecordRow {
  const value = recordSchema.parse(raw); allowedTable(value.table);
  if (credentialValue(JSON.stringify(value.row))) throw new BackupError('业务资料疑似包含凭证，已停止备份操作。');
  return value;
}
async function columns(tx: SqlReader, table: string) {
  return tx.all<{name: string; pk: number}>({sql: `PRAGMA table_info("${table}")`});
}
async function stageDirectory(workRoot: string) {
  await fs.mkdir(workRoot, {recursive: true, mode: 0o700});
  return fs.mkdtemp(path.join(workRoot, 'stage-'));
}
export async function discardBackupStage(directory: string, workRoot: string) {
  const resolved = path.resolve(directory), root = path.resolve(workRoot);
  if (path.dirname(resolved) !== root || !path.basename(resolved).startsWith('stage-')) throw new BackupError('备份暂存路径无效。');
  await fs.rm(resolved, {recursive: true, force: true});
}
async function assetFile(root: string, asset: Pick<Asset, 'id' | 'extension'>, create = false) {
  uuid.parse(asset.id); extension.parse(asset.extension);
  if (create) await fs.mkdir(path.join(root, 'assets'), {recursive: true, mode: 0o700});
  const expected = path.join(root, 'assets', `${asset.id}.${asset.extension}`);
  const realRoot = await fs.realpath(root).catch(() => path.resolve(root));
  const realParent = await fs.realpath(path.dirname(expected)).catch(() => path.join(realRoot, 'assets'));
  if (realParent !== path.join(realRoot, 'assets')) throw new BackupError('原声音频目录无效，已停止备份操作。');
  const realTarget = await fs.realpath(expected).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return path.join(realParent, path.basename(expected));
    throw error;
  });
  if (path.dirname(realTarget) !== realParent) throw new BackupError('原声音频路径无效，已停止备份操作。');
  return expected;
}
async function fileDigest(file: string) {
  const hash = createHash('sha256'); let bytes = 0;
  for await (const part of createReadStream(file)) {bytes += part.length; hash.update(part);}
  return {bytes, sha256: hash.digest('hex')};
}
async function matchesFile(file: string, asset: Asset) {
  const stat = await fs.stat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!stat) return null;
  if (!stat.isFile() || stat.size !== asset.byte_length) return false;
  return (await fileDigest(file)).sha256 === asset.sha256;
}
async function* records(file: string): AsyncGenerator<RecordRow> {
  const input = createReadStream(file);
  const lines = createInterface({input, crlfDelay: Infinity});
  try {for await (const line of lines) if (line) yield validRecord(JSON.parse(line));}
  finally {lines.close(); input.destroy();}
}
async function snapshot(database: DatabasePort, directory: string) {
  const rowsPath = path.join(directory, 'rows.jsonl'), handle = await fs.open(rowsPath, 'wx', 0o600);
  const assets: Asset[] = []; let rowCount = 0;
  try {
    const header = await database.read(async tx => {
      const [schema] = await tx.all<{version: number}>({sql: 'SELECT MAX(version) version FROM _schema_migrations'});
      for (const table of new Set(WEB_BACKUP_TABLES)) {
        if (!(await columns(tx, table)).length) continue;
        for (let offset = 0;; offset += 200) {
          const batch = await tx.all<Row>({sql: `SELECT * FROM "${table}" LIMIT 200 OFFSET ?`, args: [offset]});
          for (const row of batch) {
            const record = validRecord({table, row});
            if (++rowCount > MAX_ROWS) throw new BackupError('业务记录数量超过本版备份上限。');
            const line = JSON.stringify(record) + '\n';
            if (Buffer.byteLength(line) > MAX_FRAME) throw new BackupError('单条业务记录过大，备份未完成。');
            await handle.writeFile(line);
            if (table === 'answer_audio_assets') assets.push(assetSchema.parse(row));
          }
          if (batch.length < 200) break;
        }
      }
      return headSchema.parse({kind: 'archive', format: 'roastduck-web-business-v2', version: schema.version, createdAt: new Date().toISOString()});
    });
    await handle.sync();
    return {rowsPath, assets, header, rowCount};
  } finally {await handle.close();}
}

/** Writes one authenticated archive using bounded buffers; output must be a new private file. */
export async function exportBackupV2(database: DatabasePort, password: string, paths: BackupPaths, output: string) {
  checkPassword(password);
  const directory = await stageDirectory(paths.workRoot);
  let outputCreated = false;
  try {
    const captured = await snapshot(database, directory), missingAudio: MissingAudio[] = [];
    let fileCount = 0;
    async function* payload() {
      yield frame(captured.header);
      for await (const record of records(captured.rowsPath)) yield frame({kind: 'row', ...record});
      for (const asset of captured.assets) {
        if (asset.purged_at) continue;
        const file = await assetFile(paths.audioRoot, asset);
        const stat = await fs.stat(file).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        if (!stat) {missingAudio.push({id: asset.id, reason: 'file_missing'}); yield frame({kind: 'missing', id: asset.id}); continue;}
        if (!stat.isFile() || stat.size !== asset.byte_length) throw new BackupError('一份原声音频与记录不符，备份未完成。请检查音频历史。');
        yield frame({kind: 'audio', id: asset.id, extension: asset.extension, byteLength: asset.byte_length, sha256: asset.sha256});
        const digest = createHash('sha256'); let bytes = 0;
        for await (const part of createReadStream(file)) {bytes += part.length; digest.update(part); yield part as Buffer;}
        if (bytes !== asset.byte_length || digest.digest('hex') !== asset.sha256) throw new BackupError('打包期间原声音频发生变化，备份未完成，请重试。');
        fileCount++;
      }
      yield frame({kind: 'end', rows: captured.rowCount, files: fileCount, missing: missingAudio.length});
    }
    async function* boundedPayload() {
      let bytes = 0;
      for await (const part of payload()) {
        bytes += part.length;
        if (bytes > MAX_ARCHIVE_BYTES) throw new BackupError('备份内容超过本版 32 GiB 上限，导出未完成。');
        yield part;
      }
    }
    const salt = randomBytes(16), iv = randomBytes(12);
    const header = Buffer.from(JSON.stringify({format: 'RD-AESGCM-2', salt: salt.toString('hex'), iv: iv.toString('hex'), iterations: ITERATIONS, compression: 'gzip'}));
    const length = Buffer.alloc(4); length.writeUInt32BE(header.length);
    const aad = Buffer.concat([MAGIC, length, header]);
    const handle = await fs.open(output, 'wx', 0o600); outputCreated = true;
    try {await handle.writeFile(aad);} finally {await handle.close();}
    const cipher = createCipheriv('aes-256-gcm', await key(password, salt), iv); cipher.setAAD(aad);
    await pipeline(Readable.from(boundedPayload()), createGzip(), cipher, createWriteStream(output, {flags: 'a'}));
    const final = await fs.open(output, 'a');
    try {await final.writeFile(cipher.getAuthTag()); await final.sync();} finally {await final.close();}
    const bytes = (await fs.stat(output)).size;
    if (bytes > MAX_ARCHIVE_BYTES) throw new BackupError('备份超过本版 32 GiB 上限。');
    return {bytes, files: fileCount, missingAudio, createdAt: captured.header.createdAt};
  } catch (error) {
    if (outputCreated) await fs.unlink(output).catch(() => undefined);
    throw error;
  } finally {await discardBackupStage(directory, paths.workRoot);}
}

class BytesReader {
  private readonly source: AsyncIterator<Buffer>;
  private chunk = Buffer.alloc(0);
  private offset = 0;
  private consumed = 0;
  constructor(stream: AsyncIterable<Buffer>) {this.source = stream[Symbol.asyncIterator]();}
  async read(length: number, optional = false): Promise<Buffer | null> {
    const output = Buffer.alloc(length); let written = 0;
    while (written < length) {
      if (this.offset === this.chunk.length) {
        const next = await this.source.next();
        if (next.done) {if (optional && written === 0) return null; throw new BackupError('备份内容不完整，现有资料未修改。');}
        this.chunk = Buffer.from(next.value); this.offset = 0;
      }
      const take = Math.min(length - written, this.chunk.length - this.offset);
      this.chunk.copy(output, written, this.offset, this.offset + take); this.offset += take; written += take; this.consumed += take;
      if (this.consumed > MAX_ARCHIVE_BYTES) throw new BackupError('备份解压后超过本版大小上限。');
    }
    return output;
  }
  async frame(optional = false): Promise<unknown | null> {
    const length = await this.read(4, optional); if (!length) return null;
    const size = length.readUInt32BE();
    if (!size || size > MAX_FRAME) throw new BackupError('备份记录长度无效，现有资料未修改。');
    return JSON.parse((await this.read(size))!.toString('utf8'));
  }
  async file(length: number, output: string) {
    const handle = await fs.open(output, 'wx', 0o600), hash = createHash('sha256');
    try {
      for (let remaining = length; remaining > 0;) {
        const part = (await this.read(Math.min(128 * 1024, remaining)))!;
        await handle.writeFile(part); hash.update(part); remaining -= part.length;
      }
      await handle.sync(); return hash.digest('hex');
    } finally {await handle.close();}
  }
}

/** Authentication finishes before decompression, parsing, or any database/pre-backup write. */
export async function stageBackupV2(input: string, password: string, paths: BackupPaths): Promise<StagedBackup> {
  checkPassword(password);
  const directory = await stageDirectory(paths.workRoot), compressed = path.join(directory, 'authenticated.gz');
  let complete = false;
  try {
    const source = await fs.open(input, 'r');
    let start: number, end: number, salt: Buffer, iv: Buffer, aad: Buffer, tag: Buffer;
    try {
      const stat = await source.stat();
      if (stat.size < 48 || stat.size > MAX_ARCHIVE_BYTES) throw new BackupError('备份文件大小无效。');
      const prefix = Buffer.alloc(12); await readExactly(source, prefix, 0);
      if (!prefix.subarray(0, 8).equals(MAGIC)) throw new BackupError('这不是 v2 备份文件。');
      const size = prefix.readUInt32BE(8);
      if (size < 1 || size > 4096 || size + 28 >= stat.size) throw new BackupError('备份头无效。');
      const raw = Buffer.alloc(size); await readExactly(source, raw, 12);
      const header = z.object({format: z.literal('RD-AESGCM-2'), salt: z.string().regex(/^[a-f0-9]{32}$/), iv: z.string().regex(/^[a-f0-9]{24}$/), iterations: z.literal(ITERATIONS), compression: z.literal('gzip')}).strict().parse(JSON.parse(raw.toString('utf8')));
      salt = Buffer.from(header.salt, 'hex'); iv = Buffer.from(header.iv, 'hex'); aad = Buffer.concat([prefix, raw]);
      tag = Buffer.alloc(16); await readExactly(source, tag, stat.size - 16); start = 12 + size; end = stat.size - 17;
    } finally {await source.close();}
    const decipher = createDecipheriv('aes-256-gcm', await key(password, salt), iv); decipher.setAAD(aad); decipher.setAuthTag(tag);
    try {await pipeline(createReadStream(input, {start, end}), decipher, createWriteStream(compressed, {flags: 'wx', mode: 0o600}));}
    catch {throw new BackupError('密码不正确，或备份文件已损坏；现有资料未修改。');}
    const unzip = createGunzip(), compressedInput = createReadStream(compressed);
    const decompress = pipeline(compressedInput, unzip); void decompress.catch(() => undefined);
    const reader = new BytesReader(unzip as AsyncIterable<Buffer>);
    const rowsPath = path.join(directory, 'rows.jsonl'), rowsFile = await fs.open(rowsPath, 'wx', 0o600);
    const assets = new Map<string, Asset>(), files = new Map<string, string>(), missingAudio: MissingAudio[] = [];
    let rowCount = 0, mediaStarted = false;
    try {
      const header = headSchema.parse(await reader.frame());
      for (;;) {
        const raw = z.object({kind: z.string()}).passthrough().parse(await reader.frame());
        if (raw.kind === 'row') {
          if (mediaStarted) throw new BackupError('备份记录顺序无效。');
          const value = z.object({kind: z.literal('row'), table: z.string(), row: rowSchema}).strict().parse(raw);
          const record = validRecord({table: value.table, row: value.row});
          if (++rowCount > MAX_ROWS) throw new BackupError('备份记录数量超过本版上限。');
          await rowsFile.writeFile(JSON.stringify(record) + '\n');
          if (record.table === 'answer_audio_assets') {
            const asset = assetSchema.parse(record.row);
            if (assets.has(asset.id)) throw new BackupError('备份含有重复的音频身份。');
            assets.set(asset.id, asset);
          }
        } else if (raw.kind === 'audio' || raw.kind === 'missing') {
          mediaStarted = true;
          const id = uuid.parse(raw.id), asset = assets.get(id);
          if (!asset || asset.purged_at || files.has(id) || missingAudio.some(item => item.id === id)) throw new BackupError('备份音频与业务记录不一致。');
          if (raw.kind === 'missing') {
            z.object({kind: z.literal('missing'), id: uuid}).strict().parse(raw);
            missingAudio.push({id, reason: 'file_missing'}); continue;
          }
          const audio = z.object({kind: z.literal('audio'), id: uuid, extension, byteLength: z.number().int().positive().max(MAX_MEDIA), sha256: z.string()}).strict().parse(raw);
          if (audio.extension !== asset.extension || audio.byteLength !== asset.byte_length || audio.sha256 !== asset.sha256) throw new BackupError('备份音频清单与原始记录不一致。');
          const file = path.join(directory, id + '.' + asset.extension);
          if (await reader.file(audio.byteLength, file) !== asset.sha256) throw new BackupError('原声音频校验失败，现有资料未修改。');
          files.set(id, file);
        } else if (raw.kind === 'end') {
          const end = z.object({kind: z.literal('end'), rows: z.number().int(), files: z.number().int(), missing: z.number().int()}).strict().parse(raw);
          if (end.rows !== rowCount || end.files !== files.size || end.missing !== missingAudio.length || [...assets.values()].filter(asset => !asset.purged_at).length !== files.size + missingAudio.length || await reader.frame(true) !== null) throw new BackupError('备份结束清单不完整，现有资料未修改。');
          await decompress; await rowsFile.sync(); complete = true;
          return {directory, rowsPath, header, assets: [...assets.values()], files, missingAudio};
        } else throw new BackupError('备份包含未知记录。');
      }
    } finally {await rowsFile.close(); unzip.destroy(); compressedInput.destroy(); await decompress.catch(() => undefined);}
  } finally {
    await fs.unlink(compressed).catch(() => undefined);
    if (!complete) await discardBackupStage(directory, paths.workRoot);
  }
}

function restoredRow(table: string, original: Row): Row {
  const row = {...original};
  if ((table === 'light_study_sessions' || table === 'four_step_sessions') && row.status === 'active') row.status = 'paused';
  if (table === 'sentence_study_sessions' && row.status === 'active') {
    row.status = 'paused'; const view = JSON.parse(String(row.view_json)); view.status = 'paused'; row.view_json = JSON.stringify(view);
  }
  if (table === 'practice_materials') {row.lease_token = null; row.lease_until = null; if (['generating', 'reviewing'].includes(String(row.status))) row.status = 'queued';}
  if (table === 'runtime_requests' && row.state === 'pending') {row.state = 'unknown'; row.error_code = 'result_unknown';}
  return row;
}
function sameAsset(left: Row, right: Row) {
  return ['id', 'full_answer_id', 'sha256', 'byte_length', 'extension', 'upload_id'].every(field => left[field] === right[field]);
}
async function inspectRows(tx: SqlReader, staged: StagedBackup, apply = false) {
  const [schema] = await tx.all<{version: number}>({sql: 'SELECT MAX(version) version FROM _schema_migrations'});
  if (staged.header.version > schema.version) throw new BackupError('备份来自较新版本，请先升级软件。');
  const shapes = new Map<string, Awaited<ReturnType<typeof columns>>>(), seen = new Set<string>();
  let added = 0, conflicts = 0, unchanged = 0, deletionMarkers = 0, settingsToRestore = 0;
  for await (const {table, row: original} of records(staged.rowsPath)) {
    let shape = shapes.get(table); if (!shape) {shape = await columns(tx, table); shapes.set(table, shape);}
    const names = new Set(shape.map(column => column.name)), pk = shape.filter(column => column.pk).sort((a, b) => a.pk - b.pk).map(column => column.name);
    if (!pk.length || Object.keys(original).some(name => !names.has(name)) || pk.some(name => original[name] === undefined || original[name] === null)) throw new BackupError('备份业务字段不兼容，现有资料未修改。');
    const identity = JSON.stringify([table, ...pk.map(name => original[name])]);
    if (seen.has(identity)) throw new BackupError('备份含有重复的业务记录。'); seen.add(identity);
    const [current] = await tx.all<Row>({sql: `SELECT * FROM "${table}" WHERE ${pk.map(name => `"${name}" IS ?`).join(' AND ')}`, args: pk.map(name => original[name])});
    if (current) {
      if (Object.entries(original).every(([name, value]) => current[name] === value)) unchanged++; else conflicts++;
      if (table === 'user_settings') {
        const preferences = missingSpeechPreferences(current.speech_preferences_json, original.speech_preferences_json);
        if (preferences) {
          settingsToRestore++;
          if (apply) await (tx as SqlWriter).run({sql: 'UPDATE user_settings SET speech_preferences_json=? WHERE id=?', args: [preferences, current.id]});
        }
      }
      if (table === 'answer_audio_assets' && sameAsset(current, original)) {
        const removed = current.removed_at ?? original.removed_at, purged = current.purged_at ?? original.purged_at;
        if (removed !== current.removed_at || purged !== current.purged_at) {
          deletionMarkers++;
          if (apply) await (tx as SqlWriter).run({sql: 'UPDATE answer_audio_assets SET removed_at=?,purged_at=? WHERE id=?', args: [removed, purged, original.id]});
        }
      }
      continue;
    }
    const row = restoredRow(table, original); added++;
    if (apply) {
      const names = Object.keys(row);
      await (tx as SqlWriter).run({sql: `INSERT INTO "${table}" (${names.map(name => `"${name}"`).join(',')}) VALUES (${names.map(() => '?').join(',')})`, args: names.map(name => row[name])});
    }
  }
  return {added, conflicts, unchanged, deletionMarkers, settingsToRestore};
}
export async function inspectBackupV2(database: DatabasePort, staged: StagedBackup) {
  const summary = await database.read(tx => inspectRows(tx, staged));
  return {...summary, applied: false, files: staged.files.size, missingAudio: staged.missingAudio, createdAt: staged.header.createdAt};
}

/** Files are immutable. A retry reuses matching files; a failed DB transaction leaves
 * unreferenced files available for retry, never an overwritten answer or false receipt. */
export async function applyBackupV2(database: DatabasePort, staged: StagedBackup, paths: BackupPaths) {
  const missingAudio: MissingAudio[] = []; let restoredFiles = 0, retainedFiles = 0, skippedDeleted = 0;
  const purge = new Set<string>();
  const summary = await database.write(async tx => {
    await tx.run({sql: 'PRAGMA defer_foreign_keys=ON'});
    const result = await inspectRows(tx, staged, true);
    for (const asset of staged.assets) {
      const [current] = await tx.all<Row>({sql: 'SELECT * FROM answer_audio_assets WHERE id=?', args: [asset.id]});
      if (!current || !sameAsset(current, asset)) {missingAudio.push({id: asset.id, reason: 'file_conflict'}); continue;}
      const target = await assetFile(paths.audioRoot, asset, true);
      if (current.purged_at) {skippedDeleted++; purge.add(target); continue;}
      const source = staged.files.get(asset.id);
      const present = await matchesFile(target, asset);
      if (present === true) {retainedFiles++; continue;}
      if (present === false) {missingAudio.push({id: asset.id, reason: 'file_conflict'}); continue;}
      if (!source) {missingAudio.push({id: asset.id, reason: 'file_missing'}); continue;}
      // Copy, do not move: a rollback or process exit can replay the original staging file.
      await fs.copyFile(source, target, constants.COPYFILE_EXCL);
      if (!await matchesFile(target, asset)) {
        await fs.unlink(target).catch(() => undefined);
        throw new BackupError('恢复暂存音频发生变化，现有业务记录未修改。请重新检查备份。');
      }
      const handle = await fs.open(target, 'r+'); try {await handle.sync();} finally {await handle.close();}
      restoredFiles++;
    }
    return result;
  });
  // A second web process may purge while an otherwise read-only SQLite restore
  // transaction is copying a missing file. Recheck after publishing all bytes so
  // that an acknowledged purge cannot leave those bytes behind.
  const newlyPurged = await database.read(async tx => {
    const assets: Asset[] = [];
    for (const asset of staged.assets) {
      const [current] = await tx.all<Row>({sql: 'SELECT * FROM answer_audio_assets WHERE id=?', args: [asset.id]});
      if (current?.purged_at && sameAsset(current, asset)) assets.push(asset);
    }
    return assets;
  });
  for (const asset of newlyPurged) purge.add(await assetFile(paths.audioRoot, asset));
  let purgePending = 0;
  for (const file of purge) await fs.unlink(file).catch((error: NodeJS.ErrnoException) => {if (error.code !== 'ENOENT') purgePending++;});
  return {...summary, applied: true, restoredFiles, retainedFiles, skippedDeleted, purgePending, missingAudio, restoredSettings: summary.settingsToRestore, createdAt: staged.header.createdAt};
}

export async function isBackupV2(file: string) {
  const handle = await fs.open(file, 'r');
  try {const bytes = Buffer.alloc(8); await handle.read(bytes, 0, 8, 0); return bytes.equals(MAGIC);} finally {await handle.close();}
}
/** v1 is bounded by its historical 64 MiB format; v2 never takes this allocation path. */
export async function inspectLegacyBackup(database: DatabasePort, file: string, password: string, apply = false) {
  if ((await fs.stat(file)).size > 64 * 1024 * 1024) throw new BackupError('旧版备份超过原格式的大小限制。');
  return restoreWebBackup(database, await fs.readFile(file), password, apply);
}
export async function preserveBeforeRestore(database: DatabasePort, password: string, paths: BackupPaths) {
  await fs.mkdir(paths.backupRoot, {recursive: true, mode: 0o700});
  const file = path.join(paths.backupRoot, `before-restore-${randomUUID()}.rdbackup`);
  return {file, ...await exportBackupV2(database, password, paths, file)};
}
