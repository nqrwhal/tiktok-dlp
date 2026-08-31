import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { handleInteraction } from '../src/discord/client.js';
import { createStore } from '../src/state/store.js';

function makeWatchInteraction(subcommand, {
  guildId = 'guild-1',
  channelId = 'channel-1',
  values = {},
} = {}) {
  const replies = [];
  const edits = [];
  const deferrals = [];
  return {
    replies,
    edits,
    deferrals,
    interaction: {
      commandName: 'watch',
      guildId,
      channelId,
      user: { id: 'manager-1' },
      memberPermissions: { has: () => true },
      options: {
        getSubcommand: () => subcommand,
        getString: (name) => values[name] ?? null,
      },
      async reply(payload) {
        replies.push(payload);
      },
      async deferReply(payload) {
        deferrals.push(payload);
      },
      async editReply(payload) {
        edits.push(payload);
      },
    },
  };
}

test('watch failure listing and retry stay scoped to the current Discord watch', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'discord-monitor-failures-'));
  const store = createStore(path.join(dir, 'state.db'));
  try {
    store.addWatch('creator', {
      guildId: 'guild-1',
      channelId: 'channel-1',
      createdBy: 'manager-1',
    }, 500);
    store.recordMonitorDownloadFailure({
      videoId: 'broken-1',
      username: 'creator',
      sourceUrl: 'https://www.tiktok.com/@creator/video/broken-1',
      title: 'Broken post',
      error: 'extractor failed',
    }, 1, 1_000);

    const ownList = makeWatchInteraction('failures');
    await handleInteraction({
      interaction: ownList.interaction,
      config: {},
      store,
      monitor: {},
      downloadOne: async () => {},
    });
    assert.equal(ownList.replies[0].embeds[0].data.title, 'Monitor Failures');
    assert.match(ownList.replies[0].embeds[0].data.description, /@creator/);
    assert.match(ownList.replies[0].embeds[0].data.description, /broken-1/);
    assert.match(ownList.replies[0].embeds[0].data.description, /extractor failed/);

    const otherList = makeWatchInteraction('failures', {
      guildId: 'guild-2',
      channelId: 'channel-2',
    });
    await handleInteraction({
      interaction: otherList.interaction,
      config: {},
      store,
      monitor: {},
      downloadOne: async () => {},
    });
    assert.match(otherList.replies[0].embeds[0].data.description, /No monitored posts/);
    assert.doesNotMatch(otherList.replies[0].embeds[0].data.description, /broken-1/);

    const deniedRetry = makeWatchInteraction('retry', {
      guildId: 'guild-2',
      channelId: 'channel-2',
      values: { post_id: 'broken-1' },
    });
    await handleInteraction({
      interaction: deniedRetry.interaction,
      config: {},
      store,
      monitor: { retryFailedVideo: async () => assert.fail('out-of-scope retry was invoked') },
      downloadOne: async () => {},
    });
    assert.equal(deniedRetry.replies[0].embeds[0].data.title, 'Monitor Failure Not Found');

    const retryCalls = [];
    const ownRetry = makeWatchInteraction('retry', { values: { post_id: 'broken-1' } });
    await handleInteraction({
      interaction: ownRetry.interaction,
      config: {},
      store,
      monitor: {
        async retryFailedVideo(videoId) {
          retryCalls.push(videoId);
          return { accepted: true, completed: true };
        },
      },
      downloadOne: async () => {},
    });
    assert.deepEqual(retryCalls, ['broken-1']);
    assert.deepEqual(ownRetry.deferrals, [{ ephemeral: true }]);
    assert.equal(ownRetry.edits[0].embeds[0].data.title, 'Monitor Retry Succeeded');
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a failed manual monitor retry remains visible to the operator', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'discord-monitor-retry-failed-'));
  const store = createStore(path.join(dir, 'state.db'));
  try {
    store.addWatch('creator', { guildId: 'guild-1', channelId: 'channel-1' }, 500);
    store.recordMonitorDownloadFailure({
      videoId: 'broken-2',
      username: 'creator',
      sourceUrl: 'https://www.tiktok.com/@creator/video/broken-2',
      error: 'initial failure',
    }, 1, 1_000);

    const retry = makeWatchInteraction('retry', { values: { post_id: 'broken-2' } });
    await handleInteraction({
      interaction: retry.interaction,
      config: {},
      store,
      monitor: {
        retryFailedVideo: async () => ({
          accepted: true,
          completed: false,
          failure: { last_error: 'still unavailable' },
        }),
      },
      downloadOne: async () => {},
    });

    assert.equal(retry.edits[0].embeds[0].data.title, 'Monitor Retry Failed');
    assert.match(retry.edits[0].embeds[0].data.description, /\/watch failures/);
    assert.match(retry.edits[0].embeds[0].data.description, /still unavailable/);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
