import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/state/store.js';

test('Instagram and X files cannot make a TikTok seen post eligible for deletion checks', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'media-archive-monitor-platform-'));
  const store = createStore(path.join(dir, 'state.db'));
  try {
    const remoteId = 'same-remote-id';
    store.addWatch('creator', { guildId: 'guild-1', channelId: 'channel-1' }, 1000);
    store.markVideoSeen({
      videoId: remoteId,
      username: 'creator',
      sourceUrl: `https://www.tiktok.com/@creator/video/${remoteId}`,
      title: 'TikTok post',
      alertedAt: 1000,
    }, 1000);

    const xFileId = store.createFileRecord({
      platform: 'x',
      videoId: remoteId,
      username: 'creator',
      sourceUrl: `https://x.com/creator/status/${remoteId}`,
      filePath: path.join(dir, 'x.mp4'),
      filename: 'x.mp4',
      sizeBytes: 1,
    }, 1100);
    store.createLinkToken({
      token: 'x-monitor-token',
      fileId: xFileId,
      scopeId: 'guild:guild-1',
      deliveryType: 'monitor',
      expiresAt: 0,
    }, 1100);

    assert.equal(store.backfillDeletionChecks(2000), 0);
    assert.equal(store.getLatestPermanentTokenForVideo(remoteId, { scopeId: 'guild:guild-1' }), '');
    store.scheduleVideoDeletionCheck(remoteId, 2000);
    assert.deepEqual(store.listVideosDueForDeletionCheck(2000), []);
    store.db.prepare('UPDATE seen_videos SET next_deletion_check_at = NULL WHERE video_id = ?').run(remoteId);

    const tiktokFileId = store.createFileRecord({
      platform: 'tiktok',
      videoId: remoteId,
      username: 'creator',
      sourceUrl: `https://www.tiktok.com/@creator/video/${remoteId}`,
      filePath: path.join(dir, 'tiktok.mp4'),
      filename: 'tiktok.mp4',
      sizeBytes: 1,
    }, 1200);
    store.createLinkToken({
      token: 'tiktok-monitor-token',
      fileId: tiktokFileId,
      scopeId: 'guild:guild-1',
      deliveryType: 'monitor',
      expiresAt: 0,
    }, 1200);

    assert.equal(store.backfillDeletionChecks(3000), 1);
    const due = store.listVideosDueForDeletionCheck(3000);
    assert.equal(due.length, 1);
    assert.equal(due[0].permanent_token, 'tiktok-monitor-token');
    assert.equal(due[0].filename, 'tiktok.mp4');
    assert.equal(
      store.getLatestPermanentTokenForVideo(remoteId, { scopeId: 'guild:guild-1' }),
      'tiktok-monitor-token',
    );
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('removing same-ID Instagram or X files never resets TikTok deletion state', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'media-archive-monitor-reset-'));
  const store = createStore(path.join(dir, 'state.db'));
  const remoteId = 'shared-id';
  const scheduledAt = 9000;
  try {
    store.markVideoSeen({
      videoId: remoteId,
      username: 'creator',
      sourceUrl: `https://www.tiktok.com/@creator/video/${remoteId}`,
      title: 'TikTok post',
      alertedAt: 1000,
    }, 1000);
    const reschedule = () => store.scheduleVideoDeletionCheck(remoteId, scheduledAt);
    const nextCheck = () => store.db.prepare(`
      SELECT next_deletion_check_at FROM seen_videos WHERE video_id = ?
    `).get(remoteId)?.next_deletion_check_at;

    reschedule();
    const instagramFileId = createTestFile(store, dir, 'instagram', remoteId, 'instagram.jpg', 1100);
    assert.equal(store.deleteFileRecords([instagramFileId]), 1);
    assert.equal(nextCheck(), scheduledAt);

    reschedule();
    const xDeliveryFileId = createTestFile(store, dir, 'x', remoteId, 'x.mp4', 1200);
    store.createLinkToken({ token: 'x-delete', fileId: xDeliveryFileId, expiresAt: 0 }, 1200);
    assert.deepEqual(
      store.deleteDeliveryToken('x-delete', { deleteFile: true, now: 1300 }),
      { files: 1, links: 1, jobs: 0 },
    );
    assert.equal(nextCheck(), scheduledAt);

    reschedule();
    const xPurgeFileId = createTestFile(store, dir, 'x', remoteId, 'x-purge.mp4', 1400);
    assert.deepEqual(
      store.purgeDownloads({ removeFileIds: [xPurgeFileId], now: 1500 }),
      { files: 1, links: 0, jobs: 0 },
    );
    assert.equal(nextCheck(), scheduledAt);

    const tiktokFileId = createTestFile(store, dir, 'tiktok', remoteId, 'tiktok.mp4', 1600);
    assert.equal(store.deleteFileRecords([tiktokFileId]), 1);
    assert.equal(nextCheck(), null);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

function createTestFile(store, dir, platform, videoId, filename, now) {
  return store.createFileRecord({
    platform,
    videoId,
    username: 'creator',
    sourceUrl: `https://example.test/${platform}/${videoId}`,
    filePath: path.join(dir, filename),
    filename,
    sizeBytes: 1,
  }, now);
}
