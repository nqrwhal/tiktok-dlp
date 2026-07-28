import assert from 'node:assert/strict';
import test from 'node:test';

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

test('deletion availability only treats confirmed not-found responses as missing', async () => {
  const video = { source_url: 'https://www.tiktok.com/@creator/video/123' };
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
