import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertSupportedPlatformUrl,
  canonicalizePlatformUrl,
  createPlatformRegistry,
  createPostReference,
  createProfileReference,
  detectPlatform,
  detectPlatformUrl,
  extractSupportedPlatformUrls,
  getPlatformAdapter,
  isSupportedPlatformUrl,
  parsePostReference,
  parseProfileReference,
  postReferenceKey,
  profileReferenceKey,
} from '../src/platforms/index.js';

test('platform detection accepts exact HTTPS hosts and rejects unsafe lookalikes', () => {
  assert.equal(detectPlatform('https://www.tiktok.com/@creator/video/123'), 'tiktok');
  assert.equal(detectPlatform('https://m.instagram.com/p/Ab_C-1/'), 'instagram');
  assert.equal(detectPlatform('https://twitter.com/creator/status/123'), 'x');
  assert.equal(detectPlatform('https://mobile.x.com/creator/status/123'), 'x');

  for (const value of [
    'http://www.instagram.com/p/Ab_C-1/',
    'https://user:password@x.com/creator/status/123',
    'https://www.tiktok.com.evil.test/@creator/video/123',
    'https://instagram.com@evil.test/p/Ab_C-1/',
    'https://x.com:444/creator/status/123',
    'https://t.co/example',
    'not a URL',
  ]) {
    assert.equal(isSupportedPlatformUrl(value), false, value);
    assert.equal(detectPlatformUrl(value), null, value);
    assert.throws(() => assertSupportedPlatformUrl(value), /credential-free HTTPS/i);
  }
});

test('known post URLs canonicalize and produce platform-scoped references', () => {
  assert.deepEqual(
    parsePostReference('https://m.tiktok.com/@Creator/photo/7350000000000000000?share=1#media'),
    {
      kind: 'post',
      platform: 'tiktok',
      remoteId: '7350000000000000000',
      creatorHandle: 'creator',
      canonicalUrl: 'https://www.tiktok.com/@creator/photo/7350000000000000000',
    },
  );
  assert.deepEqual(
    parsePostReference('https://instagram.com/reels/Ab_C-1/?igsh=tracking'),
    {
      kind: 'post',
      platform: 'instagram',
      remoteId: 'Ab_C-1',
      creatorHandle: null,
      canonicalUrl: 'https://www.instagram.com/reel/Ab_C-1/',
    },
  );
  assert.deepEqual(
    parsePostReference('https://www.instagram.com/stories/0kViv/3975498055704781626?utm_source=share&igsi=token'),
    {
      kind: 'post',
      platform: 'instagram',
      remoteId: 'story_3975498055704781626',
      creatorHandle: '0kviv',
      canonicalUrl: 'https://www.instagram.com/stories/0kviv/3975498055704781626/',
    },
  );
  assert.deepEqual(
    parsePostReference('https://www.twitter.com/OpenAI/status/123456789/photo/1?s=20'),
    {
      kind: 'post',
      platform: 'x',
      remoteId: '123456789',
      creatorHandle: 'openai',
      canonicalUrl: 'https://x.com/openai/status/123456789',
    },
  );
  assert.equal(
    canonicalizePlatformUrl('https://twitter.com/OpenAI/status/123456789?s=20#fragment'),
    'https://x.com/openai/status/123456789',
  );
  assert.equal(parsePostReference('https://www.instagram.com/explore/'), null);
  assert.equal(parsePostReference('https://www.instagram.com/stories/0kviv/'), null);
});

test('profile references are normalized for explicit cross-platform linking', () => {
  assert.deepEqual(parseProfileReference('https://www.tiktok.com/@Creator/'), {
    kind: 'profile',
    platform: 'tiktok',
    remoteId: null,
    handle: 'creator',
    canonicalUrl: 'https://www.tiktok.com/@creator',
  });
  assert.deepEqual(parseProfileReference('https://m.instagram.com/Creator.Name/?utm_source=share'), {
    kind: 'profile',
    platform: 'instagram',
    remoteId: null,
    handle: 'creator.name',
    canonicalUrl: 'https://www.instagram.com/creator.name/',
  });
  assert.deepEqual(parseProfileReference('https://twitter.com/Creator_Name'), {
    kind: 'profile',
    platform: 'x',
    remoteId: null,
    handle: 'creator_name',
    canonicalUrl: 'https://x.com/creator_name',
  });
  assert.equal(parseProfileReference('https://x.com/explore'), null);

  assert.equal(
    profileReferenceKey(createProfileReference({ platform: 'twitter', handle: '@Creator_Name' })),
    'x:profile:handle:creator_name',
  );
  assert.equal(
    profileReferenceKey(createProfileReference({ platform: 'instagram', handle: 'creator', remoteId: '9988' })),
    'instagram:profile:id:9988',
  );
});

test('post identity keys cannot collide across platforms', () => {
  const tiktok = createPostReference({ platform: 'tiktok', remoteId: '123' });
  const x = createPostReference({ platform: 'twitter', remotePostId: '123' });
  assert.equal(postReferenceKey(tiktok), 'tiktok:post:123');
  assert.equal(postReferenceKey(x), 'x:post:123');
  assert.notEqual(postReferenceKey(tiktok), postReferenceKey(x));
  assert.equal(
    postReferenceKey(createPostReference({ platform: 'instagram', remoteId: 'story_3975498055704781626' })),
    'instagram:post:story_3975498055704781626',
  );
  assert.throws(
    () => createPostReference({ platform: 'instagram', remoteId: '../bad' }),
    /Invalid instagram post ID/,
  );
});

test('generic and extracted URLs are canonical, credential-free, and deduplicated', () => {
  assert.equal(
    canonicalizePlatformUrl('https://vm.tiktok.com/ZMshort/?utm_source=copy#fragment'),
    'https://vm.tiktok.com/ZMshort/',
  );
  assert.deepEqual(
    extractSupportedPlatformUrls([
      'first https://twitter.com/OpenAI/status/123?s=20,',
      'duplicate https://x.com/openai/status/123',
      'then https://instagram.com/p/AbC/?igsh=one.',
      'ignore https://example.test/nope',
    ].join(' ')),
    [
      'https://x.com/openai/status/123',
      'https://www.instagram.com/p/AbC/',
    ],
  );
});

test('adapter registry rejects duplicate platforms and host ownership', () => {
  const probe = async () => ({ remoteId: '123' });
  const adapter = {
    platform: 'x',
    displayName: 'Example X',
    hosts: ['example.test'],
    canonicalHost: 'example.test',
    capabilities: { directDownload: true },
    canonicalizeUrl: (url) => url.href,
    parsePostReference: () => null,
    parseProfileReference: () => null,
    probe,
  };
  const registry = createPlatformRegistry([adapter]);
  assert.equal(registry.get('twitter')?.platform, 'x');
  assert.equal(registry.get('x')?.capabilities.directDownload, true);
  assert.equal(registry.get('x')?.probe, probe);
  assert.equal(registry.get('x')?.download, null);
  assert.equal(registry.forUrl('https://example.test/path')?.adapter.platform, 'x');
  assert.throws(() => createPlatformRegistry([adapter, adapter]), /Duplicate platform adapter/);
});

test('the TikTok adapter owns direct-save, creator, story, and availability operations', async () => {
  const adapter = getPlatformAdapter('tiktok');
  assert.equal(adapter.capabilities.directDownload, true);
  assert.equal(adapter.capabilities.probeBeforeDownload, true);
  assert.equal(adapter.capabilities.preferRequestedCreatorHandle, true);
  for (const operation of [
    'probe',
    'download',
    'listCreatorPosts',
    'listCreatorStories',
    'checkAvailability',
  ]) {
    assert.equal(typeof adapter[operation], 'function', operation);
  }

  assert.throws(
    () => adapter.probe('https://www.tiktok.com/@creator'),
    /TikTok post URL or TikTok short link/,
  );
  assert.throws(
    () => adapter.download('https://www.tiktok.com/@creator'),
    /TikTok post URL or TikTok short link/,
  );
  await assert.rejects(
    adapter.checkAvailability('https://www.tiktok.com/@creator'),
    /TikTok post URL or TikTok short link/,
  );
});
