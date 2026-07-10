import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildDownloadsListPayload,
  buildLinkHistoryEmbed,
  buildMonitorAlertPayload,
  handleButtonInteraction,
  monitorScopeMatches,
  resolveMonitorDeliveryScope,
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

test('monitor alert payload is embed-first with monitor-only buttons', async () => {
  const now = 1_700_000_120_000;
  const payload = await buildMonitorAlertPayload({
    token: 'monitor-token',
    publicUrl: 'https://example.com/files/monitor-token',
    filePath: '/tmp/video.mp4',
    filename: 'video.mp4',
    title: 'fresh post',
    sourceUrl: 'https://www.tiktok.com/@creator/video/123',
    sizeBytes: 1024,
    duration: 12,
    videoId: '123',
    username: 'creator',
    timestamp: 1_700_000_000,
    linkPermanent: true,
  }, {
    publicBaseUrl: 'https://example.com',
    discordUploadLimitBytes: 10 * 1024 * 1024,
  }, {
    watch: { username: 'creator' },
    now,
  });

  assert.equal(payload.content, undefined);
  assert.equal(payload.embeds[0].data.title, 'New post by @creator - 2m old');
  const fields = Object.fromEntries(payload.embeds[0].data.fields.map((field) => [field.name, field.value]));
  assert.equal(fields.Type, 'Post');
  assert.equal(fields.Size, '1.0 KB');
  assert.equal(fields.Duration, '12s');
  assert.equal(fields['Saved Copy'], undefined);
  assert.equal(payload.files.length, 1);
  assert.deepEqual(
    payload.components[0].components.map((button) => button.data.label),
    ['Download video', 'Delete post'],
  );
  assert.equal(payload.components[0].components[0].data.url, 'https://example.com/files/monitor-token');
  assert.equal(payload.components[0].components[1].data.custom_id, 'monitor:delete:monitor-token');
});

test('monitor story alert payload reflects story type and keeps download in the button', async () => {
  const payload = await buildMonitorAlertPayload({
    token: 'story-token',
    publicUrl: 'https://example.com/files/story-token',
    filePath: '/tmp/story.mp4',
    filename: 'story.mp4',
    title: 'story clip',
    sourceUrl: 'https://www.tiktok.com/@creator/story/123',
    sizeBytes: 2048,
    duration: 9,
    videoId: '123',
    username: 'creator',
    mediaType: 'story',
    timestamp: 1_700_000_000,
    linkPermanent: true,
  }, {
    publicBaseUrl: 'https://example.com',
    discordUploadLimitBytes: 10,
  }, {
    watch: { username: 'creator' },
    now: 1_700_000_120_000,
  });

  const fields = Object.fromEntries(payload.embeds[0].data.fields.map((field) => [field.name, field.value]));
  assert.equal(payload.embeds[0].data.title, 'New story by @creator - 2m old');
  assert.equal(fields.Type, 'Story');
  assert.equal(fields.Size, '2.0 KB');
  assert.equal(fields.Duration, '9s');
  assert.equal(fields['Saved Copy'], undefined);
  assert.equal(payload.files.length, 0);
  assert.deepEqual(
    payload.components[0].components.map((button) => button.data.label),
    ['Download story', 'Delete post'],
  );
  assert.equal(payload.components[0].components[0].data.url, 'https://example.com/files/story-token');
});

test('monitor slideshow alerts attach galleries only when Discord can show all images', async () => {
  const galleryPayload = await buildMonitorAlertPayload({
    token: 'zip-token',
    publicUrl: 'https://example.com/files/zip-token',
    filePath: '/tmp/slideshow.zip',
    filename: 'slideshow.zip',
    title: 'photo post',
    sizeBytes: 2048,
    videoId: 'photo-1',
    username: 'creator',
    mediaType: 'slideshow',
    imageCount: 2,
    slideshowImagePaths: ['/tmp/slideshow__001.jpg', '/tmp/slideshow__002.jpg'],
  }, {
    publicBaseUrl: 'https://example.com',
    discordUploadLimitBytes: 10 * 1024 * 1024,
  }, {
    watch: { username: 'creator' },
    now: 1_700_000_000_000,
  });

  assert.deepEqual(galleryPayload.files.map((file) => file.name), ['slideshow__001.jpg', 'slideshow__002.jpg']);
  assert.equal(galleryPayload.components[0].components[0].data.label, 'Download ZIP');
  assert.match(galleryPayload.embeds[0].data.fields.find((field) => field.name === 'Slideshow').value, /attached below/);

  const zipPayload = await buildMonitorAlertPayload({
    token: 'large-zip-token',
    publicUrl: 'https://example.com/files/large-zip-token',
    filePath: '/tmp/large-slideshow.zip',
    filename: 'large-slideshow.zip',
    title: 'large photo post',
    sizeBytes: 2048,
    videoId: 'photo-2',
    username: 'creator',
    mediaType: 'slideshow',
    imageCount: 12,
    slideshowImagePaths: [],
  }, {
    publicBaseUrl: 'https://example.com',
    discordUploadLimitBytes: 10 * 1024 * 1024,
  }, {
    watch: { username: 'creator' },
    now: 1_700_000_000_000,
  });

  assert.deepEqual(zipPayload.files.map((file) => file.name), ['large-slideshow.zip']);
  assert.match(zipPayload.embeds[0].data.fields.find((field) => field.name === 'Slideshow').value, /up to 10 attachments/);
});

test('monitor delete button removes saved post records and slideshow sidecars', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tiktok-dlp-monitor-delete-'));
  const store = createStore(path.join(dir, 'state.db'));
  try {
    const zipPath = path.join(dir, 'slideshow.zip');
    const sidecarPath = path.join(dir, 'slideshow__001.jpg');
    await writeFile(zipPath, 'zip');
    await writeFile(sidecarPath, 'image');

    const fileId = store.createFileRecord({
      videoId: 'photo-1',
      username: 'creator',
      sourceUrl: 'https://www.tiktok.com/@creator/photo/photo-1',
      filePath: zipPath,
      filename: 'slideshow.zip',
      sizeBytes: 3,
    }, 1000);
    const jobId = store.createJob({
      type: 'monitor',
      username: 'creator',
      sourceUrl: 'https://www.tiktok.com/@creator/photo/photo-1',
      videoId: 'photo-1',
      title: 'photo post',
    }, 1000);
    store.updateJob(jobId, { status: 'complete', file_id: fileId }, 1000);
    store.createLinkToken({
      token: 'monitor-token',
      fileId,
      scopeId: 'channel:channel-1',
      deliveryType: 'monitor',
      expiresAt: 0,
    }, 1000);
    store.markVideoSeen({
      videoId: 'photo-1',
      username: 'creator',
      sourceUrl: 'https://www.tiktok.com/@creator/photo/photo-1',
      title: 'photo post',
      alertedAt: 1000,
    }, 1000);
    store.scheduleVideoDeletionCheck('photo-1', 5000);

    const updates = [];
    const followUps = [];
    const handled = await handleButtonInteraction({
      config: { downloadDir: dir, publicBaseUrl: 'https://example.com' },
      store,
      interaction: {
        customId: 'monitor:delete:monitor-token',
        guildId: 'guild-1',
        channelId: 'channel-1',
        memberPermissions: { has: () => true },
        update: async (payload) => updates.push(payload),
        followUp: async (payload) => followUps.push(payload),
        reply: async (payload) => followUps.push(payload),
      },
    });

    assert.equal(handled, true);
    assert.equal(store.getToken('monitor-token'), null);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM jobs WHERE file_id = ?').get(fileId).count, 0);
    assert.equal(store.db.prepare('SELECT next_deletion_check_at FROM seen_videos WHERE video_id = ?').get('photo-1').next_deletion_check_at, null);
    await assert.rejects(access(zipPath));
    await assert.rejects(access(sidecarPath));
    assert.deepEqual(updates[0], { components: [] });
    assert.equal(followUps[0].embeds[0].data.title, 'Monitored Delivery Deleted');
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('monitor scope compatibility stays bound to the original channel', async () => {
  assert.equal(monitorScopeMatches('channel:channel-1', {
    guildId: 'guild-1',
    channelId: 'channel-1',
  }), true);
  assert.equal(monitorScopeMatches('channel:channel-1', {
    guildId: 'guild-1',
    channelId: 'channel-2',
  }), false);
  assert.equal(monitorScopeMatches('guild:guild-1', {
    guildId: 'guild-2',
    channelId: 'channel-1',
  }), false);
});

test('legacy watch targets resolve to their Discord guild for new deliveries', async () => {
  const fetched = [];
  const resolved = await resolveMonitorDeliveryScope({
    channels: {
      cache: new Map(),
      fetch: async (channelId) => {
        fetched.push(channelId);
        return { guildId: 'guild-1' };
      },
    },
  }, {
    guild_id: '',
    channel_id: 'channel-1',
  });

  assert.deepEqual(fetched, ['channel-1']);
  assert.deepEqual(resolved, {
    guildId: 'guild-1',
    channelId: 'channel-1',
    scopeId: 'guild:guild-1',
  });
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
