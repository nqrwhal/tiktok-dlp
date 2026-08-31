import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildHelpMessage,
  extractDownloadPostUrls,
  handleInteraction,
  handleMessageCreate,
  normalizeDownloadPostUrl,
  shouldShowHelp,
} from '../src/discord/client.js';

test('Discord post extraction accepts canonical supported posts and rejects unsafe or non-post URLs', () => {
  const content = [
    'unsafe http://x.com/creator/status/111',
    'credentials https://user:password@x.com/creator/status/222',
    'spoof https://www.instagram.com.evil.test/p/Spoof/',
    'profile https://www.instagram.com/creator/',
    'TikTok <https://m.tiktok.com/@Creator/video/7350000000000000000?utm_source=chat>',
    'Instagram https://instagram.com/reels/Ab_C-1/?igsh=tracking,',
    'X https://twitter.com/OpenAI/status/123456789/photo/1?s=20',
    'duplicate https://x.com/openai/status/123456789',
    'over-limit https://www.instagram.com/p/FourthPost/',
  ].join(' ');

  assert.deepEqual(extractDownloadPostUrls(content), [
    'https://www.tiktok.com/@creator/video/7350000000000000000',
    'https://www.instagram.com/reel/Ab_C-1/',
    'https://x.com/openai/status/123456789',
  ]);
  assert.deepEqual(extractDownloadPostUrls(content, 2), [
    'https://www.tiktok.com/@creator/video/7350000000000000000',
    'https://www.instagram.com/reel/Ab_C-1/',
  ]);
  assert.deepEqual(extractDownloadPostUrls([
    'https://vm.tiktok.com/ZMshortOne/?utm_source=chat',
    'https://vt.tiktok.com/ZShortTwo/',
    'https://www.tiktok.com/t/ZShortThree/?share=1',
    'https://www.tiktok.com/@creator',
  ].join(' ')), [
    'https://vm.tiktok.com/ZMshortOne/',
    'https://vt.tiktok.com/ZShortTwo/',
    'https://www.tiktok.com/t/ZShortThree/?share=1',
  ]);

  assert.equal(
    normalizeDownloadPostUrl('https://www.twitter.com/OpenAI/status/123456789/video/1?t=tracking'),
    'https://x.com/openai/status/123456789',
  );
  assert.equal(
    normalizeDownloadPostUrl('https://vm.tiktok.com/ZMshortOne/?utm_source=chat'),
    'https://vm.tiktok.com/ZMshortOne/',
  );
  for (const value of [
    'http://www.instagram.com/p/Ab_C-1/',
    'https://user:password@x.com/openai/status/123456789',
    'https://x.com.evil.test/openai/status/123456789',
    'https://www.instagram.com/openai/',
    'https://x.com/explore',
    'https://www.tiktok.com/explore',
  ]) {
    assert.throws(() => normalizeDownloadPostUrl(value), /post URL/);
  }
});

test('help copy covers supported post saves without claiming cross-platform monitoring', () => {
  const payload = buildHelpMessage();
  const description = payload.embeds[0].data.description;
  assert.equal(payload.embeds[0].data.title, 'Media Downloader Help');
  assert.match(description, /TikTok, Instagram, or X post URL/);
  assert.match(description, /\/profiles link\|show\|unlink/);
  assert.match(description, /TikTok profiles only for now/);
  assert.doesNotMatch(description, /Instagram profiles|X profiles/);
  assert.equal(shouldShowHelp({ content: 'media help', inGuild: () => true }), true);
  assert.equal(shouldShowHelp({ content: '!download help', inGuild: () => true }), true);
});

test('message ingress keeps the three-link result flow across supported platforms', async () => {
  const statusEdits = [];
  const replies = [];
  const requests = [];
  const status = {
    async edit(payload) {
      statusEdits.push(payload);
    },
  };
  const message = {
    content: [
      'https://www.tiktok.com/@creator/video/7350000000000000000',
      'https://www.instagram.com/p/InstagramPost/',
      'https://twitter.com/creator/status/123456789',
      'https://www.instagram.com/reel/FourthPost/',
    ].join(' '),
    author: { id: 'user-1', bot: false },
    client: { user: { id: 'bot-1' } },
    guildId: 'guild-1',
    channelId: 'channel-1',
    inGuild: () => true,
    async reply(payload) {
      replies.push(payload);
      return replies.length === 1 ? status : {};
    },
  };
  const config = {
    discordUploadLimitBytes: 10,
    downloadLinkTtlMinutes: 30,
    publicBaseUrl: 'https://archive.example',
  };

  const handled = await handleMessageCreate({
    message,
    config,
    downloadOne: async (url, options) => {
      requests.push({ url, options });
      return {
        sourceUrl: url,
        publicUrl: `https://archive.example/files/${requests.length}`,
        title: 'Saved post',
        username: 'creator',
        videoId: String(requests.length),
        sizeBytes: 20,
      };
    },
  });

  assert.equal(handled, true);
  assert.deepEqual(requests.map((request) => request.url), [
    'https://www.tiktok.com/@creator/video/7350000000000000000',
    'https://www.instagram.com/p/InstagramPost/',
    'https://x.com/creator/status/123456789',
  ]);
  assert.deepEqual(requests[0].options, {
    delivery: 'auto',
    type: 'message',
    requestedBy: 'user-1',
    guildId: 'guild-1',
    channelId: 'channel-1',
  });
  assert.equal(replies.length, 4);
  assert.equal(replies[0].embeds[0].data.description, 'Downloading 3 media links...');
  assert.equal(statusEdits.length, 3);
  assert.equal(statusEdits[2].embeds[0].data.description, 'Downloaded 3/3 media links.');
});

test('message ingress ignores spoofed, credentialed, HTTP, and profile URLs', async () => {
  let replies = 0;
  let requests = 0;
  const handled = await handleMessageCreate({
    message: {
      content: [
        'http://www.tiktok.com/@creator/video/7350000000000000000',
        'https://user:password@x.com/creator/status/123456789',
        'https://instagram.com.evil.test/p/AbC/',
        'https://www.instagram.com/creator/',
      ].join(' '),
      author: { id: 'user-1', bot: false },
      client: { user: { id: 'bot-1' } },
      async reply() {
        replies += 1;
      },
    },
    config: {},
    downloadOne: async () => {
      requests += 1;
    },
  });

  assert.equal(handled, false);
  assert.equal(replies, 0);
  assert.equal(requests, 0);
});

test('slash download canonicalizes a supported post before requesting it', async () => {
  const requests = [];
  const edits = [];
  const interaction = {
    commandName: 'download',
    user: { id: 'user-1' },
    guildId: 'guild-1',
    channelId: 'channel-1',
    options: {
      getString(name) {
        if (name === 'url') return 'https://twitter.com/OpenAI/status/123456789?s=20';
        if (name === 'delivery') return 'link';
        return null;
      },
    },
    async deferReply() {},
    async editReply(payload) {
      edits.push(payload);
    },
  };

  await handleInteraction({
    interaction,
    config: {
      discordUploadLimitBytes: 10,
      downloadLinkTtlMinutes: 30,
      publicBaseUrl: 'https://archive.example',
    },
    downloadOne: async (url, options) => {
      requests.push({ url, options });
      return {
        sourceUrl: url,
        publicUrl: 'https://archive.example/files/one',
        title: 'Saved post',
        username: 'openai',
        videoId: '123456789',
        sizeBytes: 20,
      };
    },
  });

  assert.equal(requests[0].url, 'https://x.com/openai/status/123456789');
  assert.equal(requests[0].options.delivery, 'link');
  assert.equal(edits.length, 1);
});

test('slash download retries an entity-too-large file response as the same saved link', async () => {
  const edits = [];
  const interaction = {
    commandName: 'download',
    user: { id: 'user-1' },
    guildId: 'guild-1',
    channelId: 'channel-1',
    options: {
      getString(name) {
        if (name === 'url') return 'https://x.com/openai/status/123456789';
        if (name === 'delivery') return 'auto';
        return null;
      },
    },
    async deferReply() {},
    async editReply(payload) {
      edits.push(payload);
      if (payload.files?.length) {
        throw Object.assign(new Error('Request entity too large'), { code: 40005, status: 413 });
      }
    },
  };

  await handleInteraction({
    interaction,
    config: {
      discordUploadLimitBytes: 10,
      downloadLinkTtlMinutes: 30,
      publicBaseUrl: 'https://archive.example',
    },
    downloadOne: async (url) => ({
      token: 'saved-token',
      sourceUrl: url,
      publicUrl: 'https://archive.example/files/saved-token',
      filePath: '/tmp/post.mp4',
      filename: 'post.mp4',
      username: 'openai',
      videoId: '123456789',
      sizeBytes: 8,
    }),
  });

  assert.deepEqual(edits.map((payload) => payload.files?.length ?? 0), [1, 0]);
  for (const payload of edits) {
    const download = payload.embeds[0].data.fields.find((field) => field.name === 'Download');
    assert.equal(download.value, '[Click](https://archive.example/files/saved-token)');
    assert.deepEqual(
      payload.components[0].components.map((button) => button.data.custom_id),
      ['link:new:saved-token', 'link:extend:saved-token', 'link:permanent:saved-token'],
    );
  }
});

test('message URL delivery retries an entity-too-large status edit as link-only', async () => {
  const edits = [];
  const replies = [];
  const status = {
    async edit(payload) {
      edits.push(payload);
      if (payload.files?.length) {
        throw Object.assign(new Error('Request entity too large'), { code: 40005 });
      }
    },
  };
  const message = {
    content: 'https://www.instagram.com/p/InstagramPost/',
    author: { id: 'user-1', bot: false },
    client: { user: { id: 'bot-1' } },
    guildId: 'guild-1',
    channelId: 'channel-1',
    inGuild: () => true,
    async reply(payload) {
      replies.push(payload);
      return status;
    },
  };

  const handled = await handleMessageCreate({
    message,
    config: {
      discordUploadLimitBytes: 10,
      downloadLinkTtlMinutes: 30,
      publicBaseUrl: 'https://archive.example',
    },
    downloadOne: async (url) => ({
      token: 'message-token',
      sourceUrl: url,
      publicUrl: 'https://archive.example/files/message-token',
      filePath: '/tmp/post.jpg',
      filename: 'post.jpg',
      username: 'creator',
      videoId: 'InstagramPost',
      sizeBytes: 8,
    }),
  });

  assert.equal(handled, true);
  assert.equal(replies.length, 1);
  assert.deepEqual(edits.map((payload) => payload.files?.length ?? 0), [1, 0]);
  const fallback = edits[1];
  assert.equal(
    fallback.embeds[0].data.fields.find((field) => field.name === 'Download').value,
    '[Click](https://archive.example/files/message-token)',
  );
  assert.equal(fallback.components[0].components.length, 3);
});
