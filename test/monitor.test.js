import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TikTokMonitor,
  calculateFailureBackoffMs,
  isVideoNewerThanWatch,
  normalizeWatchedUser,
  resolveVideoTimestampMs,
} from '../src/tiktok/monitor.js';

class FakeStore {
  constructor(watches = [], seenVideos = []) {
    this.watches = watches.map((watch) => ({ ...watch }));
    this.seen = new Set(seenVideos);
    this.seenRecords = [];
    this.successes = [];
    this.failures = [];
  }

  listWatches() {
    return this.watches.map((watch) => ({ ...watch }));
  }

  hasSeenVideo(videoId) {
    return this.seen.has(videoId);
  }

  markVideoSeen(record, now) {
    this.seen.add(record.videoId);
    this.seenRecords.push({ record: { ...record }, now });
  }

  markWatchSuccess(username, now) {
    const watch = this.watches.find((entry) => entry.username === username);
    if (watch) {
      watch.failure_count = 0;
      watch.last_success_at = now;
      watch.last_checked_at = now;
      watch.next_check_at = null;
      watch.last_error = null;
    }
    this.successes.push({ username, now });
  }

  markWatchFailure(username, error, nextCheckAt, now) {
    const watch = this.watches.find((entry) => entry.username === username);
    if (watch) {
      watch.failure_count = Number(watch.failure_count ?? 0) + 1;
      watch.last_checked_at = now;
      watch.next_check_at = nextCheckAt;
      watch.last_error = String(error?.message ?? error);
    }
    this.failures.push({ username, error, nextCheckAt, now });
  }
}

class FakeDownloader {
  constructor(videos = []) {
    this.videos = videos;
    this.listCalls = [];
    this.downloadCalls = [];
    this.error = null;
  }

  async listProfileVideos(profileUrl, options) {
    this.listCalls.push({ profileUrl, options });
    if (this.error) throw this.error;
    return this.videos;
  }

  async download(video, context) {
    this.downloadCalls.push({ video, context });
    return { filePath: `/downloads/${video.id ?? 'unknown'}.mp4` };
  }
}

test('normalizeWatchedUser accepts profile URLs and usernames', () => {
  assert.deepEqual(normalizeWatchedUser('https://www.tiktok.com/@Creator/?lang=en'), {
    username: 'Creator',
    profileUrl: 'https://www.tiktok.com/@Creator',
  });

  assert.deepEqual(normalizeWatchedUser({ username: 'maker' }), {
    username: 'maker',
    profileUrl: 'https://www.tiktok.com/@maker',
  });
});

test('runOnce downloads and alerts only unseen videos', async () => {
  const now = 1_700_000_000_000;
  const alerts = [];
  const store = new FakeStore(
    [
      {
        username: 'creator',
        channel_id: 'channel-1',
        failure_count: 0,
        next_check_at: null,
      },
    ],
    ['seen-1'],
  );
  const downloader = new FakeDownloader([
    {
      id: 'seen-1',
      title: 'Already seen',
      webpage_url: 'https://www.tiktok.com/@creator/video/seen-1',
    },
    {
      id: 'new-2',
      title: 'Brand new',
      url: 'https://www.tiktok.com/@creator/video/2',
    },
  ]);

  const monitor = new TikTokMonitor({
    store,
    downloader,
    alert: async (payload) => {
      alerts.push(payload);
    },
    now: () => now,
  });

  const summary = await monitor.runOnce();

  assert.equal(downloader.listCalls.length, 1);
  assert.equal(downloader.listCalls[0].profileUrl, 'https://www.tiktok.com/@creator');
  assert.equal(downloader.listCalls[0].options.limit, 20);
  assert.equal(downloader.downloadCalls.length, 1);
  assert.equal(downloader.downloadCalls[0].context.profileUrl, 'https://www.tiktok.com/@creator');
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].video.id, 'new-2');
  assert.equal(store.seen.has('new-2'), true);
  assert.equal(store.seenRecords.length, 1);
  assert.equal(store.successes.length, 1);
  assert.equal(store.failures.length, 0);
  assert.deepEqual(summary, {
    watchedUsers: 1,
    skippedUsers: 0,
    scannedVideos: 2,
    downloadedVideos: 1,
    alertedVideos: 1,
    seenVideos: 1,
    failures: 0,
  });
});

test('timestamp helpers compare videos against watch creation time', () => {
  assert.equal(resolveVideoTimestampMs({ timestamp: 1_700_000_000 }), 1_700_000_000_000);
  assert.equal(resolveVideoTimestampMs({ timestamp: 1_700_000_000_000 }), 1_700_000_000_000);
  assert.equal(resolveVideoTimestampMs({ upload_date: '20231114' }), Date.UTC(2023, 10, 14));
  assert.equal(resolveVideoTimestampMs({ created_at: '2023-11-14T22:13:20.000Z' }), 1_700_000_000_000);
  assert.equal(resolveVideoTimestampMs({}), null);

  const watch = { created_at: 1_700_000_000_000 };
  assert.equal(isVideoNewerThanWatch({ timestamp: 1_699_999_999 }, watch), false);
  assert.equal(isVideoNewerThanWatch({ timestamp: 1_700_000_000 }, watch), false);
  assert.equal(isVideoNewerThanWatch({ timestamp: 1_700_000_001 }, watch), true);
  assert.equal(isVideoNewerThanWatch({}, watch), true);
  assert.equal(isVideoNewerThanWatch({ timestamp: 1 }, {}), true);
});

test('runOnce skips videos older than the watch creation time', async () => {
  const now = 1_700_000_100_000;
  const alerts = [];
  const store = new FakeStore([
    {
      username: 'creator',
      channel_id: 'channel-1',
      created_at: 1_700_000_000_000,
      failure_count: 0,
      next_check_at: null,
    },
  ]);
  const downloader = new FakeDownloader([
    {
      id: 'old-1',
      title: 'Old video',
      timestamp: 1_699_999_999,
      webpage_url: 'https://www.tiktok.com/@creator/video/1',
    },
    {
      id: 'new-2',
      title: 'New video',
      timestamp: 1_700_000_001,
      webpage_url: 'https://www.tiktok.com/@creator/video/2',
    },
  ]);

  const monitor = new TikTokMonitor({
    store,
    downloader,
    alert: async (payload) => alerts.push(payload),
    now: () => now,
  });

  const summary = await monitor.runOnce();

  assert.equal(downloader.downloadCalls.length, 1);
  assert.equal(downloader.downloadCalls[0].video.id, 'new-2');
  assert.equal(alerts.length, 1);
  assert.equal(store.seen.has('old-1'), true);
  assert.equal(store.seen.has('new-2'), true);
  assert.deepEqual(summary, {
    watchedUsers: 1,
    skippedUsers: 0,
    scannedVideos: 2,
    downloadedVideos: 1,
    alertedVideos: 1,
    seenVideos: 1,
    failures: 0,
  });
});

test('runOnce baselines timestamp-free videos on the first watch scan', async () => {
  const now = 1_700_000_100_000;
  const alerts = [];
  const store = new FakeStore([
    {
      username: 'creator',
      channel_id: 'channel-1',
      created_at: 1_700_000_000_000,
      last_success_at: null,
      failure_count: 0,
      next_check_at: null,
    },
  ]);
  const downloader = new FakeDownloader([
    {
      id: 'unknown-1',
      title: 'Unknown timestamp',
      webpage_url: 'https://www.tiktok.com/@creator/video/1',
    },
  ]);

  const monitor = new TikTokMonitor({
    store,
    downloader,
    alert: async (payload) => alerts.push(payload),
    now: () => now,
  });

  const summary = await monitor.runOnce();

  assert.equal(downloader.downloadCalls.length, 0);
  assert.equal(alerts.length, 0);
  assert.equal(store.seen.has('unknown-1'), true);
  assert.deepEqual(summary, {
    watchedUsers: 1,
    skippedUsers: 0,
    scannedVideos: 1,
    downloadedVideos: 0,
    alertedVideos: 0,
    seenVideos: 1,
    failures: 0,
  });
});

test('runOnce backoffs failures and skips watches until due', async () => {
  const now = 1_700_000_000_000;
  const store = new FakeStore([
    {
      username: 'creator',
      channel_id: 'channel-1',
      failure_count: 2,
      next_check_at: null,
    },
  ]);
  const downloader = new FakeDownloader();
  downloader.error = new Error('network failed');

  const monitor = new TikTokMonitor({
    store,
    downloader,
    alert: async () => {},
    now: () => now,
  });

  const first = await monitor.runOnce();
  assert.equal(first.failures, 1);
  assert.equal(store.failures.length, 1);
  assert.equal(store.watches[0].failure_count, 3);
  assert.equal(store.watches[0].next_check_at, now + calculateFailureBackoffMs(2));
  assert.match(store.watches[0].last_error, /network failed/);

  const second = await monitor.runOnce();
  assert.equal(second.skippedUsers, 1);
  assert.equal(downloader.listCalls.length, 1);
});
