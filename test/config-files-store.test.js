import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, loadEnvFile, parsePositiveInt } from '../src/config.js';
import {
  extractVideoId,
  isTikTokUrl,
  makeDownloadLayout,
  normalizeUsername,
  shouldUploadToDiscord,
  slugify,
} from '../src/util/files.js';
import { createStore } from '../src/state/store.js';

test('loadEnvFile reads simple env files without overriding existing values', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tiktok-dlp-env-'));
  try {
    const file = path.join(dir, '.env');
    await writeFile(file, 'DISCORD_TOKEN=from-file\nQUOTED="hello world"\n');
    const env = { DISCORD_TOKEN: 'existing' };
    await loadEnvFile(file, env);
    assert.equal(env.DISCORD_TOKEN, 'existing');
    assert.equal(env.QUOTED, 'hello world');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadConfig resolves paths and upload limits', () => {
  const config = loadConfig({
    DATA_DIR: './x',
    DISCORD_UPLOAD_LIMIT_MB: '2',
    HTTP_PORT: '9999',
  }, '/tmp/project');
  assert.equal(config.dataDir, '/tmp/project/x');
  assert.equal(config.discordUploadLimitBytes, 2 * 1024 * 1024);
  assert.equal(config.httpPort, 9999);
});

test('parsePositiveInt falls back for invalid input', () => {
  assert.equal(parsePositiveInt('15', 1), 15);
  assert.equal(parsePositiveInt('0', 1), 1);
  assert.equal(parsePositiveInt('nope', 7), 7);
});

test('username and TikTok URL helpers normalize supported forms', () => {
  assert.equal(normalizeUsername('@openai'), 'openai');
  assert.equal(normalizeUsername('https://www.tiktok.com/@openai/video/123'), 'openai');
  assert.equal(isTikTokUrl('https://www.tiktok.com/@openai/video/123'), true);
  assert.equal(isTikTokUrl('https://example.com/nope'), false);
  assert.equal(extractVideoId('https://www.tiktok.com/@openai/video/7350000000000000000'), '7350000000000000000');
  assert.throws(() => normalizeUsername('../bad'));
});

test('download layout is stable and collision resistant', () => {
  const layout = makeDownloadLayout({
    downloadDir: '/data/downloads',
  }, {
    id: '12345678901',
    uploader: 'creator.name',
    title: 'hello world! #1',
    timestamp: 1710000000,
  });
  assert.equal(layout.username, 'creator.name');
  assert.equal(layout.videoId, '12345678901');
  assert.equal(layout.dir, '/data/downloads/creator.name/2024/03/09');
  assert.match(layout.basename, /^20240309T160000Z__creator.name__12345678901__hello-world-1$/);
  assert.equal(slugify(''), 'video');
});

test('delivery size helper respects configured Discord limit', () => {
  const config = { discordUploadLimitBytes: 10 };
  assert.equal(shouldUploadToDiscord(10, config), true);
  assert.equal(shouldUploadToDiscord(11, config), false);
  assert.equal(shouldUploadToDiscord(0, config), false);
});

test('store persists watches, seen videos, jobs, files, and link tokens', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tiktok-dlp-store-'));
  const store = createStore(path.join(dir, 'state.db'));
  try {
    store.addWatch('openai', 'channel1', 1000);
    assert.equal(store.getWatch('openai').channel_id, 'channel1');
    assert.equal(store.listWatches().length, 1);

    store.markVideoSeen({
      videoId: 'v1',
      username: 'openai',
      sourceUrl: 'https://www.tiktok.com/@openai/video/v1',
      title: 'title',
    }, 2000);
    assert.equal(store.hasSeenVideo('v1'), true);

    const jobId = store.createJob({ type: 'manual', sourceUrl: 'https://www.tiktok.com/@openai/video/v1' }, 3000);
    const fileId = store.createFileRecord({
      videoId: 'v1',
      username: 'openai',
      sourceUrl: 'https://www.tiktok.com/@openai/video/v1',
      filePath: path.join(dir, 'video.mp4'),
      filename: 'video.mp4',
      sizeBytes: 123,
    }, 4000);
    store.updateJob(jobId, { status: 'complete', file_id: fileId }, 5000);
    store.createLinkToken({ token: 'tok', fileId, expiresAt: 7000 }, 6000);

    assert.equal(store.getValidToken('tok', 6500).filename, 'video.mp4');
    assert.equal(store.getValidToken('tok', 7500), null);
    assert.equal(store.stats().watchCount, 1);
    assert.equal(store.listJobs(1)[0].status, 'complete');
    assert.equal(store.removeWatch('openai'), true);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
