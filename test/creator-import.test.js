import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createCreatorImportService, normalizeDurationLimit } from '../src/import/creator.js';
import { createStore } from '../src/state/store.js';

test('creator imports skip saved and long videos while continuing past item failures', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tiktok-import-'));
  const store = createStore(path.join(root, 'state.db'));
  const existingPath = path.join(root, 'saved.mp4');
  await writeFile(existingPath, 'saved');
  store.createFileRecord({
    videoId: '1000000000000000001',
    username: 'creator',
    sourceUrl: 'https://www.tiktok.com/@creator/video/1000000000000000001',
    filePath: existingPath,
    filename: 'saved.mp4',
    sizeBytes: 5,
  });

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
      ],
    }),
    metadataFetcher: async (sourceUrl) => {
      const id = sourceUrl.split('/').at(-1);
      return { ...entry(id), duration: id.endsWith('3') ? 90 : 180 };
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
    assert.equal(completed.discovered_count, 5);
    assert.equal(completed.processed_count, 5);
    assert.equal(completed.downloaded_count, 1);
    assert.equal(completed.skipped_existing_count, 1);
    assert.equal(completed.skipped_duration_count, 2);
    assert.equal(completed.failed_count, 1);
    assert.match(completed.last_error, /download failed/i);
    assert.deepEqual(requested.map(({ options }) => options.metadata.id), [
      '1000000000000000003',
      '1000000000000000005',
    ]);
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
