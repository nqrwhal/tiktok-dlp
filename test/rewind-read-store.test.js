import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createStore } from '../src/state/store.js';

test('Rewind reads stay TikTok-only, cursor-safe, bookmarked, and aggregate through Store', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rewind-store-read-'));
  const store = createStore(path.join(dir, 'state.db'));
  const now = Date.UTC(2026, 7, 30, 12, 0, 0);
  try {
    store.addWatch('Alice', { channelId: 'channel-1', guildId: 'guild-1' }, now - 10_000);
    store.addWatch('bob', { channelId: 'channel-2', guildId: 'guild-2' }, now - 9_000);

    const newestId = store.createFileRecord({
      videoId: 'alice-new',
      username: 'alice',
      sourceUrl: 'https://www.tiktok.com/@alice/video/alice-new',
      filePath: path.join(dir, 'alice-new.mp4'),
      filename: 'alice-new.mp4',
      sizeBytes: 20,
    }, now - 60 * 60 * 1_000);
    const olderId = store.createFileRecord({
      videoId: 'alice-old',
      username: 'ALICE',
      sourceUrl: 'https://www.tiktok.com/@alice/video/alice-old',
      filePath: path.join(dir, 'alice-old.mp4'),
      filename: 'alice-old.mp4',
      sizeBytes: 10,
    }, now - 2 * 60 * 60 * 1_000);
    const oldSavedOnlyId = store.createFileRecord({
      videoId: 'charlie-old',
      username: 'charlie',
      sourceUrl: 'https://www.tiktok.com/@charlie/video/charlie-old',
      filePath: path.join(dir, 'charlie-old.mp4'),
      filename: 'charlie-old.mp4',
      sizeBytes: 30,
    }, now - 8 * 24 * 60 * 60 * 1_000);
    store.createFileRecord({
      platform: 'x',
      videoId: 'x-post',
      username: 'alice',
      sourceUrl: 'https://x.com/alice/status/x-post',
      filePath: path.join(dir, 'x-post.mp4'),
      filename: 'x-post.mp4',
      sizeBytes: 1_000,
    }, now - 500);
    store.createFileRecord({
      videoId: 'slideshow',
      username: 'alice',
      sourceUrl: 'https://www.tiktok.com/@alice/photo/slideshow',
      filePath: path.join(dir, 'slideshow.zip'),
      filename: 'slideshow.zip',
      sizeBytes: 2_000,
    }, now - 400);
    const trashedId = store.createFileRecord({
      videoId: 'trashed',
      username: 'alice',
      sourceUrl: 'https://www.tiktok.com/@alice/video/trashed',
      filePath: path.join(dir, 'trashed.mp4'),
      filename: 'trashed.mp4',
      sizeBytes: 4_000,
    }, now - 300);
    store.trashFile(trashedId, now - 200);

    const jobId = store.createJob({
      type: 'manual',
      username: 'alice',
      sourceUrl: 'https://www.tiktok.com/@alice/video/alice-new',
      videoId: 'alice-new',
      title: 'Newest Alice title',
    }, now - 50);
    store.updateJob(jobId, { file_id: newestId, status: 'completed' }, now - 40);
    store.setFileBookmark(olderId, true, now - 30);

    const creators = store.listRewindCreators();
    assert.deepEqual(creators.map((creator) => ({
      username: creator.username,
      videos: Number(creator.video_count),
      enabled: Number(creator.enabled),
    })), [
      { username: 'Alice', videos: 2, enabled: 1 },
      { username: 'charlie', videos: 1, enabled: 0 },
      { username: 'bob', videos: 0, enabled: 1 },
    ]);

    const videos = store.listRewindVideos({ limit: 10 });
    assert.deepEqual(videos.map((video) => Number(video.id)), [newestId, olderId, oldSavedOnlyId]);
    assert.equal(videos[0].title, 'Newest Alice title');
    assert.equal(videos[1].title, 'alice-old.mp4');
    assert.deepEqual(
      store.listRewindVideos({ username: 'aLiCe' }).map((video) => Number(video.id)),
      [newestId, olderId],
    );
    assert.deepEqual(
      store.listRewindVideos({ cursor: { createdAt: videos[0].created_at, fileId: newestId } })
        .map((video) => Number(video.id)),
      [olderId, oldSavedOnlyId],
    );
    assert.deepEqual(
      store.listRewindVideos({ bookmarkedOnly: true }).map((video) => Number(video.id)),
      [olderId],
    );
    assert.deepEqual(
      store.listRewindVideos({ fileId: newestId, limit: 1 }).map((video) => Number(video.id)),
      [newestId],
    );
    assert.throws(
      () => store.listRewindVideos({ cursor: { createdAt: -1, fileId: newestId } }),
      /cursor timestamp/i,
    );

    assert.deepEqual({ ...store.getRewindStats(now) }, {
      creator_count: 3,
      video_count: 3,
      size_bytes: 60,
      new_this_week: 2,
      added_today: 2,
    });
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
