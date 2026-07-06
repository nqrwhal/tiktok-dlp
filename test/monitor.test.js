import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TikTokMonitor,
  calculateFailureBackoffMs,
  isVideoNewerThanWatch,
  nextDeletionCheckDelayMs,
  normalizeWatchedUser,
  resolveProfileCreatorId,
  resolveProfileUsername,
  resolveVideoMediaType,
  resolveVideoTimestampMs,
} from '../src/tiktok/monitor.js';

const TEST_SEC_UID = `MS4wLjABAAAA${'b'.repeat(64)}`;

class FakeStore {
  constructor(watches = [], seenVideos = []) {
    this.watches = watches.map((watch) => ({ ...watch }));
    this.seen = new Set(seenVideos);
    this.seenRecords = [];
    this.successes = [];
    this.failures = [];
    this.usernameChanges = [];
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

  markWatchSuccess(username, now, nextCheckAt = null) {
    const watch = this.watches.find((entry) => entry.username === username);
    if (watch) {
      watch.failure_count = 0;
      watch.last_success_at = now;
      watch.last_checked_at = now;
      watch.next_check_at = nextCheckAt;
      watch.last_error = null;
    }
    this.successes.push({ username, now, nextCheckAt });
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

  recordWatchIdentity(username, { creatorId = '', currentUsername = '', secUid = '', authorId = '' } = {}, now) {
    const watch = this.watches.find((entry) => entry.username === username);
    if (!watch) return { changed: false, username, previousUsername: username, creatorId, secUid, authorId };
    if (creatorId) watch.creator_id = creatorId;
    if (secUid) watch.sec_uid = secUid;
    if (authorId) watch.author_id = authorId;
    if (currentUsername && currentUsername.toLowerCase() !== username.toLowerCase()) {
      watch.username = currentUsername;
      watch.previous_username = username;
      watch.username_changed_at = now;
      this.usernameChanges.push({ username, currentUsername, creatorId, secUid, authorId, now });
      return { changed: true, username: currentUsername, previousUsername: username, creatorId, secUid, authorId };
    }
    return { changed: false, username, previousUsername: username, creatorId, secUid, authorId };
  }
}

class FakeDownloader {
  constructor(videos = [], stories = []) {
    this.videos = videos;
    this.stories = stories;
    this.listCalls = [];
    this.storyCalls = [];
    this.downloadCalls = [];
    this.error = null;
  }

  async listProfileVideos(profileUrl, options) {
    this.listCalls.push({ profileUrl, options });
    if (this.error) throw this.error;
    return this.videos;
  }

  async listProfileStories(storyUrl, options) {
    this.storyCalls.push({ storyUrl, options });
    return this.stories;
  }

  async download(video, context) {
    this.downloadCalls.push({ video, context });
    return { filePath: `/downloads/${video.id ?? 'unknown'}.mp4`, mediaType: video.mediaType };
  }
}

test('normalizeWatchedUser accepts profile URLs and usernames', () => {
  assert.deepEqual(normalizeWatchedUser('https://www.tiktok.com/@Creator/?lang=en'), {
    username: 'Creator',
    profileUrl: 'https://www.tiktok.com/@Creator',
    storyUrl: 'https://www.tiktok.com/@Creator/story',
  });

  assert.deepEqual(normalizeWatchedUser({ username: 'maker' }), {
    username: 'maker',
    profileUrl: 'https://www.tiktok.com/@maker',
    storyUrl: 'https://www.tiktok.com/@maker/story',
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

  const summary = await monitor.runOnce({ waitForDownloads: true });

  assert.equal(downloader.listCalls.length, 1);
  assert.equal(downloader.listCalls[0].profileUrl, 'https://www.tiktok.com/@creator');
  assert.equal(downloader.listCalls[0].options.limit, 5);
  assert.equal(downloader.downloadCalls.length, 1);
  assert.equal(downloader.downloadCalls[0].context.profileUrl, 'https://www.tiktok.com/@creator');
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].video.id, 'new-2');
  assert.equal(store.seen.has('new-2'), true);
  assert.equal(store.seenRecords.length, 1);
  assert.equal(store.successes.length, 1);
  assert.equal(store.successes[0].nextCheckAt, now + 60 * 1000);
  assert.equal(store.watches[0].next_check_at, now + 60 * 1000);
  assert.equal(store.failures.length, 0);
  assert.deepEqual(summary, {
    watchedUsers: 1,
    skippedUsers: 0,
    scannedVideos: 2,
    queuedDownloads: 1,
    downloadedVideos: 1,
    alertedVideos: 1,
    seenVideos: 1,
    failures: 0,
  });
});

test('runOnce downloads unseen stories when detected', async () => {
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
  const downloader = new FakeDownloader([], {
    metadata: {
      uploader: 'creator',
      username: 'creator',
      user_id: '424242424242',
      channel_id: TEST_SEC_UID,
      mediaType: 'story',
    },
    entries: [
      {
        id: 'story-1',
        title: 'Story',
        mediaType: 'story',
        timestamp: 1_699_999_999,
        webpage_url: 'https://www.tiktok.com/@creator/story/1111111111',
      },
    ],
  });

  const monitor = new TikTokMonitor({
    store,
    downloader,
    alert: async (payload) => alerts.push(payload),
    now: () => now,
  });

  const summary = await monitor.runOnce({ waitForDownloads: true });

  assert.equal(downloader.storyCalls.length, 1);
  assert.equal(downloader.storyCalls[0].storyUrl, 'https://www.tiktok.com/@creator/story');
  assert.equal(downloader.downloadCalls.length, 1);
  assert.equal(downloader.downloadCalls[0].video.mediaType, 'story');
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].video.mediaType, 'story');
  assert.equal(store.seen.has('story-1'), true);
  assert.equal(store.watches[0].author_id, '424242424242');
  assert.equal(store.watches[0].sec_uid, TEST_SEC_UID);
  assert.equal(resolveVideoMediaType(alerts[0].video), 'story');
  assert.deepEqual(summary, {
    watchedUsers: 1,
    skippedUsers: 0,
    scannedVideos: 1,
    queuedDownloads: 1,
    downloadedVideos: 1,
    alertedVideos: 1,
    seenVideos: 0,
    failures: 0,
  });
});

test('runOnce burst scans when the normal profile window is full of new posts', async () => {
  const now = 1_700_000_200_000;
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
  const downloader = new FakeDownloader([]);
  downloader.listProfileVideos = async (profileUrl, options) => {
    downloader.listCalls.push({ profileUrl, options });
    const count = options.limit === 20 ? 8 : 5;
    return Array.from({ length: count }, (_, index) => ({
      id: `new-${index + 1}`,
      title: `New ${index + 1}`,
      timestamp: 1_700_000_100 + index,
      webpage_url: `https://www.tiktok.com/@creator/video/${index + 1}`,
    }));
  };

  const monitor = new TikTokMonitor({
    store,
    downloader,
    alert: async (payload) => alerts.push(payload),
    now: () => now,
    scanLimit: 5,
    burstScanLimit: 20,
  });

  const summary = await monitor.runOnce({ waitForDownloads: true });

  assert.equal(downloader.listCalls.length, 2);
  assert.equal(downloader.listCalls[0].options.limit, 5);
  assert.equal(downloader.listCalls[1].options.limit, 20);
  assert.equal(downloader.downloadCalls.length, 8);
  assert.equal(alerts.length, 8);
  assert.deepEqual(summary, {
    watchedUsers: 1,
    skippedUsers: 0,
    scannedVideos: 8,
    queuedDownloads: 8,
    downloadedVideos: 8,
    alertedVideos: 8,
    seenVideos: 0,
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

test('profile identity helpers resolve usernames and creator ids', () => {
  const profile = {
    metadata: { uploader: 'new.creator', uploader_id: 'stable-123' },
    entries: [{ uploader: 'fallback' }],
  };
  assert.equal(resolveProfileUsername(profile, 'old.creator'), 'new.creator');
  assert.equal(resolveProfileCreatorId(profile), 'stable-123');
  assert.equal(nextDeletionCheckDelayMs(0), 60 * 1000);
  assert.equal(nextDeletionCheckDelayMs(5), 25 * 60 * 1000);
});

test('runOnce records username changes when profile metadata changes', async () => {
  const now = 1_700_000_000_000;
  const changes = [];
  const store = new FakeStore([
    {
      username: 'old.creator',
      channel_id: 'channel-1',
      failure_count: 0,
      next_check_at: null,
    },
  ]);
  const downloader = new FakeDownloader([]);
  downloader.listProfileVideos = async (profileUrl, options) => {
    downloader.listCalls.push({ profileUrl, options });
    return {
      metadata: { uploader: 'new.creator', uploader_id: 'stable-123' },
      entries: [],
    };
  };

  const monitor = new TikTokMonitor({
    store,
    downloader,
    usernameChangeAlert: async (payload) => changes.push(payload),
    now: () => now,
  });

  await monitor.runOnce();

  assert.equal(store.watches[0].username, 'new.creator');
  assert.equal(store.watches[0].previous_username, 'old.creator');
  assert.equal(store.watches[0].creator_id, 'stable-123');
  assert.equal(store.successes[0].username, 'new.creator');
  assert.equal(changes.length, 1);
  assert.equal(changes[0].previousUsername, 'old.creator');
  assert.equal(changes[0].username, 'new.creator');
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

  const summary = await monitor.runOnce({ waitForDownloads: true });

  assert.equal(downloader.downloadCalls.length, 1);
  assert.equal(downloader.downloadCalls[0].video.id, 'new-2');
  assert.equal(alerts.length, 1);
  assert.equal(store.seen.has('old-1'), true);
  assert.equal(store.seen.has('new-2'), true);
  assert.deepEqual(summary, {
    watchedUsers: 1,
    skippedUsers: 0,
    scannedVideos: 2,
    queuedDownloads: 1,
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
    queuedDownloads: 0,
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

test('runOnce sends deletion alerts for saved posts that disappear', async () => {
  const now = 1_700_000_000_000;
  const alerts = [];
  const dueVideo = {
    video_id: 'deleted-1',
    username: 'creator',
    source_url: 'https://www.tiktok.com/@creator/video/deleted-1',
    title: 'Deleted video',
    deletion_check_count: 0,
    permanent_token: 'tok',
  };
  const store = {
    listWatches: () => [],
    listVideosDueForDeletionCheck: () => [dueVideo],
    markVideoDeleted: (videoId, deletedAt) => ({ ...dueVideo, video_id: videoId, deleted_at: deletedAt }),
  };
  const downloader = {
    listProfileVideos: async () => [],
    download: async () => ({}),
    checkVideoAvailable: async () => ({ available: false, reason: 'not found' }),
  };

  const monitor = new TikTokMonitor({
    store,
    downloader,
    deletionAlert: async (payload) => alerts.push(payload),
    now: () => now,
  });

  const summary = await monitor.runOnce();

  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].video.video_id, 'deleted-1');
  assert.equal(alerts[0].video.deleted_at, now);
  assert.equal(alerts[0].reason, 'not found');
  assert.equal(summary.watchedUsers, 0);
});
