import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadConfig } from '../src/config.js';
import { isImportAuthorized, parseRangeHeader, startHttpServer, resolveDownloadPath } from '../src/http/server.js';
import { Store } from '../src/state/store.js';

test('resolveDownloadPath keeps files inside the download directory', () => {
  const downloadDir = path.join('/tmp', 'downloads');
  assert.equal(resolveDownloadPath(downloadDir, 'clip.mp4'), path.join(downloadDir, 'clip.mp4'));
  assert.equal(resolveDownloadPath(downloadDir, '../outside.mp4'), null);
  assert.equal(resolveDownloadPath(downloadDir, path.join(downloadDir, 'nested', '..', 'clip.mp4')), path.join(downloadDir, 'clip.mp4'));
});

test('parseRangeHeader accepts bounded and suffix byte ranges', () => {
  assert.deepEqual(parseRangeHeader('bytes=2-4', 10), { start: 2, end: 4 });
  assert.deepEqual(parseRangeHeader('bytes=-3', 10), { start: 7, end: 9 });
  assert.deepEqual(parseRangeHeader('bytes=8-', 10), { start: 8, end: 9 });
  assert.deepEqual(parseRangeHeader('bytes=20-25', 10), { invalid: true });
});

test('serves files only for valid tokens with private health, HEAD, and Range support', async (t) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'tiktok-http-'));
  const downloadDir = path.join(rootDir, 'downloads');
  const dbPath = path.join(rootDir, 'state.db');
  await mkdir(downloadDir, { recursive: true });

  const config = loadConfig({
    DATA_DIR: rootDir,
    DOWNLOAD_DIR: downloadDir,
    STATE_DB: dbPath,
    HTTP_PORT: '0',
  }, rootDir);
  const store = new Store(dbPath);

  const allowedPath = path.join(downloadDir, 'allowed.txt');
  const outsidePath = path.join(rootDir, 'outside.txt');
  const expiredPath = path.join(downloadDir, 'expired.txt');
  await writeFile(allowedPath, 'hello from inside\n');
  await writeFile(outsidePath, 'nope\n');
  await writeFile(expiredPath, 'too late\n');

  const validFileId = store.createFileRecord({
    sourceUrl: 'https://www.tiktok.com/@user/video/1',
    filePath: allowedPath,
    filename: 'greeting.txt',
    sizeBytes: Buffer.byteLength('hello from inside\n'),
  });
  store.createLinkToken({
    token: 'valid-token',
    fileId: validFileId,
    expiresAt: Date.now() + 60_000,
  });

  const traversalFileId = store.createFileRecord({
    sourceUrl: 'https://www.tiktok.com/@user/video/2',
    filePath: path.relative(downloadDir, outsidePath),
    filename: 'outside.txt',
    sizeBytes: Buffer.byteLength('nope\n'),
  });
  store.createLinkToken({
    token: 'traversal-token',
    fileId: traversalFileId,
    expiresAt: Date.now() + 60_000,
  });

  const expiredFileId = store.createFileRecord({
    sourceUrl: 'https://www.tiktok.com/@user/video/3',
    filePath: expiredPath,
    filename: 'expired.txt',
    sizeBytes: Buffer.byteLength('too late\n'),
  });
  store.createLinkToken({
    token: 'expired-token',
    fileId: expiredFileId,
    expiresAt: Date.now() - 60_000,
  });

  const imports = [];
  const creatorImportService = {
    start(input) {
      const record = {
        id: 1,
        username: input.username,
        status: 'queued',
        max_duration_seconds: input.maxDurationSeconds,
        created_at: Date.now(),
        updated_at: Date.now(),
      };
      imports.unshift(record);
      return { import: record, reused: false };
    },
    list: () => imports,
    get: (id) => imports.find((entry) => entry.id === id) ?? null,
    status: () => ({ active: 0, queued: imports.length, concurrency: 1 }),
  };
  const { server, address } = await startHttpServer({
    config,
    store,
    creatorImportService,
    host: '127.0.0.1',
    port: 0,
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    await rm(rootDir, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${address.port}`;

  const healthResponse = await fetch(`${baseUrl}/health`);
  assert.equal(healthResponse.status, 200);
  assert.equal(healthResponse.headers.get('content-type'), 'application/json; charset=utf-8');
  const health = await healthResponse.json();
  assert.deepEqual(health, { status: 'ok' });

  const healthHeadResponse = await fetch(`${baseUrl}/health`, { method: 'HEAD' });
  assert.equal(healthHeadResponse.status, 200);
  assert.equal(await healthHeadResponse.text(), '');

  const fileResponse = await fetch(`${baseUrl}/files/valid-token`);
  assert.equal(fileResponse.status, 200);
  assert.match(fileResponse.headers.get('content-disposition') ?? '', /attachment; filename="greeting.txt"/);
  assert.equal(await fileResponse.text(), 'hello from inside\n');

  const headResponse = await fetch(`${baseUrl}/files/valid-token`, { method: 'HEAD' });
  assert.equal(headResponse.status, 200);
  assert.equal(headResponse.headers.get('content-length'), String(Buffer.byteLength('hello from inside\n')));
  assert.equal(await headResponse.text(), '');

  const rangeResponse = await fetch(`${baseUrl}/files/valid-token`, { headers: { Range: 'bytes=6-9' } });
  assert.equal(rangeResponse.status, 206);
  assert.equal(rangeResponse.headers.get('content-range'), 'bytes 6-9/18');
  assert.equal(await rangeResponse.text(), 'from');

  const invalidRangeResponse = await fetch(`${baseUrl}/files/valid-token`, { headers: { Range: 'bytes=99-100' } });
  assert.equal(invalidRangeResponse.status, 416);

  const importResponse = await fetch(`${baseUrl}/api/imports`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: '@creator', maxDurationSeconds: 150 }),
  });
  assert.equal(importResponse.status, 202);
  const createdImport = await importResponse.json();
  assert.equal(createdImport.import.username, '@creator');
  assert.equal(createdImport.import.maxDurationSeconds, 150);

  const importsResponse = await fetch(`${baseUrl}/api/imports`);
  assert.equal(importsResponse.status, 200);
  const listedImports = await importsResponse.json();
  assert.equal(listedImports.imports.length, 1);
  assert.equal(listedImports.service.queued, 1);

  const importDetailResponse = await fetch(`${baseUrl}/api/imports/1`);
  assert.equal(importDetailResponse.status, 200);
  assert.equal((await importDetailResponse.json()).import.id, 1);

  const missingResponse = await fetch(`${baseUrl}/files/missing-token`);
  assert.equal(missingResponse.status, 404);
  assert.equal((await missingResponse.json()).error, 'File not found');

  const expiredResponse = await fetch(`${baseUrl}/files/expired-token`);
  assert.equal(expiredResponse.status, 404);

  const traversalResponse = await fetch(`${baseUrl}/files/traversal-token`);
  assert.equal(traversalResponse.status, 404);
});

test('creator import API requires a bearer token outside loopback', () => {
  const request = (remoteAddress, authorization = '') => ({
    socket: { remoteAddress },
    headers: { authorization },
  });
  assert.equal(isImportAuthorized(request('127.0.0.1'), {}), true);
  assert.equal(isImportAuthorized(request('10.0.0.4'), { importApiToken: 'secret' }), false);
  assert.equal(isImportAuthorized(
    request('10.0.0.4', 'Bearer secret'),
    { importApiToken: 'secret' },
  ), true);
  assert.equal(isImportAuthorized(
    request('10.0.0.4', 'Bearer wrong'),
    { importApiToken: 'secret' },
  ), false);
});
