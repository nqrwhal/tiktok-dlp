import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadConfig } from '../src/config.js';
import { startHttpServer, resolveDownloadPath } from '../src/http/server.js';
import { Store } from '../src/state/store.js';

test('resolveDownloadPath keeps files inside the download directory', () => {
  const downloadDir = path.join('/tmp', 'downloads');
  assert.equal(resolveDownloadPath(downloadDir, 'clip.mp4'), path.join(downloadDir, 'clip.mp4'));
  assert.equal(resolveDownloadPath(downloadDir, '../outside.mp4'), null);
  assert.equal(resolveDownloadPath(downloadDir, path.join(downloadDir, 'nested', '..', 'clip.mp4')), path.join(downloadDir, 'clip.mp4'));
});

test('serves files only for valid tokens and reports health stats', async (t) => {
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

  const { server, address } = await startHttpServer({ config, store, host: '127.0.0.1', port: 0 });
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
  assert.equal(health.status, 'ok');
  assert.equal(health.stats.fileCount, 3);
  assert.equal(health.stats.watchCount, 0);

  const fileResponse = await fetch(`${baseUrl}/files/valid-token`);
  assert.equal(fileResponse.status, 200);
  assert.match(fileResponse.headers.get('content-disposition') ?? '', /attachment; filename="greeting.txt"/);
  assert.equal(await fileResponse.text(), 'hello from inside\n');

  const missingResponse = await fetch(`${baseUrl}/files/missing-token`);
  assert.equal(missingResponse.status, 404);
  assert.equal((await missingResponse.json()).error, 'File not found');

  const expiredResponse = await fetch(`${baseUrl}/files/expired-token`);
  assert.equal(expiredResponse.status, 404);

  const traversalResponse = await fetch(`${baseUrl}/files/traversal-token`);
  assert.equal(traversalResponse.status, 404);
});
