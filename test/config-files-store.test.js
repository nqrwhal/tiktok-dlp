import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, loadEnvFile, parseNonNegativeInt, parsePositiveInt, validateRuntimeConfig } from '../src/config.js';
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
import { buildNoticePayload, truncateText } from '../src/discord/ui.js';
import { cleanupExpiredDownloads, removeStoredFiles } from '../src/cleanup/downloads.js';

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

test('Docker build context excludes local secrets, sessions, and runtime data', async () => {
  const entries = new Set((await readFile(path.resolve(import.meta.dirname, '..', '.dockerignore'), 'utf8'))
    .split(/\r?\n/)
    .map((entry) => entry.trim().replace(/\/$/, ''))
    .filter(Boolean));
  assert.equal(entries.has('.env'), true);
  assert.equal(entries.has('.secrets'), true);
  assert.equal(entries.has('cookies'), true);
  assert.equal(entries.has('data'), true);
});

test('loadConfig resolves paths and upload limits', () => {
  const config = loadConfig({
    DATA_DIR: './x',
    DISCORD_UPLOAD_LIMIT_MB: '2',
    HTTP_PORT: '9999',
    YTDLP_PROXY: ' http://proxy.test:8888 ',
  }, '/tmp/project');
  assert.equal(config.dataDir, '/tmp/project/x');
  assert.equal(config.discordUploadLimitBytes, 2 * 1024 * 1024);
  assert.equal(loadConfig({}, '/tmp/project').discordUploadLimitBytes, 10 * 1024 * 1024);
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
  assert.equal(config.ytdlpProxy, 'http://proxy.test:8888');
  assert.equal(config.ytdlpTimeoutMs, 60_000);
  assert.equal(config.ytdlpCookiesFile, '');
  assert.equal(
    loadConfig({ YTDLP_COOKIES_FILE: './cookies/tiktok.txt' }, '/tmp/project').ytdlpCookiesFile,
    '/tmp/project/cookies/tiktok.txt',
  );
  validateRuntimeConfig(config, { requireDiscord: false });
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

test('notice embeds preserve intentional description line breaks', () => {
  const payload = buildNoticePayload({
    title: 'Watched Usernames',
    description: '@first — last success: never\n@second — last success: never',
  });

  assert.equal(
    payload.embeds[0].toJSON().description,
    '@first — last success: never\n@second — last success: never',
  );
  assert.equal(truncateText('line one\nline two', 100), 'line one line two');
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

test('multi-asset cleanup removes explicitly recorded content paths with the delivery package', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'media-multi-asset-cleanup-'));
  const packagePath = path.join(dir, 'instagram', 'post.zip');
  const imagePath = path.join(dir, 'instagram', 'content', 'first.jpg');
  const videoPath = path.join(dir, 'instagram', 'content', 'second.mp4');
  try {
    await mkdir(path.dirname(packagePath), { recursive: true });
    await mkdir(path.dirname(imagePath), { recursive: true });
    await writeFile(packagePath, 'package');
    await writeFile(imagePath, 'image');
    await writeFile(videoPath, 'video');

    const result = await removeStoredFiles([{
      id: 1,
      path: packagePath,
      video_id: 'AbC',
      asset_paths_json: JSON.stringify([imagePath, videoPath]),
    }], { downloadDir: dir });

    assert.equal(result.failed.length, 0);
    assert.equal(result.deleted, 3);
    await assert.rejects(access(packagePath), { code: 'ENOENT' });
    await assert.rejects(access(imagePath), { code: 'ENOENT' });
    await assert.rejects(access(videoPath), { code: 'ENOENT' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('multi-asset cleanup preserves a shared package while removing unshared content assets', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'media-shared-package-cleanup-'));
  const packagePath = path.join(dir, 'instagram', 'post.zip');
  const contentPath = path.join(dir, 'instagram', 'first.jpg');
  try {
    await mkdir(path.dirname(packagePath), { recursive: true });
    await writeFile(packagePath, 'shared package');
    await writeFile(contentPath, 'unshared content');

    const result = await removeStoredFiles([{
      id: 1,
      path: packagePath,
      video_id: 'AbC',
      asset_paths: [contentPath, packagePath],
    }], { downloadDir: dir }, { protectedPaths: new Set([packagePath]) });

    assert.equal(result.failed.length, 0);
    assert.equal(result.deleted, 1);
    assert.equal((await readFile(packagePath)).toString(), 'shared package');
    await assert.rejects(access(contentPath), { code: 'ENOENT' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('expired cleanup loads recorded media assets from SQLite before deleting a multi-asset post', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'media-multi-asset-store-cleanup-'));
  const store = createStore(path.join(dir, 'state.db'));
  const packagePath = path.join(dir, 'downloads', 'x', 'post.zip');
  const contentPath = path.join(dir, 'downloads', 'x', 'content-with-unrelated-name.jpg');
  try {
    await mkdir(path.dirname(packagePath), { recursive: true });
    await writeFile(packagePath, 'package');
    await writeFile(contentPath, 'content');
    const fileId = store.createFileRecord({
      platform: 'x',
      videoId: '123',
      sourceUrl: 'https://x.com/creator/status/123',
      filePath: packagePath,
      filename: 'post.zip',
      sizeBytes: 7,
    }, 1);
    store.recordMediaDownload({
      platform: 'x',
      remoteId: '123',
      fileId,
      filePath: packagePath,
      filename: 'post.zip',
      sizeBytes: 7,
      assets: [{ path: contentPath, filename: path.basename(contentPath), kind: 'image', sizeBytes: 7 }],
    }, 1);
    store.createLinkToken({ token: 'expired-multi', fileId, expiresAt: 10 }, 1);

    const result = await cleanupExpiredDownloads({
      config: { downloadDir: path.join(dir, 'downloads') },
      store,
      now: 100,
      log: { warn() {} },
    });

    assert.equal(result.files, 1);
    assert.equal(result.deleted, 2);
    assert.equal(store.getLatestFileByPost('x', '123'), null);
    assert.equal(store.getMediaPost('x', '123'), null);
    assert.deepEqual(store.listMediaAssetsForFile(fileId), []);
    await assert.rejects(access(packagePath), { code: 'ENOENT' });
    await assert.rejects(access(contentPath), { code: 'ENOENT' });
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('media post metadata survives one file deletion and is pruned with its final asset', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'media-post-pruning-'));
  const store = createStore(path.join(dir, 'state.db'));
  try {
    const createMediaFile = (filename, now) => {
      const filePath = path.join(dir, filename);
      const fileId = store.createFileRecord({
        platform: 'x',
        videoId: 'shared-post',
        sourceUrl: 'https://x.com/creator/status/shared-post',
        filePath,
        filename,
        sizeBytes: 1,
      }, now);
      store.recordMediaDownload({
        platform: 'x',
        remoteId: 'shared-post',
        fileId,
        filePath,
        filename,
        sizeBytes: 1,
        assets: [{ path: filePath, filename, kind: 'image', sizeBytes: 1 }],
      }, now);
      return fileId;
    };
    const firstId = createMediaFile('first.jpg', 1000);
    const secondId = createMediaFile('second.jpg', 1100);

    assert.equal(store.deleteFileRecords([firstId]), 1);
    assert.ok(store.getMediaPost('x', 'shared-post'));
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM media_assets').get().count, 1);

    assert.deepEqual(store.listPurgePlan({ now: 2000 }).map((file) => file.id), [secondId]);
    assert.deepEqual(store.purgeDownloads({ removeFileIds: [secondId], now: 2000 }), {
      files: 1,
      links: 0,
      jobs: 0,
    });
    assert.equal(store.getMediaPost('x', 'shared-post'), null);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM media_assets').get().count, 0);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('file and media persistence rolls back together when their identities disagree', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'media-atomic-persistence-'));
  const store = createStore(path.join(dir, 'state.db'));
  try {
    assert.throws(() => store.createFileWithMedia({
      file: {
        platform: 'x',
        videoId: '123',
        sourceUrl: 'https://x.com/creator/status/123',
        filePath: path.join(dir, '123.mp4'),
        filename: '123.mp4',
        sizeBytes: 5,
      },
      media: {
        platform: 'instagram',
        remoteId: '123',
      },
    }, 1_000), /identity must match/i);

    assert.equal(store.stats().fileCount, 0);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM media_posts').get().count, 0);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM media_assets').get().count, 0);
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

test('an expiry claim blocks delivery revival until the claimed deletion fails', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'retention-claim-revival-'));
  const dbPath = path.join(dir, 'state.db');
  const cleanupStore = createStore(dbPath);
  const deliveryStore = createStore(dbPath);
  try {
    const fileId = cleanupStore.createFileRecord({
      videoId: 'claimed',
      sourceUrl: 'https://example.test/claimed',
      filePath: path.join(dir, 'claimed.mp4'),
      filename: 'claimed.mp4',
      sizeBytes: 1,
    }, 1000);
    cleanupStore.createLinkToken({ token: 'expired-claim', fileId, expiresAt: 2000 }, 1000);

    const [claimed] = cleanupStore.claimFilesForDeletion(3000, 1, 3000);
    assert.equal(claimed.id, fileId);
    assert.equal(claimed.retention_status, 'expiry_claimed');
    assert.throws(
      () => deliveryStore.createLinkToken({ token: 'racing-link', fileId, expiresAt: 0 }, 3100),
      /claimed for deletion/i,
    );
    assert.equal(deliveryStore.extendLinkToken('expired-claim', 10_000, 3100), null);
    assert.equal(deliveryStore.setLinkTokenPermanent('expired-claim'), null);
    assert.equal(deliveryStore.trashFile(fileId, 3100), null);

    assert.equal(cleanupStore.markFileDeletionFailed(fileId, new Error('disk busy'), 3200, {
      expectedRetentionStatus: 'expiry_claimed',
      expectedRequestedAt: 3000,
    }), true);
    deliveryStore.createLinkToken({ token: 'revived-after-failure', fileId, expiresAt: 0 }, 3300);
    const revived = cleanupStore.db.prepare(`
      SELECT retention_status, delete_requested_at, delete_error FROM files WHERE id = ?
    `).get(fileId);
    assert.equal(revived.retention_status, 'active');
    assert.equal(revived.delete_requested_at, null);
    assert.equal(revived.delete_error, null);
  } finally {
    deliveryStore.close();
    cleanupStore.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('claimed cleanup and purge finalizers never cascade a newer active delivery', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'retention-finalize-race-'));
  const store = createStore(path.join(dir, 'state.db'));
  try {
    const expiryId = store.createFileRecord({
      videoId: 'expiry-race',
      sourceUrl: 'https://example.test/expiry-race',
      filePath: path.join(dir, 'expiry-race.mp4'),
      filename: 'expiry-race.mp4',
      sizeBytes: 1,
    }, 1000);
    assert.equal(store.claimFilesForDeletion(3000, 1, 3000)[0].id, expiryId);
    store.db.prepare(`
      INSERT INTO link_tokens (token, file_id, owner_id, scope_id, delivery_type, expires_at, created_at)
      VALUES ('new-active-expiry', ?, 'user-1', '', 'manual', 0, 3100)
    `).run(expiryId);
    assert.equal(store.deleteFileRecords([expiryId], {
      requiredRetentionStatus: 'expiry_claimed',
      claimRequestedAt: 3000,
      requireNoActiveLinks: true,
      now: 3200,
    }), 0);
    assert.ok(store.getToken('new-active-expiry'));
    assert.ok(store.db.prepare('SELECT 1 FROM files WHERE id = ?').get(expiryId));

    const purgeId = store.createFileRecord({
      videoId: 'purge-race',
      requestedBy: 'user-1',
      sourceUrl: 'https://example.test/purge-race',
      filePath: path.join(dir, 'purge-race.mp4'),
      filename: 'purge-race.mp4',
      sizeBytes: 1,
    }, 1000);
    store.createLinkToken({ token: 'purge-original', fileId: purgeId, ownerId: 'user-1', expiresAt: 0 }, 1000);
    assert.deepEqual(store.listPurgePlan({ requestedBy: 'user-1', now: 4000 }).map((file) => file.id), [purgeId]);
    assert.throws(
      () => store.createLinkToken({ token: 'purge-supported-race', fileId: purgeId, expiresAt: 0 }, 4100),
      /claimed for deletion/i,
    );
    store.db.prepare(`
      INSERT INTO link_tokens (token, file_id, owner_id, scope_id, delivery_type, expires_at, created_at)
      VALUES ('purge-newer', ?, 'user-1', '', 'manual', 0, 4100)
    `).run(purgeId);

    assert.deepEqual(store.purgeDownloads({
      requestedBy: 'user-1',
      removeFileIds: [purgeId],
      now: 4200,
    }), { files: 0, links: 1, jobs: 0 });
    assert.ok(store.getToken('purge-newer'));
    assert.equal(store.getToken('purge-original'), null);
    assert.equal(
      store.db.prepare('SELECT retention_status FROM files WHERE id = ?').get(purgeId).retention_status,
      'expiry_failed',
    );
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

test('trash cleanup purges a multi-platform package and ordered assets while preserving shared media', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'media-trash-retention-'));
  const downloadDir = path.join(dir, 'downloads');
  const store = createStore(path.join(dir, 'state.db'));
  const day = 24 * 60 * 60 * 1000;
  const now = 100 * day;
  try {
    const packagePath = path.join(downloadDir, 'instagram', 'carousel.zip');
    const uniquePath = path.join(downloadDir, 'instagram', 'carousel__001.jpg');
    const sharedPath = path.join(downloadDir, 'shared', 'cross-post.jpg');
    const activePath = path.join(downloadDir, 'x', 'active.zip');
    await Promise.all([
      mkdir(path.dirname(packagePath), { recursive: true }),
      mkdir(path.dirname(sharedPath), { recursive: true }),
      mkdir(path.dirname(activePath), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(packagePath, 'instagram package'),
      writeFile(uniquePath, 'unique image'),
      writeFile(sharedPath, 'shared image'),
      writeFile(activePath, 'active package'),
    ]);

    const { fileId: trashedId } = store.createFileWithMedia({
      file: {
        platform: 'instagram',
        videoId: 'carousel',
        username: 'creator',
        sourceUrl: 'https://www.instagram.com/p/carousel/',
        filePath: packagePath,
        filename: 'carousel.zip',
        sizeBytes: 17,
      },
      media: {
        platform: 'instagram',
        remoteId: 'carousel',
        mediaType: 'gallery',
        filePath: packagePath,
        filename: 'carousel.zip',
        sizeBytes: 17,
        assets: [
          { position: 1, path: uniquePath, filename: 'carousel__001.jpg', kind: 'image', sizeBytes: 12 },
          { position: 2, path: sharedPath, filename: 'cross-post.jpg', kind: 'image', sizeBytes: 12 },
        ],
      },
    }, now - 50 * day);
    const { fileId: activeId } = store.createFileWithMedia({
      file: {
        platform: 'x',
        videoId: 'active',
        username: 'creator',
        sourceUrl: 'https://x.com/creator/status/active',
        filePath: activePath,
        filename: 'active.zip',
        sizeBytes: 14,
      },
      media: {
        platform: 'x',
        remoteId: 'active',
        mediaType: 'image',
        filePath: activePath,
        filename: 'active.zip',
        sizeBytes: 14,
        assets: [
          { position: 1, path: sharedPath, filename: 'cross-post.jpg', kind: 'image', sizeBytes: 12 },
        ],
      },
    }, now - 10 * day);
    store.createLinkToken({ token: 'instagram-permanent', fileId: trashedId, expiresAt: 0 }, now - 50 * day);
    store.createLinkToken({ token: 'x-permanent', fileId: activeId, expiresAt: 0 }, now - 10 * day);
    assert.equal(store.setMediaFileBookmark(trashedId, true, now - 45 * day), true);
    assert.equal(store.trashMediaFile(trashedId, now - 40 * day)?.platform, 'instagram');
    assert.equal(store.getTrashedFile(trashedId), null);
    assert.deepEqual(store.listTrashedFiles(), []);

    const result = await cleanupExpiredDownloads({
      config: { downloadDir, archiveTrashRetentionDays: 30 },
      store,
      now,
      log: { warn() {} },
    });

    assert.equal(result.trashFiles, 1);
    assert.equal(result.trashDeleted, 2);
    await assert.rejects(access(packagePath), { code: 'ENOENT' });
    await assert.rejects(access(uniquePath), { code: 'ENOENT' });
    await access(sharedPath);
    await access(activePath);
    assert.equal(store.getTrashedMediaFile(trashedId), null);
    assert.equal(store.getMediaPost('instagram', 'carousel'), null);
    assert.deepEqual(store.listMediaAssetsForFile(trashedId), []);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM bookmarks WHERE file_id = ?').get(trashedId).count, 0);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM link_tokens WHERE file_id = ?').get(trashedId).count, 0);
    assert.equal(store.getLatestFileByPost('x', 'active')?.id, activeId);
    assert.equal(store.getMediaPost('x', 'active')?.platform, 'x');
    assert.deepEqual(
      store.listMediaAssetsForFile(activeId).filter((asset) => asset.role === 'content').map((asset) => asset.path),
      [sharedPath],
    );
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
    const bookmarkColumns = store.db.prepare('PRAGMA table_info(bookmarks)').all().map((column) => column.name);
    const alertDeliveryColumns = store.db.prepare('PRAGMA table_info(alert_deliveries)').all().map((column) => column.name);
    const migrationColumns = store.db.prepare('PRAGMA table_info(schema_migrations)').all().map((column) => column.name);
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
    assert.ok(indexes.includes('idx_link_tokens_monitor_file_scope_created_at'));
    assert.ok(indexes.includes('idx_jobs_file_id'));
    assert.ok(indexes.includes('idx_files_trashed_at'));
    assert.ok(indexes.includes('idx_files_rewind_active_created'));
    assert.ok(indexes.includes('idx_files_rewind_active_username_created'));
    assert.ok(indexes.includes('idx_files_rewind_media_active_created'));
    assert.ok(indexes.includes('idx_files_rewind_media_platform_username_created'));
    assert.ok(importColumns.includes('skipped_unknown_duration_count'));
    assert.ok(importColumns.includes('cancel_requested_at'));
    assert.ok(importColumns.includes('retry_count'));
    assert.ok(importColumns.includes('resume_count'));
    assert.ok(importItemColumns.includes('metadata_json'));
    assert.ok(importItemColumns.includes('attempt_count'));
    assert.ok(indexes.includes('idx_creator_import_items_import_status_position'));
    assert.deepEqual(bookmarkColumns, ['file_id', 'created_at']);
    assert.ok(indexes.includes('idx_bookmarks_created_at'));
    assert.deepEqual(alertDeliveryColumns, [
      'video_id',
      'subscription_id',
      'event_type',
      'status',
      'attempt_count',
      'last_attempt_at',
      'delivered_at',
      'last_error',
    ]);
    assert.ok(indexes.includes('idx_alert_deliveries_subscription_event'));
    assert.deepEqual(migrationColumns, ['version', 'name', 'applied_at']);
    assert.equal(store.getSchemaVersion(), 4);
    assert.deepEqual(store.listSchemaMigrations().map(({ version, name }) => ({ version, name })), [
      { version: 1, name: 'legacy-schema-bootstrap' },
      { version: 2, name: 'monitor-download-dead-letters' },
      { version: 3, name: 'rewind-read-indexes' },
      { version: 4, name: 'rewind-media-read-indexes' },
    ]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('bookmarks persist on the server and hide while their file is trashed', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tiktok-dlp-bookmarks-'));
  const store = createStore(path.join(dir, 'state.db'));
  try {
    const firstId = store.createFileRecord({
      sourceUrl: 'https://www.tiktok.com/@creator/video/1',
      filePath: path.join(dir, 'one.mp4'),
      filename: 'one.mp4',
      sizeBytes: 1,
    }, 1000);
    const secondId = store.createFileRecord({
      sourceUrl: 'https://www.tiktok.com/@creator/video/2',
      filePath: path.join(dir, 'two.mp4'),
      filename: 'two.mp4',
      sizeBytes: 2,
    }, 2000);

    assert.equal(store.setFileBookmark(firstId, true, 3000), true);
    assert.deepEqual(store.addFileBookmarks([secondId, firstId, 999999], 4000), [secondId, firstId]);
    store.trashFile(secondId, 5000);
    assert.deepEqual(store.listBookmarkedFileIds(), [firstId]);
    store.restoreTrashedFile(secondId);
    assert.deepEqual(store.listBookmarkedFileIds(), [secondId, firstId]);
    assert.equal(store.setFileBookmark(firstId, false), true);
    assert.deepEqual(store.listBookmarkedFileIds(), [secondId]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('legacy Rewind Store operations act only on TikTok while download lists preserve platform identity', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'media-archive-rewind-platform-'));
  const store = createStore(path.join(dir, 'state.db'));
  try {
    const createFile = (platform, id, now) => store.createFileRecord({
      platform,
      videoId: id,
      requestedBy: 'user-1',
      username: 'same-handle',
      sourceUrl: platform === 'tiktok'
        ? `https://www.tiktok.com/@same-handle/video/${id}`
        : platform === 'instagram'
          ? `https://www.instagram.com/p/${id}/`
          : `https://x.com/same-handle/status/${id}`,
      filePath: path.join(dir, `${platform}-${id}.mp4`),
      filename: `${platform}-${id}.mp4`,
      sizeBytes: 1,
    }, now);
    const tiktokId = createFile('tiktok', 'shared', 1000);
    const xId = createFile('x', 'shared', 1100);
    const instagramId = createFile('instagram', 'shared', 1200);
    store.createLinkToken({ token: 'tt-link', fileId: tiktokId, ownerId: 'user-1', expiresAt: 0 }, 1000);
    store.createLinkToken({ token: 'x-link', fileId: xId, ownerId: 'user-1', expiresAt: 0 }, 1100);
    store.createLinkToken({ token: 'ig-link', fileId: instagramId, ownerId: 'user-1', expiresAt: 0 }, 1200);

    assert.deepEqual(
      store.listDownloadLinksByRequester('user-1').map((row) => row.platform),
      ['instagram', 'x', 'tiktok'],
    );
    assert.deepEqual(
      store.listPermanentDownloadsByRequester('user-1').map((row) => row.platform),
      ['instagram', 'x', 'tiktok'],
    );
    assert.deepEqual(
      store.listLinkHistoryByRequester('user-1').map((row) => row.platform),
      ['instagram', 'x', 'tiktok'],
    );

    assert.equal(store.setFileBookmark(tiktokId, true, 2000), true);
    assert.equal(store.setFileBookmark(xId, true, 2100), false);
    assert.deepEqual(store.addFileBookmarks([instagramId, xId], 2200), [tiktokId]);
    store.db.prepare('INSERT INTO bookmarks (file_id, created_at) VALUES (?, ?)').run(xId, 2300);
    assert.equal(store.setFileBookmark(xId, false), true);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM bookmarks WHERE file_id = ?').get(xId).count, 1);
    assert.deepEqual(store.listBookmarkedFileIds(), [tiktokId]);

    assert.equal(store.getVideoFilePurgePlan(tiktokId)?.id, tiktokId);
    assert.equal(store.getVideoFilePurgePlan(xId), null);
    assert.equal(store.getVideoFilePurgePlan(instagramId), null);
    assert.equal(store.trashFile(xId, 3000), null);
    assert.equal(store.db.prepare('SELECT retention_status FROM files WHERE id = ?').get(xId).retention_status, 'active');
    assert.equal(store.trashFile(tiktokId, 3000)?.id, tiktokId);

    store.db.prepare(`
      UPDATE files
      SET trashed_at = 3000, retention_status = 'trashed'
      WHERE id IN (?, ?)
    `).run(xId, instagramId);
    assert.deepEqual(store.listTrashedFiles().map((row) => row.id), [tiktokId]);
    assert.equal(store.getTrashedFile(xId), null);
    assert.equal(store.restoreTrashedFile(xId), null);
    assert.equal(store.claimTrashedFileForDeletion(instagramId, 4000), null);
    assert.deepEqual(store.claimAllTrashedFilesForDeletion(4000).map((row) => row.id), [tiktokId]);
    assert.deepEqual(
      store.db.prepare('SELECT platform, retention_status FROM files WHERE id IN (?, ?) ORDER BY platform')
        .all(xId, instagramId)
        .map((row) => [row.platform, row.retention_status]),
      [
        ['instagram', 'trashed'],
        ['x', 'trashed'],
      ],
    );
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
    store.addWatch('legacy.creator', 'channel-1', 1170);
    store.addWatch('other.legacy.creator', 'channel-3', 1180);

    assert.equal(store.listWatches().length, 3);
    assert.equal(store.listWatchesForScope({ guildId: 'guild-1' })[0].subscription_channel_id, 'channel-1');
    assert.equal(store.listWatchesForScope({ guildId: 'guild-2' })[0].subscription_channel_id, 'channel-2');
    assert.deepEqual(
      store.listWatchesForScope({ guildId: 'guild-1', channelId: 'channel-1' }).map((watch) => watch.username),
      ['creator', 'legacy.creator'],
    );
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

test('alert deliveries persist success and failure independently per subscription and event', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tiktok-dlp-alert-deliveries-'));
  const dbPath = path.join(dir, 'state.db');
  let store = createStore(dbPath);
  try {
    store.addWatch('creator', { guildId: 'guild-1', channelId: 'channel-1' }, 1000);
    store.addWatch('creator', { guildId: 'guild-2', channelId: 'channel-2' }, 1000);
    const [first, second] = store.listWatchSubscriptions('creator');
    const firstKey = { videoId: 'post-1', subscriptionId: first.id, eventType: 'new_post' };
    const secondKey = { videoId: 'post-1', subscriptionId: second.id, eventType: 'new_post' };

    store.markAlertDelivered(firstKey, 2000);
    store.markAlertDeliveryFailed({ ...secondKey, error: new Error('Discord unavailable') }, 2100);
    store.markAlertDelivered({ ...firstKey, eventType: 'deletion' }, 2200);

    assert.equal(store.isAlertDelivered(firstKey), true);
    assert.equal(store.isAlertDelivered(secondKey), false);
    assert.equal(store.getAlertDelivery(firstKey).attempt_count, 1);
    assert.equal(store.getAlertDelivery(secondKey).status, 'failed');
    assert.equal(store.getAlertDelivery(secondKey).last_error, 'Discord unavailable');
    assert.equal(store.isAlertDelivered({ ...firstKey, eventType: 'deletion' }), true);

    store.close();
    store = createStore(dbPath);
    assert.equal(store.isAlertDelivered(firstKey), true);
    assert.equal(store.getAlertDelivery(secondKey).status, 'failed');

    store.markAlertDelivered(secondKey, 2300);
    assert.equal(store.isAlertDelivered(secondKey), true);
    assert.equal(store.getAlertDelivery(secondKey).attempt_count, 2);
    assert.equal(store.getAlertDelivery(secondKey).last_error, null);
    assert.equal(store.getAlertDelivery(secondKey).delivered_at, 2300);
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
    store.addWatch('openai', { guildId: 'guild-1', channelId: 'channel-1' }, 1000);
    store.scheduleVideoDeletionCheck('v1', 2000);

    assert.equal(store.listVideosDueForDeletionCheck(1999).length, 0);
    const due = store.listVideosDueForDeletionCheck(2000);
    assert.equal(due.length, 1);
    assert.equal(due[0].permanent_token, 'permanent-token');

    store.markVideoStillAvailable('v1', 3000, 2000);
    assert.equal(store.listVideosDueForDeletionCheck(2000).length, 0);
    assert.equal(store.listVideosDueForDeletionCheck(3000)[0].deletion_check_count, 1);

    const firstMissing = store.recordVideoMissing('v1', 4000, 'not found', 3000);
    assert.equal(firstMissing.deletion_missing_count, 1);
    const restored = store.markVideoStillAvailable('v1', 4000, 3500);
    assert.equal(restored, undefined);
    assert.equal(store.listVideosDueForDeletionCheck(4000)[0].deletion_missing_count, 0);

    store.recordVideoMissing('v1', 5000, 'not found', 4000);
    const secondMissing = store.recordVideoMissing('v1', 6000, 'not found', 5000);
    assert.equal(secondMissing.deletion_missing_count, 2);
    const deleted = store.markVideoDeleted('v1', 'not found', 5000);
    assert.equal(deleted.deleted_at, 5000);
    assert.equal(deleted.deletion_alerted_at, null);
    assert.equal(store.listVideosDueForDeletionCheck(5000).length, 1);
    store.markVideoDeletionAlerted('v1', 6000);
    assert.equal(store.listVideosDueForDeletionCheck(9999).length, 0);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('store backfills deletion checks only for active saved non-story alerts', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tiktok-dlp-deletion-backfill-'));
  const store = createStore(path.join(dir, 'state.db'));
  try {
    store.addWatch('creator', { guildId: 'guild-1', channelId: 'channel-1' }, 1000);
    for (const [videoId, sourceUrl] of [
      ['video-1', 'https://www.tiktok.com/@creator/video/video-1'],
      ['story-1', 'https://www.tiktok.com/@creator/story/story-1'],
    ]) {
      const fileId = store.createFileRecord({
        videoId,
        username: 'creator',
        sourceUrl,
        filePath: path.join(dir, `${videoId}.mp4`),
        filename: `${videoId}.mp4`,
        sizeBytes: 1,
      }, 1000);
      store.createLinkToken({ token: `token-${videoId}`, fileId, expiresAt: 0 }, 1000);
      store.markVideoSeen({
        videoId,
        username: 'creator',
        sourceUrl,
        title: videoId,
        alertedAt: 1000,
      }, 1000);
    }

    assert.equal(store.backfillDeletionChecks(2000), 1);
    assert.equal(store.listVideosDueForDeletionCheck(2000).map((video) => video.video_id).join(','), 'video-1');
    assert.equal(store.backfillDeletionChecks(3000), 0);

    store.removeWatch('creator');
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


test('shared-path lookup only materializes paths belonging to cleanup candidates', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tiktok-dlp-path-lookup-'));
  const store = createStore(path.join(dir, 'state.db'));
  try {
    const sharedPath = path.join(dir, 'shared.mp4');
    const unrelatedPath = path.join(dir, 'unrelated.mp4');
    const candidateId = store.createFileRecord({
      videoId: 'candidate', sourceUrl: 'https://example.test/candidate', filePath: sharedPath, filename: 'shared.mp4', sizeBytes: 1,
    }, 1000);
    store.createFileRecord({
      videoId: 'outside', sourceUrl: 'https://example.test/outside', filePath: sharedPath, filename: 'shared.mp4', sizeBytes: 1,
    }, 1000);
    store.createFileRecord({
      videoId: 'unrelated', sourceUrl: 'https://example.test/unrelated', filePath: unrelatedPath, filename: 'unrelated.mp4', sizeBytes: 1,
    }, 1000);

    assert.deepEqual(store.listFilePathsReferencedOutside([candidateId]), [sharedPath]);
    assert.deepEqual(store.listFilePathsReferencedOutside([]), []);
    assert.ok(store.db.prepare('PRAGMA index_list(files)').all().some((index) => index.name === 'idx_files_path'));
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('cleanup drains old jobs across bounded batches and stops at its per-run row cap', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tiktok-dlp-job-prune-'));
  const store = createStore(path.join(dir, 'state.db'));
  const day = 24 * 60 * 60 * 1000;
  try {
    for (let index = 0; index < 5; index += 1) {
      store.createJob({ type: 'manual', sourceUrl: `https://example.test/${index}` }, 1000 + index);
    }
    const pruneOldJobs = store.pruneOldJobs.bind(store);
    const batchLimits = [];
    store.pruneOldJobs = (before, limit, now) => {
      batchLimits.push(limit);
      return pruneOldJobs(before, limit, now);
    };

    const result = await cleanupExpiredDownloads({
      config: { downloadDir: dir, cleanupBatchSize: 2, retentionDays: 1 },
      store,
      now: 2 * day,
      log: { warn() {} },
    });

    assert.equal(result.prunedJobs, 5);
    assert.deepEqual(batchLimits, [2, 2, 2]);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM jobs').get().count, 0);
    assert.ok(store.db.prepare('PRAGMA index_list(jobs)').all().some((index) => index.name === 'idx_jobs_updated_at_id'));

    let cappedCalls = 0;
    const capped = await cleanupExpiredDownloads({
      config: { downloadDir: dir, cleanupBatchSize: 1000, retentionDays: 1 },
      store: {
        listFilesWithoutActiveLinks: () => [],
        deleteFileRecords: () => 0,
        pruneOldJobs: (_before, limit) => {
          cappedCalls += 1;
          return limit;
        },
      },
      now: 2 * day,
      log: { warn() {} },
    });
    assert.equal(capped.prunedJobs, 10_000);
    assert.equal(cappedCalls, 10);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
