import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createDownloadService } from '../src/download/service.js';
import { createStore } from '../src/state/store.js';

process.env.NODE_ENV = 'test';
const { checkVideoAvailability, deliverMonitorAlerts } = await import('../src/index.js');

test('deliverMonitorAlerts attempts every target and rejects only after fan-out settles', async (t) => {
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args));

  let releaseSlowTarget;
  const slowTarget = new Promise((resolve) => {
    releaseSlowTarget = resolve;
  });
  const attempted = [];
  let settled = false;

  const delivery = deliverMonitorAlerts(['successful', 'failed', 'slow'], async (target) => {
    attempted.push(target);
    if (target === 'failed') throw new Error('Discord rejected delivery');
    if (target === 'slow') await slowTarget;
  }, { videoId: 'video-123' });
  delivery.finally(() => {
    settled = true;
  }).catch(() => {});

  assert.deepEqual(attempted, ['successful', 'failed', 'slow']);
  await Promise.resolve();
  assert.equal(settled, false);

  releaseSlowTarget();
  await assert.rejects(delivery, (error) => {
    assert(error instanceof AggregateError);
    assert.match(error.message, /1 of 3/);
    assert.match(error.message, /video-123/);
    assert.equal(error.failedTargets, 1);
    assert.equal(error.targetCount, 3);
    assert.equal(error.videoId, 'video-123');
    assert.equal(error.errors[0].message, 'Discord rejected delivery');
    return true;
  });
  assert.equal(settled, true);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0][0], /1 of 3/);
  assert.match(warnings[0][0], /video-123/);
});

test('deliverMonitorAlerts resolves when every delivery succeeds, including zero targets', async () => {
  const attempted = [];
  const outcomes = await deliverMonitorAlerts(['first', 'second'], async (target) => {
    attempted.push(target);
  }, { videoId: 'video-456' });

  assert.deepEqual(attempted, ['first', 'second']);
  assert.deepEqual(outcomes.map((outcome) => outcome.status), ['fulfilled', 'fulfilled']);
  assert.deepEqual(await deliverMonitorAlerts([], async () => {
    assert.fail('zero-target delivery must not run');
  }), []);
});

test('deliverMonitorAlerts persists partial fan-out and retries only failed subscriptions', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tiktok-dlp-alert-fanout-'));
  const store = createStore(path.join(dir, 'state.db'));
  try {
    store.addWatch('creator', { guildId: 'guild-1', channelId: 'channel-1' }, 1000);
    store.addWatch('creator', { guildId: 'guild-2', channelId: 'channel-2' }, 1000);
    const targets = store.listWatchSubscriptions('creator');
    const attempts = [];
    let failSecond = true;
    const deliver = async (target) => {
      attempts.push(target.guild_id);
      if (target.guild_id === 'guild-2' && failSecond) throw new Error('Discord rejected delivery');
    };
    const options = { videoId: 'post-1', eventType: 'new_post', store };

    await assert.rejects(deliverMonitorAlerts(targets, deliver, options), AggregateError);
    assert.deepEqual(attempts, ['guild-1', 'guild-2']);
    assert.equal(store.isAlertDelivered({
      videoId: 'post-1',
      subscriptionId: targets[0].id,
      eventType: 'new_post',
    }), true);
    assert.equal(store.getAlertDelivery({
      videoId: 'post-1',
      subscriptionId: targets[1].id,
      eventType: 'new_post',
    }).status, 'failed');

    failSecond = false;
    const retryOutcomes = await deliverMonitorAlerts(targets, deliver, options);
    assert.deepEqual(retryOutcomes.map((outcome) => outcome.status), ['fulfilled']);
    assert.deepEqual(attempts, ['guild-1', 'guild-2', 'guild-2']);

    assert.deepEqual(await deliverMonitorAlerts(targets, deliver, options), []);
    assert.deepEqual(attempts, ['guild-1', 'guild-2', 'guild-2']);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('failed alert retries reuse one permanent monitor delivery for the target scope', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tiktok-dlp-alert-delivery-reuse-'));
  const store = createStore(path.join(dir, 'state.db'));
  try {
    store.addWatch('creator', { guildId: 'guild-1', channelId: 'channel-1' }, 1000);
    const [target] = store.listWatchSubscriptions('creator');
    const fileId = store.createFileRecord({
      videoId: 'post-1',
      username: 'creator',
      sourceUrl: 'https://www.tiktok.com/@creator/video/post-1',
      filePath: path.join(dir, 'post-1.mp4'),
      filename: 'post-1.mp4',
      sizeBytes: 5,
    }, 1000);
    const asset = {
      fileId,
      platform: 'tiktok',
      videoId: 'post-1',
      username: 'creator',
      sourceUrl: 'https://www.tiktok.com/@creator/video/post-1',
      title: 'Post 1',
    };
    const service = createDownloadService({
      config: {
        downloadDir: path.join(dir, 'downloads'),
        publicBaseUrl: 'https://example.test',
        downloadLinkTtlMinutes: 30,
      },
      store,
    });
    const tokens = [];
    let failuresRemaining = 2;
    const deliver = async () => {
      const result = await service.createDeliveryForAsset(asset, {
        type: 'monitor',
        guildId: 'guild-1',
        channelId: 'channel-1',
        scopeId: 'guild:guild-1',
        permanent: true,
      });
      tokens.push(result.token);
      if (failuresRemaining > 0) {
        failuresRemaining -= 1;
        throw new Error('Discord rejected delivery');
      }
    };
    const options = { videoId: 'post-1', eventType: 'new_post', store };

    await assert.rejects(deliverMonitorAlerts([target], deliver, options), AggregateError);
    await assert.rejects(deliverMonitorAlerts([target], deliver, options), AggregateError);
    await deliverMonitorAlerts([target], deliver, options);

    assert.equal(new Set(tokens).size, 1);
    assert.equal(store.db.prepare(`
      SELECT COUNT(*) AS count
      FROM link_tokens
      WHERE file_id = ? AND scope_id = ? AND delivery_type = 'monitor' AND expires_at = 0
    `).get(fileId, 'guild:guild-1').count, 1);
    assert.equal(store.db.prepare(`
      SELECT COUNT(*) AS count
      FROM jobs
      WHERE file_id = ? AND type = 'monitor'
    `).get(fileId).count, 1);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('deletion availability only treats confirmed not-found responses as missing', async () => {
  const video = { source_url: 'https://www.tiktok.com/@creator/video/123' };
  const adapterCalls = [];
  assert.deepEqual(
    await checkVideoAvailability(video, { marker: 'config' }, async (sourceUrl, options) => {
      adapterCalls.push({ sourceUrl, options });
      return { available: false, reason: 'adapter confirmed missing' };
    }),
    { available: false, reason: 'adapter confirmed missing' },
  );
  assert.equal(adapterCalls[0].sourceUrl, video.source_url);
  assert.equal(adapterCalls[0].options.config.marker, 'config');

  const notFound = Object.assign(new Error('gone'), { kind: 'not_found' });
  assert.deepEqual(
    await checkVideoAvailability(video, {}, async () => { throw notFound; }),
    { available: false, reason: 'gone' },
  );

  for (const kind of ['access_denied', 'access_blocked', 'auth_required', 'invalid_url', 'no_formats']) {
    const error = Object.assign(new Error(kind), { kind });
    await assert.rejects(
      checkVideoAvailability(video, {}, async () => { throw error; }),
      (caught) => caught === error,
    );
  }
});
