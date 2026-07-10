import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, loadEnvFile, parseNonNegativeInt, parsePositiveInt } from '../src/config.js';
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
import { buildDeliveryPayload, canManageWatches, handleLinkButton, shouldIgnoreMessage, shouldShowHelp } from '../src/discord/client.js';
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
  assert.equal(config.maxDownloadQueueSize, 50);
  assert.equal(config.maxQueuedDownloadsPerUser, 3);
  assert.equal(config.importMaxDurationSeconds, 120);
  assert.equal(config.importConcurrency, 1);
  assert.equal(config.importProfileTimeoutMs, 600_000);
  assert.equal(config.cleanupOrphanGraceMinutes, 15);
  assert.equal(config.archiveTrashRetentionDays, 30);
  assert.equal(config.deletionCheckConcurrency, 2);
  assert.equal(config.maxSlideshowImages, 35);
  assert.equal(config.ytdlpTimeoutMs, 60_000);
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

test('archive trash retention accepts an explicit disabled value', () => {
  assert.equal(parseNonNegativeInt('0', 30), 0);
  assert.equal(parseNonNegativeInt('-1', 30), 30);
  assert.equal(loadConfig({ ARCHIVE_TRASH_RETENTION_DAYS: '0' }).archiveTrashRetentionDays, 0);
  assert.equal(loadConfig({ ARCHIVE_TRASH_RETENTION_DAYS: '45' }).archiveTrashRetentionDays, 45);
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
      requestedBy: 'user-1',
      username: 'openai',
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

    assert.equal(result.files, 1);
    assert.equal(result.deleted, 1);
    assert.equal(result.failed, 0);
    assert.equal(result.expiredTokens, 1);
    assert.equal(store.getToken('expired'), null);
    assert.equal(store.getToken('kept').filename, 'kept.mp4');
    await assert.rejects(access(filePath));
    await access(keptPath);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('cleanup never removes a shared path while another asset row has an active link', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tiktok-dlp-shared-cleanup-'));
  const store = createStore(path.join(dir, 'state.db'));
  try {
    const filePath = path.join(dir, 'shared.mp4');
    await writeFile(filePath, 'shared');
    const expiredId = store.createFileRecord({
      videoId: 'old', sourceUrl: 'https://example.test/old', filePath, filename: 'shared.mp4', sizeBytes: 6,
    }, 1000);
    const activeId = store.createFileRecord({
      videoId: 'new', sourceUrl: 'https://example.test/new', filePath, filename: 'shared.mp4', sizeBytes: 6,
    }, 1000);
    store.createLinkToken({ token: 'expired-shared', fileId: expiredId, expiresAt: 2000 }, 1000);
    store.createLinkToken({ token: 'active-shared', fileId: activeId, ownerId: 'user-2', expiresAt: 0 }, 1000);

    const result = await cleanupExpiredDownloads({ config: { downloadDir: dir }, store, now: 3000, log: { warn() {} } });
    assert.equal(result.files, 0);
    assert.equal(store.getToken('active-shared')?.filename, 'shared.mp4');
    await access(filePath);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('cleanup gives newly materialized unlinked files time to receive a delivery token', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tiktok-dlp-orphan-grace-'));
  const store = createStore(path.join(dir, 'state.db'));
  try {
    const filePath = path.join(dir, 'new.mp4');
    await writeFile(filePath, 'new video');
    const fileId = store.createFileRecord({
      videoId: 'new', sourceUrl: 'https://example.test/new', filePath, filename: 'new.mp4', sizeBytes: 9,
    }, 10_000);
    const config = { downloadDir: dir, cleanupOrphanGraceMinutes: 15 };

    const early = await cleanupExpiredDownloads({ config, store, now: 10_000 + 14 * 60_000, log: { warn() {} } });
    assert.equal(early.files, 0);
    await access(filePath);
    assert.equal(store.getLatestFileByVideoId('new')?.id, fileId);

    const late = await cleanupExpiredDownloads({ config, store, now: 10_000 + 16 * 60_000, log: { warn() {} } });
    assert.equal(late.files, 1);
    await assert.rejects(access(filePath), { code: 'ENOENT' });
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('cleanup records failed disk deletions as retryable trash state', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tiktok-dlp-trash-state-'));
  const store = createStore(path.join(dir, 'state.db'));
  try {
    const fileId = store.createFileRecord({
      videoId: 'outside-file',
      sourceUrl: 'https://www.tiktok.com/@openai/video/outside-file',
      filePath: path.join(os.tmpdir(), 'outside-download.mp4'),
      filename: 'outside-download.mp4',
      sizeBytes: 1,
    }, 1000);
    store.createLinkToken({ token: 'outside-file', fileId, expiresAt: 2000 }, 1000);

    const first = await cleanupExpiredDownloads({ config: { downloadDir: dir }, store, now: 3000, log: { warn() {} } });
    assert.equal(first.failed, 1);
    let state = store.db.prepare('SELECT delete_requested_at, delete_attempts, delete_error FROM files WHERE id = ?').get(fileId);
    assert.equal(state.delete_requested_at, 3000);
    assert.equal(state.delete_attempts, 1);
    assert.match(state.delete_error, /outside the configured download directory/i);
    assert.equal(store.getLatestFileByVideoId('outside-file'), null);

    const second = await cleanupExpiredDownloads({ config: { downloadDir: dir }, store, now: 4000, log: { warn() {} } });
    assert.equal(second.failed, 1);
    state = store.db.prepare('SELECT delete_attempts FROM files WHERE id = ?').get(fileId);
    assert.equal(state.delete_attempts, 2);

    store.createLinkToken({ token: 'revived-file', fileId, ownerId: 'user-1', expiresAt: 0 }, 4000);
    state = store.db.prepare('SELECT delete_requested_at, delete_error FROM files WHERE id = ?').get(fileId);
    assert.equal(state.delete_requested_at, null);
    assert.equal(state.delete_error, null);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('trashed files disappear from active lookups and can be restored with their deliveries intact', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tiktok-dlp-trash-restore-'));
  const store = createStore(path.join(dir, 'state.db'));
  try {
    const filePath = path.join(dir, 'restorable.mp4');
    await writeFile(filePath, 'video');
    const fileId = store.createFileRecord({
      videoId: 'restorable',
      requestedBy: 'user-1',
      username: 'creator',
      sourceUrl: 'https://www.tiktok.com/@creator/video/restorable',
      filePath,
      filename: 'restorable.mp4',
      sizeBytes: 5,
    }, 1000);
    store.createLinkToken({ token: 'restorable-token', fileId, ownerId: 'user-1', expiresAt: 0 }, 1000);

    assert.equal(store.trashFile(fileId, 2000)?.trashed_at, 2000);
    assert.equal(store.getLatestFileByVideoId('restorable'), null);
    assert.equal(store.getValidToken('restorable-token', 3000), null);
    assert.equal(store.getToken('restorable-token'), null);
    assert.equal(store.listDownloadLinksByRequester('user-1').length, 0);
    assert.equal(store.listPermanentDownloadsByRequester('user-1').length, 0);
    assert.equal(store.listPurgePlan().length, 0);
    assert.equal(store.stats().fileCount, 0);
    assert.equal(store.stats().trashCount, 1);
    assert.equal(store.listTrashedFiles()[0].id, fileId);
    assert.deepEqual(store.purgeDownloads(), { files: 0, links: 0, jobs: 0 });
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM link_tokens WHERE token = ?').get('restorable-token').count, 1);
    assert.throws(
      () => store.createLinkToken({ token: 'new-token', fileId, expiresAt: 0 }, 3000),
      /missing or trashed/i,
    );

    assert.equal(store.claimTrashedFilesForDeletion(2000, 2500, 1)[0].id, fileId);
    assert.equal(store.restoreTrashedFile(fileId), null);
    store.markFileDeletionFailed(fileId, new Error('temporary disk failure'), 2600);
    assert.equal(store.restoreTrashedFile(fileId)?.id, fileId);
    assert.equal(store.getValidToken('restorable-token', 3000)?.id, fileId);
    assert.equal(store.listPermanentDownloadsByRequester('user-1').length, 1);
    assert.equal(store.stats().fileCount, 1);
    assert.equal(store.stats().trashCount, 0);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('trash cleanup is bounded, honors its grace period, and removes non-MP4 sidecars', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tiktok-dlp-trash-retention-'));
  const store = createStore(path.join(dir, 'state.db'));
  const day = 24 * 60 * 60 * 1000;
  const now = 100 * day;
  try {
    const legacyPath = path.join(dir, 'legacy.jpg');
    const legacySidecars = [
      path.join(dir, 'legacy.m4a'),
      path.join(dir, 'legacy.info.json'),
      path.join(dir, 'legacy.description'),
    ];
    const nearCollision = path.join(dir, 'legacy-copy.info.json');
    const untrackedPrimary = path.join(dir, 'legacy.mp4');
    const zipPath = path.join(dir, 'archive.zip');
    const zipSidecars = [
      path.join(dir, 'slideshow-id.info.json'),
      path.join(dir, 'archive__001.jpg'),
    ];
    const recentPath = path.join(dir, 'recent.mp4');
    await Promise.all([
      writeFile(legacyPath, 'thumbnail'),
      ...legacySidecars.map((filePath) => writeFile(filePath, 'sidecar')),
      writeFile(nearCollision, 'keep'),
      writeFile(untrackedPrimary, 'keep primary'),
      writeFile(zipPath, 'zip'),
      ...zipSidecars.map((filePath) => writeFile(filePath, 'sidecar')),
      writeFile(recentPath, 'recent'),
    ]);

    const legacyId = store.createFileRecord({
      videoId: 'legacy', sourceUrl: 'https://example.test/legacy', filePath: legacyPath, filename: 'legacy.jpg', sizeBytes: 9,
    }, now - 50 * day);
    const zipId = store.createFileRecord({
      videoId: 'slideshow-id', sourceUrl: 'https://example.test/slideshow', filePath: zipPath, filename: 'archive.zip', sizeBytes: 3,
    }, now - 49 * day);
    const recentId = store.createFileRecord({
      videoId: 'recent', sourceUrl: 'https://example.test/recent', filePath: recentPath, filename: 'recent.mp4', sizeBytes: 6,
    }, now - 40 * day);
    store.createLinkToken({ token: 'legacy', fileId: legacyId, expiresAt: 0 }, now - 50 * day);
    store.createLinkToken({ token: 'zip', fileId: zipId, expiresAt: 0 }, now - 49 * day);
    store.createLinkToken({ token: 'recent', fileId: recentId, expiresAt: 0 }, now - 40 * day);
    store.trashFile(legacyId, now - 40 * day);
    store.trashFile(zipId, now - 35 * day);
    store.trashFile(recentId, now - 10 * day);

    const config = {
      downloadDir: dir,
      archiveTrashRetentionDays: 30,
      cleanupBatchSize: 1,
    };
    const first = await cleanupExpiredDownloads({ config, store, now, log: { warn() {} } });
    assert.equal(first.trashFiles, 1);
    assert.equal(first.trashDeleted, 4);
    await assert.rejects(access(legacyPath), { code: 'ENOENT' });
    for (const sidecar of legacySidecars) await assert.rejects(access(sidecar), { code: 'ENOENT' });
    await access(nearCollision);
    await access(untrackedPrimary);
    await access(zipPath);

    const second = await cleanupExpiredDownloads({ config, store, now, log: { warn() {} } });
    assert.equal(second.trashFiles, 1);
    assert.equal(second.trashDeleted, 3);
    await assert.rejects(access(zipPath), { code: 'ENOENT' });
    for (const sidecar of zipSidecars) await assert.rejects(access(sidecar), { code: 'ENOENT' });
    await access(recentPath);
    assert.equal(store.getTrashedFile(recentId)?.id, recentId);

    const disabled = await cleanupExpiredDownloads({
      config: { ...config, archiveTrashRetentionDays: 0 },
      store,
      now: now + 100 * day,
      log: { warn() {} },
    });
    assert.equal(disabled.trashFiles, 0);
    await access(recentPath);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('trash cleanup preserves shared bytes and sidecars referenced by an active record', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tiktok-dlp-trash-shared-'));
  const store = createStore(path.join(dir, 'state.db'));
  const day = 24 * 60 * 60 * 1000;
  const now = 100 * day;
  try {
    const filePath = path.join(dir, 'shared.mov');
    const sidecarPath = path.join(dir, 'shared.info.json');
    await writeFile(filePath, 'shared');
    await writeFile(sidecarPath, 'metadata');
    const trashedId = store.createFileRecord({
      videoId: 'trashed', sourceUrl: 'https://example.test/trashed', filePath, filename: 'shared.mov', sizeBytes: 6,
    }, now - 50 * day);
    const activeId = store.createFileRecord({
      videoId: 'active', sourceUrl: 'https://example.test/active', filePath, filename: 'shared.mov', sizeBytes: 6,
    }, now - 10 * day);
    store.createLinkToken({ token: 'trashed', fileId: trashedId, expiresAt: 0 }, now - 50 * day);
    store.createLinkToken({ token: 'active', fileId: activeId, expiresAt: 0 }, now - 10 * day);
    store.trashFile(trashedId, now - 40 * day);

    const result = await cleanupExpiredDownloads({
      config: { downloadDir: dir, archiveTrashRetentionDays: 30 },
      store,
      now,
      log: { warn() {} },
    });
    assert.equal(result.trashFiles, 1);
    assert.equal(result.trashDeleted, 0);
    await access(filePath);
    await access(sidecarPath);
    assert.equal(store.getLatestFileByVideoId('active')?.id, activeId);
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
      CREATE TABLE creator_imports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        status TEXT NOT NULL,
        max_duration_seconds INTEGER NOT NULL,
        discovered_count INTEGER NOT NULL DEFAULT 0,
        processed_count INTEGER NOT NULL DEFAULT 0,
        downloaded_count INTEGER NOT NULL DEFAULT 0,
        skipped_existing_count INTEGER NOT NULL DEFAULT 0,
        skipped_duration_count INTEGER NOT NULL DEFAULT 0,
        failed_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        completed_at INTEGER,
        updated_at INTEGER NOT NULL
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
    const linkColumns = store.db.prepare('PRAGMA table_info(link_tokens)').all().map((column) => column.name);
    const importColumns = store.db.prepare('PRAGMA table_info(creator_imports)').all().map((column) => column.name);
    const importItemColumns = store.db.prepare('PRAGMA table_info(creator_import_items)').all().map((column) => column.name);
    const indexes = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((index) => index.name);
    assert.ok(watchColumns.includes('creator_id'));
    assert.ok(watchColumns.includes('has_story'));
    assert.ok(watchColumns.includes('story_status_checked_at'));
    assert.ok(seenColumns.includes('next_deletion_check_at'));
    assert.ok(indexes.includes('idx_seen_videos_next_deletion_check_at'));
    assert.ok(jobColumns.includes('requested_by'));
    assert.ok(fileColumns.includes('requested_by'));
    assert.ok(fileColumns.includes('trashed_at'));
    assert.ok(fileColumns.includes('delete_attempts'));
    assert.ok(linkColumns.includes('owner_id'));
    assert.ok(linkColumns.includes('job_id'));
    assert.ok(indexes.includes('idx_link_tokens_file_id_expires_at'));
    assert.ok(indexes.includes('idx_jobs_file_id'));
    assert.ok(indexes.includes('idx_files_trashed_at'));
    assert.ok(importColumns.includes('skipped_unknown_duration_count'));
    assert.ok(importColumns.includes('cancel_requested_at'));
    assert.ok(importColumns.includes('retry_count'));
    assert.ok(importColumns.includes('resume_count'));
    assert.ok(importItemColumns.includes('metadata_json'));
    assert.ok(importItemColumns.includes('attempt_count'));
    assert.ok(indexes.includes('idx_creator_import_items_import_status_position'));
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
    store.createLinkToken({
      token: 'monitor-token',
      fileId: monitorFileId,
      jobId: monitorJobId,
      scopeId: 'guild:guild-1',
      deliveryType: 'monitor',
      expiresAt: 0,
    }, 2000);

    assert.deepEqual(
      store.listDownloadLinksByRequester('user-1').map((link) => link.token),
      ['user-token'],
    );
    assert.deepEqual(
      store.listDownloadLinksByRequester('user-1', { includeMonitored: true, scopeId: 'guild:guild-1' }).map((link) => link.token),
      ['monitor-token', 'user-token'],
    );
    assert.deepEqual(
      store.listDownloadLinksByRequester('user-1', { includeMonitored: true, scopeId: 'guild:guild-1', limit: 1, offset: 1 }).map((link) => link.token),
      ['user-token'],
    );
    assert.equal(store.countDownloadLinksByRequester('user-1', { includeMonitored: true, scopeId: 'guild:guild-1' }), 2);
    assert.deepEqual(
      store.listDownloadLinksByRequester('user-1', { includeMonitored: true, scopeId: 'guild:guild-1', username: 'OPENAI' }).map((link) => link.token),
      ['monitor-token', 'user-token'],
    );
    assert.deepEqual(
      store.listDownloadLinksByRequester('user-1', { includeMonitored: true, scopeId: 'guild:guild-1', username: 'other' }).map((link) => link.token),
      [],
    );
    assert.equal(store.countDownloadLinksByRequester('user-1', { includeMonitored: true, scopeId: 'guild:guild-1', username: 'openai' }), 2);
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

test('watch subscriptions keep guild destinations independent while sharing one creator scan', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tiktok-dlp-watch-subscriptions-'));
  const store = createStore(path.join(dir, 'state.db'));
  try {
    store.addWatch('creator', { guildId: 'guild-1', channelId: 'channel-1', createdBy: 'manager-1' }, 1000);
    store.addWatch('creator', { guildId: 'guild-2', channelId: 'channel-2', createdBy: 'manager-2' }, 1100);
    store.addWatch('creator', { guildId: 'dm:dm-channel-1', channelId: 'dm-channel-1', createdBy: 'owner-1' }, 1150);
    store.addWatch('creator', { guildId: 'dm:dm-channel-2', channelId: 'dm-channel-2', createdBy: 'owner-2' }, 1160);

    assert.equal(store.listWatches().length, 1);
    assert.equal(store.listWatchesForScope({ guildId: 'guild-1' })[0].subscription_channel_id, 'channel-1');
    assert.equal(store.listWatchesForScope({ guildId: 'guild-2' })[0].subscription_channel_id, 'channel-2');
    assert.equal(store.hasWatchSubscription('creator', { guildId: 'guild-1' }), true);
    assert.equal(store.listWatchSubscriptions('creator').length, 4);
    store.migrateLegacyWatchSubscriptions();
    assert.equal(store.listWatchSubscriptions('creator').length, 4);
    assert.equal(store.getWatchSubscription('creator', { guildId: '' }), null);
    assert.equal(store.removeWatch('creator', { guildId: 'guild-1' }), true);
    assert.equal(store.getWatch('creator')?.username, 'creator');

    store.recordWatchIdentity('creator', { currentUsername: 'renamed.creator' }, 1200);
    assert.equal(store.getWatch('creator'), null);
    assert.equal(store.getWatch('renamed.creator')?.username, 'renamed.creator');
    assert.equal(store.getWatchSubscription('renamed.creator', { guildId: 'guild-2' })?.channel_id, 'channel-2');
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
      requestedBy: 'user-1',
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

test('shared assets keep delivery ownership and extended expiries across restart', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tiktok-dlp-shared-retention-'));
  const dbPath = path.join(dir, 'state.db');
  let store = createStore(dbPath);
  try {
    const fileId = store.createFileRecord({
      videoId: 'shared-video',
      username: 'openai',
      sourceUrl: 'https://www.tiktok.com/@openai/video/shared-video',
      filePath: path.join(dir, 'shared.mp4'),
      filename: 'shared.mp4',
      sizeBytes: 1,
    }, 1000);
    const manualJobId = store.createJob({
      type: 'manual',
      requestedBy: 'user-1',
      sourceUrl: 'https://www.tiktok.com/@openai/video/shared-video',
    }, 1000);
    const monitorJobId = store.createJob({
      type: 'monitor',
      sourceUrl: 'https://www.tiktok.com/@openai/video/shared-video',
    }, 1000);
    store.updateJob(manualJobId, { file_id: fileId }, 1000);
    store.updateJob(monitorJobId, { file_id: fileId }, 1000);
    store.createLinkToken({
      token: 'manual-token',
      fileId,
      jobId: manualJobId,
      ownerId: 'user-1',
      expiresAt: 20_000,
    }, 1000);
    store.createLinkToken({
      token: 'monitor-token',
      fileId,
      jobId: monitorJobId,
      scopeId: 'guild:guild-1',
      deliveryType: 'monitor',
      expiresAt: 0,
    }, 1000);
    store.extendLinkToken('manual-token', 30_000, 5_000);
    const extendedExpiry = store.getToken('manual-token').expires_at;

    store.close();
    store = createStore(dbPath);

    assert.equal(store.getToken('manual-token').expires_at, extendedExpiry);
    assert.equal(store.getToken('monitor-token').expires_at, 0);
    assert.equal(store.getToken('manual-token').owner_id, 'user-1');
    assert.equal(store.listPurgePlan({ requestedBy: 'user-1', now: 6_000 }).length, 0);
    assert.deepEqual(store.purgeDownloads({ requestedBy: 'user-1', now: 6_000 }), { files: 0, links: 1, jobs: 1 });
    assert.equal(store.getToken('monitor-token').file_id ?? store.getToken('monitor-token').id, fileId);
    assert.equal(store.stats().fileCount, 1);
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

test('watch controls require an owner, manager permission, or configured role', () => {
  assert.equal(canManageWatches({ user: { id: 'owner' } }, { discordOwnerId: 'owner' }), true);
  assert.equal(canManageWatches({ guildId: 'guild', memberPermissions: { has: () => true } }, {}), true);
  assert.equal(canManageWatches({
    guildId: 'guild',
    memberPermissions: { has: () => false },
    member: { roles: { cache: { has: (roleId) => roleId === 'watch-role' } } },
  }, { watchManagerRoleId: 'watch-role' }), true);
  assert.equal(canManageWatches({ guildId: 'guild', memberPermissions: { has: () => false } }, {}), false);
  assert.equal(canManageWatches({ user: { id: 'not-owner' } }, { discordOwnerId: 'owner' }), false);
});

test('link button actions create, extend, and persist links', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tiktok-dlp-buttons-'));
  const store = createStore(path.join(dir, 'state.db'));
  try {
    const fileId = store.createFileRecord({
      videoId: 'v1',
      requestedBy: 'user-1',
      username: 'openai',
      sourceUrl: 'https://www.tiktok.com/@openai/video/v1',
      filePath: path.join(dir, 'video.mp4'),
      filename: 'video.mp4',
      sizeBytes: 123,
    }, 1000);
    store.createLinkToken({ token: 'tok', fileId, expiresAt: 2000 }, 1000);

    const replies = [];
    const makeInteraction = (customId, userId = 'user-1') => ({
      customId,
      user: { id: userId },
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

    await handleLinkButton({ interaction: makeInteraction('link:permanent:tok', 'user-2'), config, store });
    assert.equal(replies.at(-1).embeds[0].data.title, 'Permission Required');
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
