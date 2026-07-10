import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createCreatorImportService, normalizeDurationLimit } from '../src/import/creator.js';
import { createStore } from '../src/state/store.js';

test('creator imports skip saved or trashed videos and long videos while continuing past item failures', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tiktok-import-'));
  const store = createStore(path.join(root, 'state.db'));
  const existingPath = path.join(root, 'saved.mp4');
  await writeFile(existingPath, 'saved');
  const existingFileId = store.createFileRecord({
    videoId: '1000000000000000001',
    username: 'creator',
    sourceUrl: 'https://www.tiktok.com/@creator/video/1000000000000000001',
    filePath: existingPath,
    filename: 'saved.mp4',
    sizeBytes: 5,
  });
  store.trashFile(existingFileId);

  const requested = [];
  const service = createCreatorImportService({
    config: {
      importMaxDurationSeconds: 120,
      importConcurrency: 1,
      importProfileTimeoutMs: 10_000,
    },
    store,
    downloadService: {
      request: async (sourceUrl, options) => {
        requested.push({ sourceUrl, options });
        if (options.metadata.id === '1000000000000000005') throw new Error('download failed');
        return { reused: false };
      },
    },
    profileLister: async () => ({
      entries: [
        entry('1000000000000000001', 20),
        entry('1000000000000000002', 121),
        entry('1000000000000000003'),
        entry('1000000000000000004'),
        entry('1000000000000000005', 60),
        entry('1000000000000000006'),
      ],
    }),
    metadataFetcher: async (sourceUrl) => {
      const id = sourceUrl.split('/').at(-1);
      return { ...entry(id), duration: id.endsWith('3') ? 90 : id.endsWith('6') ? undefined : 180 };
    },
    logger: { warn() {}, error() {} },
  });

  try {
    const started = service.start({ username: '@creator' });
    assert.equal(started.reused, false);
    assert.match(started.import.status, /^(queued|running)$/);
    await service.waitForIdle();

    const completed = service.get(started.import.id);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.max_duration_seconds, 120);
    assert.equal(completed.discovered_count, 6);
    assert.equal(completed.processed_count, 6);
    assert.equal(completed.downloaded_count, 1);
    assert.equal(completed.skipped_existing_count, 1);
    assert.equal(completed.skipped_duration_count, 2);
    assert.equal(completed.skipped_unknown_duration_count, 1);
    assert.equal(completed.failed_count, 1);
    assert.match(completed.last_error, /download failed/i);
    assert.deepEqual(requested.map(({ options }) => options.metadata.id), [
      '1000000000000000003',
      '1000000000000000005',
    ]);
    assert.deepEqual(
      completed.items.map((item) => item.status),
      [
        'skipped_existing',
        'skipped_duration',
        'downloaded',
        'skipped_duration',
        'failed',
        'skipped_unknown_duration',
      ],
    );
    assert.match(completed.items.at(-1).error, /duration remained unavailable/i);
    assert.equal(requested[0].options.permanent, true);
    assert.equal(requested[0].options.type, 'import');
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('creator imports reuse an active job for the same username', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tiktok-import-active-'));
  await mkdir(root, { recursive: true });
  const store = createStore(path.join(root, 'state.db'));
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const service = createCreatorImportService({
    config: { importMaxDurationSeconds: 120 },
    store,
    downloadService: { request: async () => ({ reused: false }) },
    profileLister: async () => {
      await blocked;
      return { entries: [] };
    },
  });

  try {
    const first = service.start({ username: 'creator', maxDurationSeconds: 180 });
    const second = service.start({ username: 'CREATOR', maxDurationSeconds: 60 });
    assert.equal(second.reused, true);
    assert.equal(second.import.id, first.import.id);
    assert.equal(second.import.max_duration_seconds, 180);
    release();
    await service.waitForIdle();
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('creator imports resume persisted item checkpoints after restart without duplicate downloads', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tiktok-import-resume-'));
  const dbPath = path.join(root, 'state.db');
  let store = createStore(dbPath);
  try {
    const importId = store.createCreatorImport({ username: 'creator', maxDurationSeconds: 120 }, 1000);
    store.beginCreatorImport(importId, 1100);
    store.checkpointCreatorImportDiscovery(importId, [
      checkpoint(entry('1000000000000000101', 10), 1),
      checkpoint(entry('1000000000000000102', 10), 2),
      checkpoint(entry('1000000000000000103', 10), 3),
    ], 1200);
    const first = store.claimNextCreatorImportItem(importId, 1300);
    store.completeCreatorImportItem(first.id, {
      status: 'downloaded',
      videoId: first.video_id,
      durationSeconds: 10,
      fileId: 1,
    }, 1400);
    const interrupted = store.claimNextCreatorImportItem(importId, 1500);
    assert.equal(interrupted.video_id, '1000000000000000102');

    const savedPath = path.join(root, 'saved-after-crash.mp4');
    await writeFile(savedPath, 'saved');
    store.createFileRecord({
      videoId: interrupted.video_id,
      username: 'creator',
      sourceUrl: interrupted.source_url,
      filePath: savedPath,
      filename: 'saved-after-crash.mp4',
      sizeBytes: 5,
    }, 1600);
    store.close();
    store = createStore(dbPath);

    const requested = [];
    const service = createCreatorImportService({
      config: { importMaxDurationSeconds: 120, importConcurrency: 1 },
      store,
      profileLister: async () => {
        throw new Error('completed discovery must not be repeated');
      },
      downloadService: {
        request: async (sourceUrl, options) => {
          requested.push(options.metadata.id);
          return { reused: false, fileId: 99, sourceUrl };
        },
      },
      now: (() => {
        let value = 2000;
        return () => ++value;
      })(),
    });
    await service.waitForIdle();

    const completed = service.get(importId);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.resume_count, 1);
    assert.deepEqual(completed.items.map((item) => item.status), [
      'downloaded',
      'skipped_existing',
      'downloaded',
    ]);
    assert.deepEqual(requested, ['1000000000000000103']);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('running creator imports cancel cooperatively and retry only unfinished items', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tiktok-import-cancel-'));
  const store = createStore(path.join(root, 'state.db'));
  let releaseFirst;
  const blocked = new Promise((resolve) => { releaseFirst = resolve; });
  let firstStarted;
  const started = new Promise((resolve) => { firstStarted = resolve; });
  const requested = [];
  const service = createCreatorImportService({
    config: { importMaxDurationSeconds: 120, importConcurrency: 1 },
    store,
    profileLister: async () => ({
      entries: [entry('1000000000000000201', 10), entry('1000000000000000202', 10)],
    }),
    downloadService: {
      request: async (sourceUrl, options) => {
        requested.push(options.metadata.id);
        if (requested.length === 1) {
          firstStarted();
          await blocked;
        }
        return { reused: false, fileId: requested.length, sourceUrl };
      },
    },
  });

  try {
    const startedImport = service.start({ username: 'creator' });
    await started;
    const cancellation = service.cancel(startedImport.import.id);
    assert.equal(cancellation.accepted, true);
    assert.equal(cancellation.import.status, 'running');
    assert.ok(cancellation.import.cancel_requested_at);
    releaseFirst();
    await service.waitForIdle();

    const canceled = service.get(startedImport.import.id);
    assert.equal(canceled.status, 'canceled');
    assert.deepEqual(canceled.items.map((item) => item.status), ['downloaded', 'queued']);

    const retry = service.retry(startedImport.import.id);
    assert.equal(retry.accepted, true);
    await service.waitForIdle();
    const completed = service.get(startedImport.import.id);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.retry_count, 1);
    assert.deepEqual(completed.items.map((item) => item.status), ['downloaded', 'downloaded']);
    assert.deepEqual(requested, ['1000000000000000201', '1000000000000000202']);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('queued creator imports can be canceled before discovery starts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tiktok-import-cancel-queued-'));
  const store = createStore(path.join(root, 'state.db'));
  let releaseProfile;
  const blocked = new Promise((resolve) => { releaseProfile = resolve; });
  const listed = [];
  const service = createCreatorImportService({
    config: { importMaxDurationSeconds: 120, importConcurrency: 1 },
    store,
    profileLister: async (url) => {
      listed.push(url);
      if (listed.length === 1) await blocked;
      return { entries: [] };
    },
    downloadService: { request: async () => ({ reused: false }) },
  });

  try {
    const first = service.start({ username: 'first' });
    await waitFor(() => service.status().active === 1);
    const second = service.start({ username: 'second' });
    const cancellation = service.cancel(second.import.id);
    assert.equal(cancellation.accepted, true);
    assert.equal(cancellation.import.status, 'canceled');
    releaseProfile();
    await service.waitForIdle();
    assert.equal(service.get(first.import.id).status, 'completed');
    assert.equal(service.get(second.import.id).status, 'canceled');
    assert.equal(listed.length, 1);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('failed creator discovery can be retried on the same durable import record', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tiktok-import-retry-failed-'));
  const store = createStore(path.join(root, 'state.db'));
  let attempts = 0;
  const service = createCreatorImportService({
    config: { importMaxDurationSeconds: 120 },
    store,
    profileLister: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('profile lookup failed');
      return { entries: [] };
    },
    downloadService: { request: async () => ({ reused: false }) },
    logger: { warn() {}, error() {} },
  });

  try {
    const started = service.start({ username: 'creator' });
    await service.waitForIdle();
    assert.equal(service.get(started.import.id).status, 'failed');
    assert.match(service.get(started.import.id).last_error, /profile lookup failed/i);

    const retry = service.retry(started.import.id);
    assert.equal(retry.accepted, true);
    await service.waitForIdle();
    const completed = service.get(started.import.id);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.retry_count, 1);
    assert.equal(completed.last_error, null);
    assert.equal(attempts, 2);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('graceful import stop checkpoints the current item and leaves remaining work queued', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tiktok-import-stop-'));
  const store = createStore(path.join(root, 'state.db'));
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  let startedDownload;
  const downloadStarted = new Promise((resolve) => { startedDownload = resolve; });
  const service = createCreatorImportService({
    config: { importMaxDurationSeconds: 120, importConcurrency: 1 },
    store,
    profileLister: async () => ({
      entries: [entry('1000000000000000301', 10), entry('1000000000000000302', 10)],
    }),
    downloadService: {
      request: async () => {
        startedDownload();
        await blocked;
        return { reused: false, fileId: 1 };
      },
    },
  });

  try {
    const started = service.start({ username: 'creator' });
    await downloadStarted;
    const stopping = service.stop({ drain: true });
    release();
    await stopping;
    const paused = service.get(started.import.id);
    assert.equal(paused.status, 'queued');
    assert.deepEqual(paused.items.map((item) => item.status), ['downloaded', 'queued']);
    assert.equal(service.status().stopping, true);
    assert.throws(() => service.start({ username: 'other' }), /stopping/i);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('duration limits use a two-minute default and enforce safe bounds', () => {
  assert.equal(normalizeDurationLimit(undefined, 120), 120);
  assert.equal(normalizeDurationLimit(90, 120), 90);
  assert.throws(() => normalizeDurationLimit(0, 120), /between 1 and 3600/i);
  assert.throws(() => normalizeDurationLimit(3601, 120), /between 1 and 3600/i);
});

function entry(id, duration) {
  return {
    id,
    duration,
    uploader: 'creator',
    mediaType: 'video',
    url: `https://www.tiktok.com/@creator/video/${id}`,
    webpage_url: `https://www.tiktok.com/@creator/video/${id}`,
  };
}

function checkpoint(metadata, position) {
  return {
    itemKey: `video:${metadata.id}`,
    position,
    videoId: metadata.id,
    sourceUrl: metadata.webpage_url,
    title: metadata.title ?? '',
    metadataJson: JSON.stringify(metadata),
  };
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for import state.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
