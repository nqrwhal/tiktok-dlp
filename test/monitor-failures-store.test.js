import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createStore } from '../src/state/store.js';

test('monitor download failures persist, dead-letter, retry, recover, and resolve', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'monitor-failures-store-'));
  const dbPath = path.join(dir, 'state.db');
  let store = createStore(dbPath);

  try {
    store.addWatch('creator', {
      guildId: 'guild-1',
      channelId: 'channel-1',
      createdBy: 'manager-1',
    }, 500);

    const first = store.recordMonitorDownloadFailure({
      videoId: 'broken-1',
      username: 'creator',
      sourceUrl: 'https://www.tiktok.com/@creator/video/broken-1',
      title: 'Broken post',
      mediaType: 'video',
      error: new Error('first failure'),
    }, 2, 1_000);
    assert.equal(first.status, 'retryable');
    assert.equal(first.failure_count, 1);
    assert.equal(store.isMonitorDownloadDeadLettered('broken-1'), false);

    store.close();
    store = createStore(dbPath);

    const second = store.recordMonitorDownloadFailure({
      videoId: 'broken-1',
      username: 'creator',
      sourceUrl: 'https://www.tiktok.com/@creator/video/broken-1',
      title: 'Broken post',
      mediaType: 'video',
      error: new Error('second failure'),
    }, 2, 2_000);
    assert.equal(second.status, 'dead_letter');
    assert.equal(second.failure_count, 2);
    assert.equal(second.dead_lettered_at, 2_000);
    assert.equal(store.stats().deadLetterCount, 1);

    const suppressed = store.recordMonitorDownloadFailure({
      videoId: 'broken-1',
      error: new Error('late concurrent failure'),
    }, 2, 2_500);
    assert.equal(suppressed.failure_count, 2);
    assert.equal(suppressed.last_error, 'second failure');

    assert.deepEqual(
      store.listMonitorDownloadFailuresForScope({ guildId: 'guild-1', channelId: 'channel-1' })
        .map((failure) => failure.video_id),
      ['broken-1'],
    );
    assert.deepEqual(
      store.listMonitorDownloadFailuresForScope({ guildId: 'guild-2', channelId: 'channel-2' }),
      [],
    );

    const retry = store.retryMonitorDownloadFailure('broken-1', 3_000);
    assert.equal(retry.accepted, true);
    assert.equal(retry.failure.status, 'retrying');
    assert.equal(retry.failure.retry_count, 1);

    store.close();
    store = createStore(dbPath);
    const recovered = store.getMonitorDownloadFailure('broken-1');
    assert.equal(recovered.status, 'dead_letter');
    assert.equal(recovered.dead_lettered_at, 2_000);

    assert.equal(store.retryMonitorDownloadFailure('broken-1', 4_000).accepted, true);
    const retriedFailure = store.recordMonitorDownloadFailure({
      videoId: 'broken-1',
      username: 'creator',
      sourceUrl: 'https://www.tiktok.com/@creator/video/broken-1',
      error: new Error('manual retry failed'),
    }, 2, 4_100);
    assert.equal(retriedFailure.status, 'dead_letter');
    assert.equal(retriedFailure.failure_count, 3);
    assert.equal(retriedFailure.retry_count, 2);
    assert.equal(retriedFailure.last_error, 'manual retry failed');

    assert.equal(store.retryMonitorDownloadFailure('broken-1', 5_000).accepted, true);
    const resolved = store.markMonitorDownloadFailureResolved('broken-1', 5_100);
    assert.equal(resolved.status, 'resolved');
    assert.equal(resolved.resolved_at, 5_100);
    assert.equal(store.stats().deadLetterCount, 0);
    assert.deepEqual(store.listMonitorDownloadFailures(), []);
    assert.deepEqual(store.retryMonitorDownloadFailure('broken-1', 5_200), {
      accepted: false,
      reason: 'not_retryable',
      failure: resolved,
    });
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('monitor dead letters follow TikTok watch username changes', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'monitor-failures-rename-'));
  const store = createStore(path.join(dir, 'state.db'));
  try {
    store.addWatch('old-name', { guildId: 'guild-1', channelId: 'channel-1' }, 500);
    store.recordMonitorDownloadFailure({
      videoId: 'post-1',
      username: 'old-name',
      sourceUrl: 'https://www.tiktok.com/@old-name/video/post-1',
      error: 'broken',
    }, 1, 1_000);

    store.recordWatchIdentity('old-name', {
      currentUsername: 'new-name',
      creatorId: '1234567890123456789',
    }, 2_000);

    assert.equal(store.getMonitorDownloadFailure('post-1').username, 'new-name');
    assert.deepEqual(
      store.listMonitorDownloadFailuresForScope({
        guildId: 'guild-1',
        channelId: 'channel-1',
        username: 'new-name',
      }).map((failure) => failure.video_id),
      ['post-1'],
    );
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
