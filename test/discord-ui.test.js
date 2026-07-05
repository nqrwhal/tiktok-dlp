import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildDownloadsListPayload,
  buildLinkHistoryEmbed,
  handleButtonInteraction,
} from '../src/discord/client.js';
import { createStore } from '../src/state/store.js';

test('downloads list payload shows saved permanent downloads only', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tiktok-dlp-ui-list-'));
  const store = createStore(path.join(dir, 'state.db'));
  try {
    const longTitle = 'caption '.repeat(40);
    const longFileId = store.createFileRecord({
      videoId: 'v-long',
      requestedBy: 'user-1',
      username: 'OpenAI',
      sourceUrl: 'https://www.tiktok.com/@openai/video/v-long',
      filePath: path.join(dir, 'long.mp4'),
      filename: 'long.mp4',
      sizeBytes: 1024,
    }, 1000);
    const longJobId = store.createJob({
      type: 'manual',
      requestedBy: 'user-1',
      username: 'OpenAI',
      sourceUrl: 'https://www.tiktok.com/@openai/video/v-long',
      title: longTitle,
    }, 1100);
    store.updateJob(longJobId, { status: 'complete', file_id: longFileId }, 1200);
    store.createLinkToken({ token: 'old-permanent', fileId: longFileId, expiresAt: 0 }, 1300);
    store.createLinkToken({ token: 'new-permanent', fileId: longFileId, expiresAt: 0 }, 5000);

    const shortFileId = store.createFileRecord({
      videoId: 'v-short',
      requestedBy: 'user-1',
      username: 'other',
      sourceUrl: 'https://www.tiktok.com/@other/video/v-short',
      filePath: path.join(dir, 'short.mp4'),
      filename: 'short.mp4',
      sizeBytes: 2048,
    }, 2000);
    store.createLinkToken({ token: 'short-permanent', fileId: shortFileId, expiresAt: 0 }, 3000);

    const tempFileId = store.createFileRecord({
      videoId: 'v-temp',
      requestedBy: 'user-1',
      username: 'OpenAI',
      sourceUrl: 'https://www.tiktok.com/@openai/video/v-temp',
      filePath: path.join(dir, 'temp.mp4'),
      filename: 'temp.mp4',
      sizeBytes: 4096,
    }, 4000);
    store.createLinkToken({ token: 'temp-token', fileId: tempFileId, expiresAt: 999999 }, 6000);

    const payload = buildDownloadsListPayload({
      config: { publicBaseUrl: 'https://example.com' },
      store,
      userId: 'user-1',
      limit: 1,
      page: 0,
    });

    const embed = payload.embeds[0].data;
    assert.equal(embed.title, 'Saved Downloads');
    assert.match(embed.footer.text, /2 saved downloads/);
    assert.equal(embed.fields.length, 1);
    assert.match(embed.fields[0].name, /@OpenAI/);
    assert.match(embed.fields[0].name, /\.\.\./);
    assert.match(embed.fields[0].value, /https:\/\/example\.com\/files\/new-permanent/);
    assert.doesNotMatch(embed.fields[0].value, /old-permanent|temp-token/);
    assert.match(embed.fields[0].value, /post: v-long/);

    const [previous, next] = payload.components[0].components;
    assert.equal(previous.data.disabled, true);
    assert.equal(next.data.disabled, false);
    assert.ok(next.data.custom_id.length <= 100);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('downloads list payload supports username empty state', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tiktok-dlp-ui-empty-'));
  const store = createStore(path.join(dir, 'state.db'));
  try {
    const payload = buildDownloadsListPayload({
      config: { publicBaseUrl: 'https://example.com' },
      store,
      userId: 'user-1',
      username: 'openai',
    });
    const embed = payload.embeds[0].data;
    assert.equal(embed.title, 'Saved Downloads for @openai');
    assert.match(embed.description, /No permanent downloads saved for @openai/);
    assert.equal(payload.components.length, 0);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('downloads list buttons are scoped to the requesting user', async () => {
  const replies = [];
  const handled = await handleButtonInteraction({
    config: { publicBaseUrl: 'https://example.com' },
    store: {},
    interaction: {
      customId: 'downloads:list:user-1:10:1:openai',
      user: { id: 'user-2' },
      reply: async (payload) => replies.push(payload),
    },
  });

  assert.equal(handled, true);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].embeds[0].data.title, 'Not Your List');
  assert.equal(replies[0].ephemeral, true);
});

test('link history embed shows temporary, permanent, and expired states', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tiktok-dlp-ui-history-'));
  const store = createStore(path.join(dir, 'state.db'));
  try {
    const fileId = store.createFileRecord({
      videoId: 'v-history',
      requestedBy: 'user-1',
      username: 'openai',
      sourceUrl: 'https://www.tiktok.com/@openai/video/v-history',
      filePath: path.join(dir, 'history.mp4'),
      filename: 'history.mp4',
      sizeBytes: 512,
    }, 1000);
    const jobId = store.createJob({
      type: 'manual',
      status: 'complete',
      requestedBy: 'user-1',
      username: 'openai',
      sourceUrl: 'https://www.tiktok.com/@openai/video/v-history',
      title: 'history title',
    }, 1100);
    store.updateJob(jobId, { file_id: fileId }, 1200);
    store.createLinkToken({ token: 'expired-token', fileId, expiresAt: 2000 }, 1300);
    store.createLinkToken({ token: 'active-token', fileId, expiresAt: 10000 }, 1400);
    store.createLinkToken({ token: 'permanent-token', fileId, expiresAt: 0 }, 1500);

    const history = store.listLinkHistoryByRequester('user-1', { limit: 10 });
    const embed = buildLinkHistoryEmbed(history, {
      config: { publicBaseUrl: 'https://example.com' },
      now: 5000,
    }).data;
    const values = embed.fields.map((field) => field.value).join('\n');

    assert.equal(embed.title, 'Download Link History');
    assert.equal(embed.fields.length, 3);
    assert.match(values, /permanent/);
    assert.match(values, /expires 1970-01-01T00:00:10\.000Z/);
    assert.match(values, /expired 1970-01-01T00:00:02\.000Z/);
    assert.match(values, /job: complete/);
    assert.match(values, /history title|v-history/);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
