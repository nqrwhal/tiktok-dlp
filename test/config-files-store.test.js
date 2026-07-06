import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, loadEnvFile, parsePositiveInt } from '../src/config.js';
import {
  extractVideoId,
  extractTikTokUrls,
  isTikTokUrl,
  makeDownloadLayout,
  normalizeUsername,
  shouldUploadToDiscord,
  slugify,
} from '../src/util/files.js';
import { createStore } from '../src/state/store.js';
import { buildDeliveryPayload, handleLinkButton, shouldIgnoreMessage, shouldShowHelp } from '../src/discord/client.js';
import { cleanupExpiredDownloads } from '../src/cleanup/downloads.js';

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
  assert.equal(config.publicBaseUrl, 'https://example.com');
  assert.equal(config.downloadLinkTtlMinutes, 30);
  assert.equal(config.downloadLinkTtlHours, 1);
  assert.equal(config.profileScanLimit, 5);
  assert.equal(config.profileBurstScanLimit, 20);
  assert.equal(config.monitorConcurrency, 2);
});

test('loadConfig supports minute TTL and ignores legacy hour TTL', () => {
  const minuteConfig = loadConfig({ DOWNLOAD_LINK_TTL_MINUTES: '45' }, '/tmp/project');
  assert.equal(minuteConfig.downloadLinkTtlMinutes, 45);
  assert.equal(minuteConfig.downloadLinkTtlHours, 1);

  const legacyConfig = loadConfig({ DOWNLOAD_LINK_TTL_HOURS: '360' }, '/tmp/project');
  assert.equal(legacyConfig.downloadLinkTtlMinutes, 30);
  assert.equal(legacyConfig.downloadLinkTtlHours, 1);
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
  assert.deepEqual(
    extractTikTokUrls('watch https://www.tiktok.com/@openai/video/7350000000000000000, and https://example.com/nope'),
    ['https://www.tiktok.com/@openai/video/7350000000000000000'],
  );
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
      requestedBy: 'user-1',
      sourceUrl: 'https://www.tiktok.com/@openai/video/v1',
      filePath: path.join(dir, 'video.mp4'),
      filename: 'video.mp4',
      sizeBytes: 123,
    }, 4000);
    store.updateJob(jobId, { status: 'complete', file_id: fileId }, 5000);
    store.createLinkToken({ token: 'tok', fileId, expiresAt: 7000 }, 6000);
    store.createLinkToken({ token: 'tok2', fileId, expiresAt: 9000 }, 6000);

    assert.equal(store.getLatestFileByVideoId('v1').filename, 'video.mp4');
    assert.equal(store.getLatestFileByVideoId('missing'), null);
    assert.equal(store.getValidToken('tok', 6500).filename, 'video.mp4');
    assert.equal(store.getValidToken('tok', 7500), null);
    assert.equal(store.getValidToken('tok2', 6500).filename, 'video.mp4');
    assert.equal(store.extendLinkToken('tok', 1000, 7500).expires_at, 8500);
    assert.equal(store.getValidToken('tok', 8000).filename, 'video.mp4');
    assert.equal(store.setLinkTokenPermanent('tok').expires_at, 0);
    assert.equal(store.getValidToken('tok', 999999999).filename, 'video.mp4');
    assert.equal(store.deleteExpiredTokens(999999999), 1);
    assert.equal(store.getToken('tok').expires_at, 0);
    assert.equal(store.getToken('tok2'), null);
    assert.equal(store.countDownloadLinksByRequester('user-1'), 1);
    assert.equal(store.listDownloadLinksByRequester('user-1')[0].token, 'tok');
    assert.equal(store.stats().watchCount, 1);
    assert.equal(store.listJobs(1)[0].status, 'complete');
    assert.equal(store.removeWatch('openai'), true);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('expired downloads remove both file records and disk files', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tiktok-dlp-expiry-'));
  const store = createStore(path.join(dir, 'state.db'));
  try {
    const filePath = path.join(dir, 'expired.mp4');
    await writeFile(filePath, 'expired');
    const expiredFileId = store.createFileRecord({
      videoId: 'expired',
      username: 'openai',
      sourceUrl: 'https://www.tiktok.com/@openai/video/expired',
      filePath,
      filename: 'expired.mp4',
      sizeBytes: 7,
    }, 1000);
    store.createLinkToken({ token: 'expired', fileId: expiredFileId, expiresAt: 2000 }, 1000);

    const keptPath = path.join(dir, 'kept.mp4');
    await writeFile(keptPath, 'kept');
    const keptFileId = store.createFileRecord({
      videoId: 'kept',
      username: 'openai',
      sourceUrl: 'https://www.tiktok.com/@openai/video/kept',
      filePath: keptPath,
      filename: 'kept.mp4',
      sizeBytes: 4,
    }, 1000);
    store.createLinkToken({ token: 'kept', fileId: keptFileId, expiresAt: 0 }, 1000);

    const result = await cleanupExpiredDownloads({
      config: { downloadDir: dir },
      store,
      now: 3000,
      log: { warn() {} },
    });

    assert.deepEqual(result, { files: 1, deleted: 1, failed: 0 });
    assert.equal(store.getToken('expired'), null);
    assert.equal(store.getToken('kept').filename, 'kept.mp4');
    await assert.rejects(access(filePath));
    await access(keptPath);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('store migrates older databases before creating indexes for new columns', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tiktok-dlp-migration-'));
  const dbPath = path.join(dir, 'state.db');
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE watched_users (
        username TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_checked_at INTEGER,
        last_success_at INTEGER,
        failure_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        next_check_at INTEGER
      );
      CREATE TABLE seen_videos (
        video_id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        source_url TEXT NOT NULL,
        title TEXT,
        seen_at INTEGER NOT NULL,
        alerted_at INTEGER
      );
      CREATE TABLE jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        username TEXT,
        source_url TEXT NOT NULL,
        video_id TEXT,
        title TEXT,
        file_id INTEGER,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        video_id TEXT,
        username TEXT,
        source_url TEXT NOT NULL,
        path TEXT NOT NULL,
        filename TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
  } finally {
    db.close();
  }

  const store = createStore(dbPath);
  try {
    const watchColumns = store.db.prepare('PRAGMA table_info(watched_users)').all().map((column) => column.name);
    const seenColumns = store.db.prepare('PRAGMA table_info(seen_videos)').all().map((column) => column.name);
    const jobColumns = store.db.prepare('PRAGMA table_info(jobs)').all().map((column) => column.name);
    const fileColumns = store.db.prepare('PRAGMA table_info(files)').all().map((column) => column.name);
    const indexes = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((index) => index.name);
    assert.ok(watchColumns.includes('creator_id'));
    assert.ok(watchColumns.includes('has_story'));
    assert.ok(watchColumns.includes('story_status_checked_at'));
    assert.ok(seenColumns.includes('next_deletion_check_at'));
    assert.ok(indexes.includes('idx_seen_videos_next_deletion_check_at'));
    assert.ok(jobColumns.includes('requested_by'));
    assert.ok(fileColumns.includes('requested_by'));
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('store purges download records by requester or globally', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tiktok-dlp-purge-'));
  const store = createStore(path.join(dir, 'state.db'));
  try {
    const fileId1 = store.createFileRecord({
      requestedBy: 'user-1',
      sourceUrl: 'https://www.tiktok.com/@openai/video/1',
      filePath: path.join(dir, 'one.mp4'),
      filename: 'one.mp4',
      sizeBytes: 1,
    }, 1000);
    const fileId2 = store.createFileRecord({
      requestedBy: 'user-2',
      sourceUrl: 'https://www.tiktok.com/@openai/video/2',
      filePath: path.join(dir, 'two.mp4'),
      filename: 'two.mp4',
      sizeBytes: 2,
    }, 1000);
    store.createJob({ type: 'manual', requestedBy: 'user-1', sourceUrl: 'https://www.tiktok.com/@openai/video/1' }, 1000);
    store.createJob({ type: 'manual', requestedBy: 'user-2', sourceUrl: 'https://www.tiktok.com/@openai/video/2' }, 1000);
    store.createLinkToken({ token: 'one', fileId: fileId1, expiresAt: 0 }, 1000);
    store.createLinkToken({ token: 'two', fileId: fileId2, expiresAt: 0 }, 1000);

    assert.deepEqual(store.listFilesForPurge({ requestedBy: 'user-1' }).map((file) => file.filename), ['one.mp4']);
    assert.deepEqual(store.purgeDownloads({ requestedBy: 'user-1' }), { files: 1, links: 1, jobs: 1 });
    assert.equal(store.getToken('one'), null);
    assert.equal(store.getToken('two').filename, 'two.mp4');
    assert.deepEqual(store.purgeDownloads(), { files: 1, links: 1, jobs: 1 });
    assert.equal(store.stats().fileCount, 0);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('download link listing can include monitored downloads', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tiktok-dlp-monitored-links-'));
  const store = createStore(path.join(dir, 'state.db'));
  try {
    const userFileId = store.createFileRecord({
      requestedBy: 'user-1',
      username: 'openai',
      sourceUrl: 'https://www.tiktok.com/@openai/video/1',
      filePath: path.join(dir, 'one.mp4'),
      filename: 'one.mp4',
      sizeBytes: 1,
    }, 1000);
    const monitorFileId = store.createFileRecord({
      username: 'openai',
      sourceUrl: 'https://www.tiktok.com/@openai/video/2',
      filePath: path.join(dir, 'two.mp4'),
      filename: 'two.mp4',
      sizeBytes: 2,
    }, 2000);
    const monitorJobId = store.createJob({
      type: 'monitor',
      sourceUrl: 'https://www.tiktok.com/@openai/video/2',
      title: 'monitored video',
    }, 2000);
    store.updateJob(monitorJobId, { status: 'complete', file_id: monitorFileId }, 2100);
    store.createLinkToken({ token: 'user-token', fileId: userFileId, expiresAt: 0 }, 1000);
    store.createLinkToken({ token: 'monitor-token', fileId: monitorFileId, expiresAt: 0 }, 2000);

    assert.deepEqual(
      store.listDownloadLinksByRequester('user-1').map((link) => link.token),
      ['user-token'],
    );
    assert.deepEqual(
      store.listDownloadLinksByRequester('user-1', { includeMonitored: true }).map((link) => link.token),
      ['monitor-token', 'user-token'],
    );
    assert.deepEqual(
      store.listDownloadLinksByRequester('user-1', { includeMonitored: true, limit: 1, offset: 1 }).map((link) => link.token),
      ['user-token'],
    );
    assert.equal(store.countDownloadLinksByRequester('user-1', { includeMonitored: true }), 2);
    assert.deepEqual(
      store.listDownloadLinksByRequester('user-1', { includeMonitored: true, username: 'OPENAI' }).map((link) => link.token),
      ['monitor-token', 'user-token'],
    );
    assert.deepEqual(
      store.listDownloadLinksByRequester('user-1', { includeMonitored: true, username: 'other' }).map((link) => link.token),
      [],
    );
    assert.equal(store.countDownloadLinksByRequester('user-1', { includeMonitored: true, username: 'openai' }), 2);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('store records watched username changes', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tiktok-dlp-watch-identity-'));
  const store = createStore(path.join(dir, 'state.db'));
  try {
    store.addWatch('old.creator', 'channel-1', 1000);
    const change = store.recordWatchIdentity('old.creator', {
      creatorId: 'stable-123',
      currentUsername: 'new.creator',
      hasStory: false,
    }, 2000);

    assert.deepEqual(change, {
      changed: true,
      username: 'new.creator',
      previousUsername: 'old.creator',
      creatorId: 'stable-123',
      secUid: '',
      authorId: '',
    });
    assert.equal(store.getWatch('old.creator'), null);
    assert.equal(store.getWatch('new.creator').previous_username, 'old.creator');
    assert.equal(store.getWatch('new.creator').creator_id, 'stable-123');
    assert.equal(store.getWatch('new.creator').has_story, 0);
    assert.equal(store.getWatch('new.creator').story_status_checked_at, 2000);
    assert.equal(store.listWatchUsernameHistory()[0].previous_username, 'old.creator');
    assert.equal(store.listWatchUsernameHistory()[0].new_username, 'new.creator');
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('store schedules and marks deletion checks for seen videos', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tiktok-dlp-deletion-checks-'));
  const store = createStore(path.join(dir, 'state.db'));
  try {
    const fileId = store.createFileRecord({
      videoId: 'v1',
      username: 'openai',
      sourceUrl: 'https://www.tiktok.com/@openai/video/v1',
      filePath: path.join(dir, 'video.mp4'),
      filename: 'video.mp4',
      sizeBytes: 123,
    }, 1000);
    store.createLinkToken({ token: 'permanent-token', fileId, expiresAt: 0 }, 1000);
    store.markVideoSeen({
      videoId: 'v1',
      username: 'openai',
      sourceUrl: 'https://www.tiktok.com/@openai/video/v1',
      title: 'title',
      alertedAt: 1000,
    }, 1000);
    store.scheduleVideoDeletionCheck('v1', 2000);

    assert.equal(store.listVideosDueForDeletionCheck(1999).length, 0);
    const due = store.listVideosDueForDeletionCheck(2000);
    assert.equal(due.length, 1);
    assert.equal(due[0].permanent_token, 'permanent-token');

    store.markVideoStillAvailable('v1', 3000, 2000);
    assert.equal(store.listVideosDueForDeletionCheck(2000).length, 0);
    assert.equal(store.listVideosDueForDeletionCheck(3000)[0].deletion_check_count, 1);

    const deleted = store.markVideoDeleted('v1', 4000);
    assert.equal(deleted.deleted_at, 4000);
    assert.equal(store.listVideosDueForDeletionCheck(9999).length, 0);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('store can make existing monitor download links permanent', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tiktok-dlp-monitor-permanent-'));
  const store = createStore(path.join(dir, 'state.db'));
  try {
    const manualFileId = store.createFileRecord({
      requestedBy: 'user-1',
      username: 'openai',
      sourceUrl: 'https://www.tiktok.com/@openai/video/1',
      filePath: path.join(dir, 'manual.mp4'),
      filename: 'manual.mp4',
      sizeBytes: 1,
    }, 1000);
    const monitorFileId = store.createFileRecord({
      username: 'openai',
      sourceUrl: 'https://www.tiktok.com/@openai/video/2',
      filePath: path.join(dir, 'monitor.mp4'),
      filename: 'monitor.mp4',
      sizeBytes: 2,
    }, 1000);
    const monitorJobId = store.createJob({
      type: 'monitor',
      username: 'openai',
      sourceUrl: 'https://www.tiktok.com/@openai/video/2',
    }, 1000);
    store.updateJob(monitorJobId, { file_id: monitorFileId }, 1000);
    store.createLinkToken({ token: 'manual-token', fileId: manualFileId, expiresAt: 2000 }, 1000);
    store.createLinkToken({ token: 'monitor-token', fileId: monitorFileId, expiresAt: 2000 }, 1000);

    assert.equal(store.setMonitorLinkTokensPermanent(), 1);
    assert.equal(store.getToken('manual-token').expires_at, 2000);
    assert.equal(store.getToken('monitor-token').expires_at, 0);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('store caps existing temporary link TTL without changing permanent links', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tiktok-dlp-cap-ttl-'));
  const store = createStore(path.join(dir, 'state.db'));
  try {
    const fileId = store.createFileRecord({
      requestedBy: 'user-1',
      username: 'openai',
      sourceUrl: 'https://www.tiktok.com/@openai/video/1',
      filePath: path.join(dir, 'video.mp4'),
      filename: 'video.mp4',
      sizeBytes: 1,
    }, 1000);
    store.createLinkToken({ token: 'long-temp', fileId, expiresAt: 15 * 24 * 60 * 60 * 1000 }, 2000);
    store.createLinkToken({ token: 'short-temp', fileId, expiresAt: 5000 }, 2000);
    store.createLinkToken({ token: 'permanent', fileId, expiresAt: 0 }, 2000);

    assert.equal(store.capTemporaryLinkTokenTtl(30 * 60 * 1000), 1);
    assert.equal(store.getToken('long-temp').expires_at, 2000 + 30 * 60 * 1000);
    assert.equal(store.getToken('short-temp').expires_at, 5000);
    assert.equal(store.getToken('permanent').expires_at, 0);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('permanent download listing dedupes files and keeps monitored results stable', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tiktok-dlp-permanent-links-'));
  const store = createStore(path.join(dir, 'state.db'));
  try {
    const userFileId = store.createFileRecord({
      requestedBy: 'user-1',
      username: 'OpenAI',
      sourceUrl: 'https://www.tiktok.com/@openai/video/1',
      filePath: path.join(dir, 'one.mp4'),
      filename: 'one.mp4',
      sizeBytes: 1,
    }, 1000);
    const olderJobId = store.createJob({
      type: 'manual',
      requestedBy: 'user-1',
      username: 'OpenAI',
      sourceUrl: 'https://www.tiktok.com/@openai/video/1',
      title: 'older title',
    }, 1100);
    store.updateJob(olderJobId, { file_id: userFileId }, 1150);
    const newerJobId = store.createJob({
      type: 'manual',
      requestedBy: 'user-1',
      username: 'OpenAI',
      sourceUrl: 'https://www.tiktok.com/@openai/video/1',
      title: 'newer title',
    }, 1200);
    store.updateJob(newerJobId, { file_id: userFileId }, 1250);
    store.createLinkToken({ token: 'user-temp', fileId: userFileId, expiresAt: 9000 }, 1300);
    store.createLinkToken({ token: 'user-perm-old', fileId: userFileId, expiresAt: 0 }, 1400);
    store.createLinkToken({ token: 'user-perm-new', fileId: userFileId, expiresAt: 0 }, 1500);

    const tempOnlyFileId = store.createFileRecord({
      requestedBy: 'user-1',
      username: 'openai',
      sourceUrl: 'https://www.tiktok.com/@openai/video/2',
      filePath: path.join(dir, 'two.mp4'),
      filename: 'two.mp4',
      sizeBytes: 2,
    }, 1600);
    store.createLinkToken({ token: 'temp-only', fileId: tempOnlyFileId, expiresAt: 9000 }, 1700);

    const monitorFileId = store.createFileRecord({
      username: 'OpenAI',
      sourceUrl: 'https://www.tiktok.com/@openai/video/3',
      filePath: path.join(dir, 'three.mp4'),
      filename: 'three.mp4',
      sizeBytes: 3,
    }, 1800);
    const monitorJobId = store.createJob({
      type: 'monitor',
      username: 'OpenAI',
      sourceUrl: 'https://www.tiktok.com/@openai/video/3',
      title: 'monitored title',
    }, 1900);
    store.updateJob(monitorJobId, { file_id: monitorFileId }, 1950);
    store.createLinkToken({ token: 'monitor-perm', fileId: monitorFileId, expiresAt: 0 }, 2000);

    assert.deepEqual(
      store.listPermanentDownloadsByRequester('user-1').map((link) => link.token),
      ['user-perm-new'],
    );
    assert.equal(store.listPermanentDownloadsByRequester('user-1')[0].title, 'newer title');
    assert.equal(store.countPermanentDownloadsByRequester('user-1'), 1);
    assert.deepEqual(
      store.listPermanentDownloadsByRequester('user-1', { username: 'openai' }).map((link) => link.token),
      ['user-perm-new'],
    );
    assert.deepEqual(
      store.listPermanentDownloadsByRequester('user-1', { includeMonitored: true, username: 'OPENAI' }).map((link) => link.token),
      ['monitor-perm', 'user-perm-new'],
    );
    assert.deepEqual(
      store.listPermanentDownloadsByRequester('user-1', { includeMonitored: true, limit: 1, offset: 1 }).map((link) => link.token),
      ['user-perm-new'],
    );
    assert.equal(store.countPermanentDownloadsByRequester('user-1', { includeMonitored: true, username: 'openai' }), 2);
    assert.equal(store.listPermanentDownloadsByRequester('user-1', { includeMonitored: true }).some((link) => link.token === 'temp-only'), false);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('delivery payload includes link-management buttons', async () => {
  const payload = await buildDeliveryPayload({
    token: 'abc',
    publicUrl: 'https://example.com/files/abc',
    title: 'clip',
    sourceUrl: 'https://www.tiktok.com/@openai/video/1',
    username: 'openai',
    timestamp: 1_700_000_000,
    sizeBytes: 20 * 1024 * 1024,
  }, {
    publicBaseUrl: 'https://example.com',
    discordUploadLimitBytes: 10,
    downloadLinkTtlMinutes: 30,
  }, 'link', {
    now: 1_700_000_120_000,
  });

  const fields = Object.fromEntries(payload.embeds[0].data.fields.map((field) => [field.name, field.value]));
  assert.equal(payload.content, undefined);
  assert.equal(payload.embeds[0].data.title, 'Downloaded post by @openai - 2m old');
  assert.equal(payload.embeds[0].data.description, 'clip');
  assert.equal(fields.Download, '[Click](https://example.com/files/abc)');
  assert.equal(fields.Retention, '30m');
  assert.equal(fields.Cache, 'N');
  assert.equal(payload.components.length, 1);
  assert.deepEqual(
    payload.components[0].components.map((button) => button.data.custom_id),
    ['link:new:abc', 'link:extend:abc', 'link:permanent:abc'],
  );
  assert.equal(payload.components[0].components[0].data.label, 'New 30m link');
  assert.equal(payload.components[0].components[1].data.label, 'Extend 30m');
  assert.equal(payload.components[0].components[2].data.label, 'Keep on server');
});

test('delivery payload distinguishes permanent server copies', async () => {
  const payload = await buildDeliveryPayload({
    token: 'abc',
    publicUrl: 'https://example.com/files/abc',
    title: 'clip',
    sourceUrl: 'https://www.tiktok.com/@openai/video/1',
    sizeBytes: 20 * 1024 * 1024,
    linkPermanent: true,
  }, {
    publicBaseUrl: 'https://example.com',
    discordUploadLimitBytes: 10,
    downloadLinkTtlMinutes: 30,
  }, 'link');

  const fields = Object.fromEntries(payload.embeds[0].data.fields.map((field) => [field.name, field.value]));
  assert.equal(payload.content, undefined);
  assert.equal(fields.Download, '[Click](https://example.com/files/abc)');
  assert.equal(fields.Retention, 'Permanent');
  assert.equal(fields.Cache, 'N');
});

test('reused downloads use links for auto delivery', async () => {
  const payload = await buildDeliveryPayload({
    token: 'abc',
    publicUrl: 'https://example.com/files/abc',
    filePath: '/tmp/video.mp4',
    filename: 'video.mp4',
    title: 'clip',
    sourceUrl: 'https://www.tiktok.com/@openai/video/1',
    sizeBytes: 1,
    reused: true,
  }, {
    publicBaseUrl: 'https://example.com',
    discordUploadLimitBytes: 10,
    downloadLinkTtlMinutes: 30,
  }, 'auto');

  const fields = Object.fromEntries(payload.embeds[0].data.fields.map((field) => [field.name, field.value]));
  assert.equal(payload.content, undefined);
  assert.equal(payload.files.length, 0);
  assert.equal(fields.Download, '[Click](https://example.com/files/abc)');
  assert.equal(fields.Retention, '30m');
  assert.equal(fields.Cache, 'Y');
});

test('help keyword works in DMs and scoped guild messages', () => {
  assert.equal(shouldShowHelp({ content: 'help', inGuild: () => false }), true);
  assert.equal(shouldShowHelp({ content: 'commands', inGuild: () => false }), true);
  assert.equal(shouldShowHelp({ content: 'help', inGuild: () => true, client: { user: { id: 'bot-1' } } }), false);
  assert.equal(shouldShowHelp({ content: 'tiktok help', inGuild: () => true }), true);
  assert.equal(shouldShowHelp({ content: '!tt help', inGuild: () => true }), true);
  assert.equal(shouldShowHelp({ content: '<@bot-1> help', inGuild: () => true, client: { user: { id: 'bot-1' } } }), true);
});

test('message handler ignores bot, webhook, system, and own messages', () => {
  assert.equal(shouldIgnoreMessage(null), true);
  assert.equal(shouldIgnoreMessage({ author: { bot: true } }), true);
  assert.equal(shouldIgnoreMessage({ webhookId: 'webhook-1', author: { bot: false } }), true);
  assert.equal(shouldIgnoreMessage({ system: true, author: { bot: false } }), true);
  assert.equal(shouldIgnoreMessage({ author: { id: 'bot-1', bot: false }, client: { user: { id: 'bot-1' } } }), true);
  assert.equal(shouldIgnoreMessage({ author: { id: 'user-1', bot: false }, client: { user: { id: 'bot-1' } } }), false);
});

test('link button actions create, extend, and persist links', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tiktok-dlp-buttons-'));
  const store = createStore(path.join(dir, 'state.db'));
  try {
    const fileId = store.createFileRecord({
      videoId: 'v1',
      username: 'openai',
      sourceUrl: 'https://www.tiktok.com/@openai/video/v1',
      filePath: path.join(dir, 'video.mp4'),
      filename: 'video.mp4',
      sizeBytes: 123,
    }, 1000);
    store.createLinkToken({ token: 'tok', fileId, expiresAt: 2000 }, 1000);

    const replies = [];
    const makeInteraction = (customId) => ({
      customId,
      reply: async (payload) => replies.push(payload),
    });
    const config = { publicBaseUrl: 'https://example.com', downloadLinkTtlMinutes: 30 };

    const beforeExtend = Date.now();
    await handleLinkButton({ interaction: makeInteraction('link:extend:tok'), config, store });
    assert.ok(store.getToken('tok').expires_at >= beforeExtend + 30 * 60 * 1000);

    await handleLinkButton({ interaction: makeInteraction('link:permanent:tok'), config, store });
    assert.equal(store.getToken('tok').expires_at, 0);

    const beforeNew = Date.now();
    await handleLinkButton({ interaction: makeInteraction('link:new:tok'), config, store });
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM link_tokens WHERE file_id = ?').get(fileId).count, 2);
    const newToken = store.db.prepare("SELECT * FROM link_tokens WHERE token <> 'tok'").get();
    assert.ok(newToken.expires_at >= beforeNew + 30 * 60 * 1000);
    assert.ok(newToken.expires_at < beforeNew + 31 * 60 * 1000);
    assert.equal(replies.length, 3);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
