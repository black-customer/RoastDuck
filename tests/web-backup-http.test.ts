import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {afterEach, expect, it, vi} from 'vitest';
import {assertBackupRequest, backupPaths, readBackupChunk} from '@/lib/backup/http';
import {allocateBackupDownload, cleanupExpiredBackupWork, getBackupDownload, publishBackupDownload, BACKUP_CHUNK_BYTES} from '@/lib/backup/work-store';
import {GET} from '@/app/api/data-backup/downloads/[id]/route';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== path.resolve('test-results') || !path.basename(root).startsWith('backup-http-')) throw new Error('Unsafe cleanup');
    await fs.rm(root, {recursive: true, force: true});
  }
});
async function setup() {
  await fs.mkdir('test-results', {recursive: true});
  const root = await fs.mkdtemp(path.resolve('test-results/backup-http-')); roots.push(root);
  vi.stubEnv('ROASTDUCK_DB', 'file:' + path.join(root, 'app.db'));
  return {root, ...backupPaths()};
}
const binaryHeaders = {'content-type': 'application/octet-stream', 'x-roastduck-backup': '1', origin: 'http://127.0.0.1:3001'};

it('rejects cross-site, cross-port, DNS-rebinding and simple upload requests', () => {
  const url = 'http://127.0.0.1:3001/api/data-backup/uploads/' + randomUUID();
  expect(() => assertBackupRequest(new Request(url, {method: 'PUT', headers: binaryHeaders}), true)).not.toThrow();
  for (const headers of [
    {...binaryHeaders, origin: 'https://elsewhere.example'},
    {...binaryHeaders, origin: 'http://127.0.0.1:3002'},
    {...binaryHeaders, host: 'attacker.example:3001'},
    {...binaryHeaders, 'sec-fetch-site': 'cross-site'},
    {...binaryHeaders, 'content-type': 'text/plain'},
    {...binaryHeaders, 'x-roastduck-backup': ''},
  ]) expect(() => assertBackupRequest(new Request(url, {method: 'PUT', headers}), true)).toThrow();
});

it('enforces the actual streamed chunk size even without a Content-Length header', async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {controller.enqueue(new Uint8Array(BACKUP_CHUNK_BYTES)); controller.enqueue(new Uint8Array(1));},
    cancel() {cancelled = true;},
  });
  const request = new Request('http://127.0.0.1:3001/api/data-backup', {method: 'PUT', headers: binaryHeaders, body, duplex: 'half'} as RequestInit);
  await expect(readBackupChunk(request)).rejects.toMatchObject({status: 413}); expect(cancelled).toBe(true);
});

it('downloads an already created artifact without putting private bytes in browser JSON', async () => {
  const paths = await setup(), item = await allocateBackupDownload(paths.workRoot);
  const bytes = Buffer.from('synthetic authenticated archive fixture'); await fs.writeFile(item.file, bytes);
  await publishBackupDownload(paths.workRoot, item.id);
  const response = await GET(new Request(`http://127.0.0.1:3001/api/data-backup/downloads/${item.id}`), {params: Promise.resolve({id: item.id})});
  expect(response.status).toBe(200);
  expect(response.headers.get('content-disposition')).toContain('.rdbackup');
  expect(response.headers.get('content-type')).toBe('application/octet-stream');
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('cross-origin-resource-policy')).toBe('same-origin');
  expect(Buffer.from(await response.arrayBuffer()).equals(bytes)).toBe(true);
});

it('GET for an unknown backup does not create a work directory or an export', async () => {
  const paths = await setup();
  await expect(getBackupDownload(paths.workRoot, randomUUID())).rejects.toMatchObject({code: 'ENOENT'});
  await expect(fs.stat(paths.workRoot)).rejects.toMatchObject({code: 'ENOENT'});
});

it('expires generated downloads while leaving originals and preserved backups intact', async () => {
  const paths = await setup(), item = await allocateBackupDownload(paths.workRoot);
  await fs.writeFile(item.file, 'synthetic encrypted archive'); await publishBackupDownload(paths.workRoot, item.id);
  await fs.mkdir(paths.audioRoot, {recursive: true}); await fs.mkdir(paths.backupRoot, {recursive: true});
  const original = path.join(paths.audioRoot, 'synthetic-original'), preserved = path.join(paths.backupRoot, 'before-restore.rdbackup');
  await fs.writeFile(original, 'synthetic original'); await fs.writeFile(preserved, 'preserved encrypted backup');
  await cleanupExpiredBackupWork(paths.workRoot, Date.now() + 25 * 60 * 60 * 1000);
  await expect(fs.stat(item.file)).rejects.toMatchObject({code: 'ENOENT'});
  expect(await fs.readFile(original, 'utf8')).toBe('synthetic original');
  expect(await fs.readFile(preserved, 'utf8')).toBe('preserved encrypted backup');
});
