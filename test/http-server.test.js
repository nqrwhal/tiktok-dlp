import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
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
        items: [{
          id: 1,
          position: 1,
          video_id: 'video-1',
          source_url: 'https://www.tiktok.com/@creator/video/video-1',
          title: 'Checkpointed item',
          status: 'queued',
          attempt_count: 0,
          updated_at: Date.now(),
        }],
      };
      imports.unshift(record);
      return { import: record, reused: false };
    },
    list: () => imports,
    get: (id) => imports.find((entry) => entry.id === id) ?? null,
    status: () => ({ active: 0, queued: imports.length, concurrency: 1 }),
    cancel(id) {
      const record = imports.find((entry) => entry.id === id);
      if (!record) return { accepted: false, reason: 'not_found', import: null };
      if (!['queued', 'running'].includes(record.status)) {
        return { accepted: false, reason: 'not_active', import: record };
      }
      record.cancel_requested_at = Date.now();
      if (record.status === 'queued') {
        record.status = 'canceled';
        record.canceled_at = Date.now();
        record.completed_at = Date.now();
      }
      return { accepted: true, reason: null, import: record };
    },
    retry(id) {
      const record = imports.find((entry) => entry.id === id);
      if (!record) return { accepted: false, reason: 'not_found', import: null };
      if (!['failed', 'canceled'].includes(record.status)) {
        return { accepted: false, reason: 'not_retryable', import: record };
      }
      record.status = 'queued';
      record.retry_count = Number(record.retry_count || 0) + 1;
      record.cancel_requested_at = null;
      record.canceled_at = null;
      record.completed_at = null;
      return { accepted: true, reason: null, import: record };
    },
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
  const importDetail = (await importDetailResponse.json()).import;
  assert.equal(importDetail.id, 1);
  assert.equal(importDetail.items[0].status, 'queued');

  const cancelImportResponse = await fetch(`${baseUrl}/api/imports/1/cancel`, { method: 'POST' });
  assert.equal(cancelImportResponse.status, 200);
  const canceledImport = await cancelImportResponse.json();
  assert.equal(canceledImport.cancellationRequested, true);
  assert.equal(canceledImport.import.status, 'canceled');

  const retryImportResponse = await fetch(`${baseUrl}/api/imports/1/retry`, { method: 'POST' });
  assert.equal(retryImportResponse.status, 202);
  const retriedImport = await retryImportResponse.json();
  assert.equal(retriedImport.retried, true);
  assert.equal(retriedImport.import.status, 'queued');
  assert.equal(retriedImport.import.retryCount, 1);

  const invalidRetryResponse = await fetch(`${baseUrl}/api/imports/1/retry`, { method: 'POST' });
  assert.equal(invalidRetryResponse.status, 409);
  imports[0].status = 'running';
  imports[0].cancel_requested_at = null;
  const runningCancelResponse = await fetch(`${baseUrl}/api/imports/1/cancel`, { method: 'POST' });
  assert.equal(runningCancelResponse.status, 202);
  assert.equal((await runningCancelResponse.json()).import.status, 'running');
  const missingCancelResponse = await fetch(`${baseUrl}/api/imports/999/cancel`, { method: 'POST' });
  assert.equal(missingCancelResponse.status, 404);

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

test('creator monitoring deletion removes every subscription and preserves archived files', async (t) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'tiktok-monitoring-delete-'));
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
  store.addWatch('Creator.Case', {
    guildId: 'guild-1',
    channelId: 'channel-1',
    createdBy: 'manager-1',
  });
  store.addWatch('Creator.Case', {
    guildId: 'guild-2',
    channelId: 'channel-2',
    createdBy: 'manager-2',
  });
  const archivedPath = path.join(downloadDir, 'saved.mp4');
  await writeFile(archivedPath, 'saved video');
  const fileId = store.createFileRecord({
    videoId: 'saved-1',
    username: 'Creator.Case',
    sourceUrl: 'https://www.tiktok.com/@Creator.Case/video/saved-1',
    filePath: archivedPath,
    filename: 'saved.mp4',
    sizeBytes: 11,
  });

  const { server, address } = await startHttpServer({
    config,
    store,
    host: '127.0.0.1',
    port: 0,
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    await rm(rootDir, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const wrongMethod = await fetch(`${baseUrl}/api/creators/creator.case/monitoring`, { method: 'POST' });
  assert.equal(wrongMethod.status, 405);
  assert.equal(store.listWatchSubscriptions('Creator.Case').length, 2);

  const stopped = await fetch(`${baseUrl}/api/creators/creator.case/monitoring`, { method: 'DELETE' });
  assert.equal(stopped.status, 200);
  assert.deepEqual(await stopped.json(), {
    username: 'Creator.Case',
    monitoring: false,
    removed: true,
    removedSubscriptions: 2,
  });
  assert.equal(store.getWatch('Creator.Case'), null);
  assert.equal(store.listWatchSubscriptions('Creator.Case').length, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM files WHERE id = ?').get(fileId).count, 1);
  await access(archivedPath);

  const repeated = await fetch(`${baseUrl}/api/creators/creator.case/monitoring`, { method: 'DELETE' });
  assert.equal(repeated.status, 200);
  assert.deepEqual(await repeated.json(), {
    username: 'creator.case',
    monitoring: false,
    removed: false,
    removedSubscriptions: 0,
  });
});

test('creator video deletion requires typed confirmation and trashes only that creator media', async (t) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'tiktok-creator-delete-'));
  const downloadDir = path.join(rootDir, 'downloads');
  const dbPath = path.join(rootDir, 'state.db');
  const creatorDir = path.join(downloadDir, 'creator');
  await mkdir(creatorDir, { recursive: true });

  const config = loadConfig({
    DATA_DIR: rootDir,
    DOWNLOAD_DIR: downloadDir,
    STATE_DB: dbPath,
    HTTP_PORT: '0',
  }, rootDir);
  const store = new Store(dbPath);
  const creatorVideoPath = path.join(creatorDir, '100.mp4');
  const sidecarPaths = [
    path.join(creatorDir, '100.info.json'),
    path.join(creatorDir, '100.description'),
    path.join(creatorDir, '100.image'),
  ];
  const unrelatedPath = path.join(creatorDir, '1000.mp4');
  await Promise.all([
    writeFile(creatorVideoPath, 'creator video'),
    ...sidecarPaths.map((sidecar) => writeFile(sidecar, 'metadata')),
    writeFile(unrelatedPath, 'other video'),
  ]);

  const creatorFileId = store.createFileRecord({
    videoId: '100',
    username: 'Creator',
    sourceUrl: 'https://www.tiktok.com/@creator/video/100',
    filePath: creatorVideoPath,
    filename: '100.mp4',
    sizeBytes: 13,
  });
  store.createLinkToken({
    token: 'creator-token',
    fileId: creatorFileId,
    expiresAt: 0,
  });
  const unrelatedFileId = store.createFileRecord({
    videoId: '1000',
    username: 'someone-else',
    sourceUrl: 'https://www.tiktok.com/@someone-else/video/1000',
    filePath: unrelatedPath,
    filename: '1000.mp4',
    sizeBytes: 11,
  });

  const { server, address } = await startHttpServer({
    config,
    store,
    host: '127.0.0.1',
    port: 0,
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    await rm(rootDir, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const unconfirmed = await fetch(`${baseUrl}/api/creators/Creator/videos`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirmUsername: '@wrong-creator' }),
  });
  assert.equal(unconfirmed.status, 400);
  await access(creatorVideoPath);

  const activeImportId = store.createCreatorImport({
    username: 'creator',
    maxDurationSeconds: 120,
  });
  const blockedByImport = await fetch(`${baseUrl}/api/creators/Creator/videos`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirmUsername: '@creator' }),
  });
  assert.equal(blockedByImport.status, 409);
  await access(creatorVideoPath);
  store.updateCreatorImport(activeImportId, { status: 'completed', completed_at: Date.now() });

  const deleted = await fetch(`${baseUrl}/api/creators/Creator/videos`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirmUsername: '@creator' }),
  });
  assert.equal(deleted.status, 200);
  assert.deepEqual(await deleted.json(), {
    username: 'Creator',
    deletedVideos: 1,
    deletedStoredFiles: 0,
    trashedVideos: 1,
    failedVideos: 0,
  });

  await access(creatorVideoPath);
  for (const sidecarPath of sidecarPaths) await access(sidecarPath);
  await access(unrelatedPath);
  assert.equal(store.getTrashedFile(creatorFileId)?.id, creatorFileId);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM files WHERE id = ?').get(unrelatedFileId).count, 1);
  assert.equal(store.getValidToken('creator-token'), null);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM link_tokens WHERE token = ?').get('creator-token').count, 1);
});

test('individual video deletion trashes, blocks delivery, and supports confirmed restore', async (t) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'tiktok-video-delete-'));
  const downloadDir = path.join(rootDir, 'downloads');
  const dbPath = path.join(rootDir, 'state.db');
  const creatorDir = path.join(downloadDir, 'creator');
  await mkdir(creatorDir, { recursive: true });

  const config = loadConfig({
    DATA_DIR: rootDir,
    DOWNLOAD_DIR: downloadDir,
    STATE_DB: dbPath,
    HTTP_PORT: '0',
  }, rootDir);
  const store = new Store(dbPath);
  const deletedPath = path.join(creatorDir, '200.mp4');
  const deletedSidecarPath = path.join(creatorDir, '200.info.json');
  const siblingPath = path.join(creatorDir, '201.mp4');
  await Promise.all([
    writeFile(deletedPath, 'delete this video'),
    writeFile(deletedSidecarPath, 'delete this metadata'),
    writeFile(siblingPath, 'keep this video'),
  ]);

  const deletedFileId = store.createFileRecord({
    videoId: '200',
    username: 'creator',
    sourceUrl: 'https://www.tiktok.com/@creator/video/200',
    filePath: deletedPath,
    filename: '200.mp4',
    sizeBytes: 17,
  });
  const siblingFileId = store.createFileRecord({
    videoId: '201',
    username: 'creator',
    sourceUrl: 'https://www.tiktok.com/@creator/video/201',
    filePath: siblingPath,
    filename: '201.mp4',
    sizeBytes: 15,
  });
  const sharedFileId = store.createFileRecord({
    videoId: '201-copy',
    username: 'creator',
    sourceUrl: 'https://www.tiktok.com/@creator/video/201',
    filePath: siblingPath,
    filename: '201.mp4',
    sizeBytes: 15,
  });
  store.createLinkToken({ token: 'deleted-token', fileId: deletedFileId, expiresAt: 0 });

  const { server, address } = await startHttpServer({
    config,
    store,
    host: '127.0.0.1',
    port: 0,
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    await rm(rootDir, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const emptyBookmarks = await fetch(`${baseUrl}/api/bookmarks`);
  assert.equal(emptyBookmarks.status, 200);
  assert.deepEqual(await emptyBookmarks.json(), { fileIds: [] });

  const bookmarked = await fetch(`${baseUrl}/api/bookmarks/${deletedFileId}`, { method: 'PUT' });
  assert.equal(bookmarked.status, 200);
  assert.deepEqual(await bookmarked.json(), { fileId: deletedFileId, bookmarked: true });

  const migratedBookmarks = await fetch(`${baseUrl}/api/bookmarks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fileIds: [siblingFileId, 999999] }),
  });
  assert.equal(migratedBookmarks.status, 200);
  assert.deepEqual(await migratedBookmarks.json(), { fileIds: [siblingFileId, deletedFileId] });

  const unbookmarked = await fetch(`${baseUrl}/api/bookmarks/${siblingFileId}`, { method: 'DELETE' });
  assert.equal(unbookmarked.status, 200);
  assert.deepEqual(await unbookmarked.json(), { fileId: siblingFileId, bookmarked: false });

  const unconfirmed = await fetch(`${baseUrl}/api/videos/${deletedFileId}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirmFileId: siblingFileId }),
  });
  assert.equal(unconfirmed.status, 400);
  await access(deletedPath);

  const deleted = await fetch(`${baseUrl}/api/videos/${deletedFileId}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirmFileId: deletedFileId }),
  });
  assert.equal(deleted.status, 200);
  const deletedBody = await deleted.json();
  assert.equal(deletedBody.fileId, deletedFileId);
  assert.equal(deletedBody.videoId, '200');
  assert.equal(deletedBody.username, 'creator');
  assert.equal(deletedBody.deletedVideo, true);
  assert.equal(deletedBody.deletedStoredFiles, 0);
  assert.equal(deletedBody.trashedVideo, true);
  assert.ok(deletedBody.purgeAt > deletedBody.trashedAt);

  await access(deletedPath);
  await access(deletedSidecarPath);
  await access(siblingPath);
  assert.equal(store.getTrashedFile(deletedFileId)?.id, deletedFileId);
  assert.deepEqual(store.listBookmarkedFileIds(), []);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM files WHERE id = ?').get(siblingFileId).count, 1);
  assert.equal((await fetch(`${baseUrl}/files/deleted-token`)).status, 404);

  const trash = await fetch(`${baseUrl}/api/trash?limit=1`);
  assert.equal(trash.status, 200);
  const trashBody = await trash.json();
  assert.equal(trashBody.retentionDays, 30);
  assert.equal(trashBody.videos[0].fileId, deletedFileId);
  assert.equal('path' in trashBody.videos[0], false);

  const unconfirmedRestore = await fetch(`${baseUrl}/api/videos/${deletedFileId}/restore`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirmFileId: siblingFileId }),
  });
  assert.equal(unconfirmedRestore.status, 400);

  const restored = await fetch(`${baseUrl}/api/videos/${deletedFileId}/restore`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirmFileId: deletedFileId }),
  });
  assert.equal(restored.status, 200);
  assert.deepEqual(await restored.json(), {
    fileId: deletedFileId,
    videoId: '200',
    username: 'creator',
    restoredVideo: true,
  });
  assert.equal(store.getTrashedFile(deletedFileId), null);
  assert.deepEqual(store.listBookmarkedFileIds(), [deletedFileId]);
  assert.equal((await fetch(`${baseUrl}/files/deleted-token`)).status, 200);

  const deletedSharedRecord = await fetch(`${baseUrl}/api/videos/${siblingFileId}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirmFileId: siblingFileId }),
  });
  assert.equal(deletedSharedRecord.status, 200);
  assert.equal((await deletedSharedRecord.json()).deletedStoredFiles, 0);
  await access(siblingPath);
  assert.equal(store.getTrashedFile(siblingFileId)?.id, siblingFileId);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM files WHERE id = ?').get(sharedFileId).count, 1);
});
