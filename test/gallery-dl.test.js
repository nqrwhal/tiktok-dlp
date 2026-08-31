import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureRuntimeDirs, loadConfig } from '../src/config.js';
import { createDownloadService } from '../src/download/service.js';
import { instagramAdapter, parseGalleryDlProbeOutput, xAdapter } from '../src/platforms/index.js';
import { createStore } from '../src/state/store.js';

test('gallery-dl adapters download normalized Instagram carousels and X mixed media', async () => {
  const fixture = await makeFakeGalleryDl();
  const previousSentinel = process.env.GALLERY_DL_SENTINEL_SECRET;
  process.env.GALLERY_DL_SENTINEL_SECRET = 'must-not-reach-extractor';
  try {
    const instagram = await instagramAdapter.download(
      'https://m.instagram.com/reels/AbC/?igsh=tracking',
      fixture.options,
    );
    assert.deepEqual(instagram.post, {
      platform: 'instagram',
      remoteId: 'AbC',
      canonicalUrl: 'https://www.instagram.com/reel/AbC/',
      creator: {
        remoteId: '9007199254740993123',
        handle: 'creator.name',
        displayName: 'Creator Name',
      },
      caption: 'Instagram carousel caption',
      publishedAt: '2026-08-29T12:34:56.000Z',
      mediaType: 'mixed',
      assetCount: 3,
    });
    assert.deepEqual(
      instagram.assets.map((asset) => ({
        position: asset.position,
        remoteId: asset.remoteId,
        kind: asset.kind,
        mimeType: asset.mimeType,
        filename: asset.filename,
        sizeBytes: asset.sizeBytes,
      })),
      [
        { position: 1, remoteId: 'ig-media-1', kind: 'image', mimeType: 'image/jpeg', filename: 'asset_001.jpg', sizeBytes: 7 },
        { position: 2, remoteId: 'ig-media-2', kind: 'video', mimeType: 'video/mp4', filename: 'asset_002.mp4', sizeBytes: 7 },
        { position: 3, remoteId: 'ig-media-3', kind: 'image', mimeType: 'image/jpeg', filename: 'asset_003.jpg', sizeBytes: 7 },
      ],
    );
    assert.equal(instagram.totalSizeBytes, 21);

    const x = await xAdapter.download('https://twitter.com/OpenAI/status/123?s=20', fixture.options);
    assert.equal(x.post.platform, 'x');
    assert.equal(x.post.remoteId, '123');
    assert.equal(x.post.canonicalUrl, 'https://x.com/openai/status/123');
    assert.deepEqual(x.post.creator, {
      remoteId: '9007199254740993999',
      handle: 'openai',
      displayName: 'OpenAI',
    });
    assert.equal(x.post.mediaType, 'mixed');
    assert.deepEqual(x.assets.map((asset) => asset.kind), ['image', 'animated']);
    assert.deepEqual(x.assets.map((asset) => asset.filename), ['asset_001.jpg', 'asset_002.mp4']);

    const invocations = await readInvocationLog(fixture.logPath);
    assert.equal(invocations.length, 4);
    for (const invocation of invocations) {
      assert.equal(invocation.args.includes('--config-ignore'), true);
      assert.equal(invocation.args.includes('--no-input'), true);
      assert.deepEqual(invocation.proxyEnv, {});
      assert.equal(invocation.sentinelSecret, null);
      assert.equal(invocation.discordToken, null);
      assert.equal(invocation.args.at(-2), '--');
      assert.match(invocation.args.at(-1), /^https:\/\/(?:www\.instagram\.com|x\.com)\//);
    }

    const instagramInvocations = invocations.slice(0, 2);
    for (const invocation of instagramInvocations) {
      assert.equal(argumentValue(invocation.args, '--proxy'), 'http://instagram-proxy.test:8080');
      assert.match(invocation.cookies, /ig-session-secret/);
      assert.doesNotMatch(invocation.cookies, /x-session-secret/);
    }
    const xInvocations = invocations.slice(2);
    for (const invocation of xInvocations) {
      assert.equal(argumentValue(invocation.args, '--proxy'), 'socks5://x-proxy.test:1080');
      assert.match(invocation.cookies, /x-session-secret/);
      assert.doesNotMatch(invocation.cookies, /ig-session-secret/);
    }
    assert.equal(instagramInvocations[0].args.includes('--dump-json'), true);
    assert.equal(instagramInvocations[0].args.includes('extractor.instagram.videos=merged'), true);
    assert.equal(instagramInvocations[1].args.includes('--dump-json'), false);
    assert.equal(argumentValue(instagramInvocations[1].args, '--directory'), instagram.outputDir);
    assert.equal(argumentValue(instagramInvocations[1].args, '--filename'), 'asset_{num:03}.{extension}');

    for (const invocation of invocations) {
      const stagedCookies = argumentValue(invocation.args, '--cookies');
      assert.notEqual(stagedCookies, fixture.instagramCookiesFile);
      assert.notEqual(stagedCookies, fixture.xCookiesFile);
      await assert.rejects(stat(stagedCookies), { code: 'ENOENT' });
    }
  } finally {
    if (previousSentinel == null) delete process.env.GALLERY_DL_SENTINEL_SECRET;
    else process.env.GALLERY_DL_SENTINEL_SECRET = previousSentinel;
    await fixture.cleanup();
  }
});

test('Instagram Story downloads require a scoped session and normalize one exact story', async () => {
  const storyUrl = 'https://www.instagram.com/stories/0kviv/3975498055704781626?utm_source=share';
  const withoutCookies = await makeFakeGalleryDl({ withCookies: false });
  try {
    await assert.rejects(
      instagramAdapter.download(storyUrl, withoutCookies.options),
      (error) => error?.kind === 'access_denied' && /INSTAGRAM_COOKIES_FILE/.test(error.message),
    );
    assert.deepEqual(await readInvocationLog(withoutCookies.logPath), []);
  } finally {
    await withoutCookies.cleanup();
  }

  const fixture = await makeFakeGalleryDl();
  try {
    const story = await instagramAdapter.download(storyUrl, fixture.options);
    assert.deepEqual(story.post, {
      platform: 'instagram',
      remoteId: 'story_3975498055704781626',
      canonicalUrl: 'https://www.instagram.com/stories/0kviv/3975498055704781626/',
      creator: {
        remoteId: 'ig-owner-story',
        handle: '0kviv',
        displayName: 'Story Creator',
      },
      caption: '',
      publishedAt: '2026-08-30T12:00:00.000Z',
      mediaType: 'story',
      assetCount: 1,
    });
    assert.deepEqual(story.assets.map((asset) => ({
      remoteId: asset.remoteId,
      kind: asset.kind,
      filename: asset.filename,
    })), [{
      remoteId: '3975498055704781626',
      kind: 'video',
      filename: 'asset_001.mp4',
    }]);
    const invocations = await readInvocationLog(fixture.logPath);
    assert.equal(invocations.length, 2);
    assert.equal(invocations.every((invocation) => invocation.args.at(-1) === story.post.canonicalUrl), true);
    assert.equal(invocations.every((invocation) => /sessionid\tig-session-secret/.test(invocation.cookies)), true);
  } finally {
    await fixture.cleanup();
  }
});

test('gallery-dl enforces probe, filesystem byte, timeout, and abort bounds', async () => {
  const fixture = await makeFakeGalleryDl({ withCookies: false });
  try {
    await assert.rejects(
      instagramAdapter.download('https://www.instagram.com/p/TooMany/', {
        ...fixture.options,
        galleryDlMaxAssets: 2,
      }),
      (error) => error?.kind === 'asset_limit',
    );
    assert.equal((await readInvocationLog(fixture.logPath)).length, 1);

    await writeFile(fixture.logPath, '');
    await assert.rejects(
      instagramAdapter.download('https://www.instagram.com/p/TooBig/', {
        ...fixture.options,
        galleryDlMaxItemBytes: 16,
        galleryDlMaxTotalBytes: 32,
      }),
      (error) => error?.kind === 'item_size_limit',
    );
    const sizeInvocations = await readInvocationLog(fixture.logPath);
    const failedOutputDir = argumentValue(sizeInvocations[1].args, '--directory');
    await assert.rejects(stat(failedOutputDir), { code: 'ENOENT' });

    await assert.rejects(
      instagramAdapter.download('https://www.instagram.com/p/Symlink/', fixture.options),
      (error) => error?.kind === 'unsafe_artifact',
    );

    await assert.rejects(
      instagramAdapter.download('https://www.instagram.com/p/AbC/', {
        ...fixture.options,
        galleryDlMaxTotalBytes: 20,
      }),
      (error) => error?.kind === 'total_size_limit',
    );

    await assert.rejects(
      instagramAdapter.probe('https://www.instagram.com/p/Slow/', {
        ...fixture.options,
        galleryDlTimeoutMs: 25,
      }),
      (error) => error?.kind === 'timeout' && error.retryable === true,
    );

    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      xAdapter.probe('https://x.com/openai/status/123', {
        ...fixture.options,
        signal: controller.signal,
      }),
      (error) => error?.kind === 'aborted',
    );
  } finally {
    await fixture.cleanup();
  }
});

test('gallery-dl rejects profiles, unsafe references, and malformed machine output before download work', async () => {
  assert.equal(instagramAdapter.capabilities.directDownload, true);
  assert.equal(instagramAdapter.capabilities.multiAsset, true);
  assert.throws(() => instagramAdapter.download('https://www.instagram.com/creator/'), /post URL is required/i);
  assert.throws(() => xAdapter.probe('https://x.com/explore'), /post URL is required/i);

  const reference = {
    platform: 'instagram',
    remoteId: 'AbC',
    canonicalUrl: 'https://www.instagram.com/p/AbC/',
  };
  assert.throws(
    () => parseGalleryDlProbeOutput('{not-json', reference),
    (error) => error?.kind === 'invalid_output',
  );
  assert.throws(
    () => parseGalleryDlProbeOutput(JSON.stringify([
      [2, { post_shortcode: 'AbC', count: '1' }],
      [3, 'file:///etc/passwd', { num: '1', extension: 'jpg' }],
    ]), reference),
    (error) => error?.kind === 'invalid_output',
  );
  assert.throws(
    () => parseGalleryDlProbeOutput(JSON.stringify([
      [-1, { error: 'AuthenticationError', message: 'Login required for private post' }],
    ]), reference),
    (error) => error?.kind === 'access_denied',
  );

  const reelWithSkippedAudio = parseGalleryDlProbeOutput(JSON.stringify([
    [2, {
      post_shortcode: 'AbC',
      count: '2',
      username: 'creator',
      description: 'Reel with a separate music asset',
    }],
    [3, 'https://cdninstagram.example/media.mp4', {
      num: '1',
      media_id: 'visual-1',
      type: 'video',
      extension: 'mp4',
    }],
  ]), reference);
  assert.equal(reelWithSkippedAudio.post.assetCount, 1);
  assert.deepEqual(reelWithSkippedAudio.assets.map((asset) => asset.kind), ['video']);
});

test('gallery-dl configuration resolves platform-scoped paths and creates staging', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gallery-dl-config-'));
  try {
    const config = loadConfig({
      DATA_DIR: './runtime',
      GALLERY_DL_PATH: '/opt/bin/gallery-dl',
      GALLERY_DL_TEMP_DIR: './staging',
      GALLERY_DL_TIMEOUT_SECONDS: '45',
      GALLERY_DL_MAX_ASSETS: '8',
      GALLERY_DL_MAX_ITEM_MB: '12',
      GALLERY_DL_MAX_TOTAL_MB: '30',
      INSTAGRAM_COOKIES_FILE: './cookies/instagram.txt',
      INSTAGRAM_PROXY: ' http://ig-proxy.test:8080 ',
      X_COOKIES_FILE: './cookies/x.txt',
      X_PROXY: ' socks5://x-proxy.test:1080 ',
    }, dir);
    assert.equal(config.galleryDlPath, '/opt/bin/gallery-dl');
    assert.equal(config.galleryDlTempDir, path.join(dir, 'staging'));
    assert.equal(config.galleryDlTimeoutMs, 45_000);
    assert.equal(config.galleryDlMaxAssets, 8);
    assert.equal(config.galleryDlMaxItemBytes, 12 * 1024 * 1024);
    assert.equal(config.galleryDlMaxTotalBytes, 30 * 1024 * 1024);
    assert.equal(config.instagramCookiesFile, path.join(dir, 'cookies/instagram.txt'));
    assert.equal(config.instagramProxy, 'http://ig-proxy.test:8080');
    assert.equal(config.xCookiesFile, path.join(dir, 'cookies/x.txt'));
    assert.equal(config.xProxy, 'socks5://x-proxy.test:1080');
    await ensureRuntimeDirs(config);
    assert.equal((await stat(config.galleryDlTempDir)).isDirectory(), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('DownloadService archives a built-in gallery-dl carousel and reuses the stored ZIP', async () => {
  const fixture = await makeFakeGalleryDl({ withCookies: false });
  const store = createStore(path.join(fixture.dir, 'state.db'));
  const downloadDir = path.join(fixture.dir, 'downloads');
  try {
    const service = createDownloadService({
      config: {
        ...fixture.options,
        downloadDir,
        publicBaseUrl: 'https://downloads.example.test',
        downloadLinkTtlMinutes: 30,
        maxConcurrentDownloads: 1,
      },
      store,
    });

    const first = await service.request('https://instagram.com/p/AbC/?igsh=tracking', {
      requestedBy: 'user-a',
    });
    assert.equal(first.platform, 'instagram');
    assert.equal(first.videoId, 'AbC');
    assert.equal(first.username, 'creator.name');
    assert.equal(first.reused, false);
    assert.equal(path.extname(first.filePath), '.zip');
    assert.equal((await readFile(first.filePath)).subarray(0, 2).toString(), 'PK');
    assert.deepEqual(first.assets.map((asset) => asset.position), [1, 2, 3]);
    assert.equal(first.assets.every((asset) => asset.filePath.startsWith(downloadDir)), true);

    const post = store.getMediaPost('instagram', 'AbC');
    assert.equal(post.creator_handle, 'creator.name');
    assert.equal(post.media_type, 'mixed');
    const storedAssets = store.listMediaAssetsForFile(first.fileId);
    assert.deepEqual(storedAssets.map((asset) => asset.role), ['content', 'content', 'content', 'package']);
    assert.equal(store.stats().fileCount, 1);
    assert.equal((await readInvocationLog(fixture.logPath)).length, 2);

    const second = await service.request('https://www.instagram.com/p/AbC/', {
      requestedBy: 'user-b',
    });
    assert.equal(second.reused, true);
    assert.equal(second.fileId, first.fileId);
    assert.equal(second.filePath, first.filePath);
    assert.equal(second.username, 'creator.name');
    assert.equal(second.mediaType, 'mixed');
    assert.equal(second.description, 'Instagram carousel caption');
    assert.equal(second.publishedAt, '2026-08-29T12:34:56.000Z');
    assert.deepEqual(second.assets.map((asset) => asset.position), [1, 2, 3]);
    assert.notEqual(second.token, first.token);
    assert.equal(store.stats().fileCount, 1);
    assert.equal((await readInvocationLog(fixture.logPath)).length, 2);
  } finally {
    store.close();
    await fixture.cleanup();
  }
});

test('DownloadService persists an exact Instagram Story with isolated identity and story media type', async () => {
  const fixture = await makeFakeGalleryDl();
  const store = createStore(path.join(fixture.dir, 'story-state.db'));
  const downloadDir = path.join(fixture.dir, 'story-downloads');
  try {
    const service = createDownloadService({
      config: {
        ...fixture.options,
        downloadDir,
        publicBaseUrl: 'https://downloads.example.test',
        downloadLinkTtlMinutes: 30,
        maxConcurrentDownloads: 1,
      },
      store,
    });
    const result = await service.request(
      'https://www.instagram.com/stories/0kviv/3975498055704781626?igsi=tracking',
      { requestedBy: 'story-user' },
    );
    assert.equal(result.platform, 'instagram');
    assert.equal(result.videoId, 'story_3975498055704781626');
    assert.equal(result.username, '0kviv');
    assert.equal(result.mediaType, 'story');
    assert.equal(path.extname(result.filePath), '.mp4');
    assert.equal(result.assets.length, 1);
    assert.equal(result.assets[0].remoteId, '3975498055704781626');
    const stored = store.getMediaPost('instagram', 'story_3975498055704781626');
    assert.equal(stored.media_type, 'story');
    assert.equal(stored.creator_handle, '0kviv');
    assert.equal(stored.canonical_url, 'https://www.instagram.com/stories/0kviv/3975498055704781626/');
  } finally {
    store.close();
    await fixture.cleanup();
  }
});

async function makeFakeGalleryDl({ withCookies = true } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gallery-dl-adapter-'));
  const executable = path.join(dir, 'fake-gallery-dl.cjs');
  const logPath = path.join(dir, 'invocations.ndjson');
  const instagramCookiesFile = path.join(dir, 'instagram.txt');
  const xCookiesFile = path.join(dir, 'x.txt');
  await mkdir(path.join(dir, 'staging'), { recursive: true });
  await writeFile(logPath, '');
  await writeFile(instagramCookiesFile, [
    '# Netscape HTTP Cookie File',
    '.instagram.com\tTRUE\t/\tTRUE\t0\tsessionid\tig-session-secret',
    '.x.com\tTRUE\t/\tTRUE\t0\tauth_token\tx-session-secret',
    '',
  ].join('\n'));
  await writeFile(xCookiesFile, [
    '# Netscape HTTP Cookie File',
    '.x.com\tTRUE\t/\tTRUE\t0\tauth_token\tx-session-secret',
    '.instagram.com\tTRUE\t/\tTRUE\t0\tsessionid\tig-session-secret',
    '',
  ].join('\n'));
  await writeFile(executable, fakeGalleryDlSource(logPath));
  await chmod(executable, 0o755);

  return {
    dir,
    logPath,
    instagramCookiesFile,
    xCookiesFile,
    options: {
      galleryDlPath: executable,
      galleryDlTempDir: path.join(dir, 'staging'),
      galleryDlTimeoutMs: 2_000,
      galleryDlMaxAssets: 20,
      galleryDlMaxItemBytes: 1_024,
      galleryDlMaxTotalBytes: 4_096,
      ...(withCookies ? {
        instagramCookiesFile,
        instagramProxy: 'http://instagram-proxy.test:8080',
        xCookiesFile,
        xProxy: 'socks5://x-proxy.test:1080',
      } : {}),
    },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

function fakeGalleryDlSource(logPath) {
  return `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const value = (flag) => { const index = args.indexOf(flag); return index < 0 ? '' : args[index + 1]; };
const cookiesPath = value('--cookies');
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({
  args,
  cookies: cookiesPath && fs.existsSync(cookiesPath) ? fs.readFileSync(cookiesPath, 'utf8') : '',
  proxyEnv: Object.fromEntries(['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']
    .filter((name) => process.env[name])
    .map((name) => [name, process.env[name]])),
  sentinelSecret: process.env.GALLERY_DL_SENTINEL_SECRET || null,
  discordToken: process.env.DISCORD_TOKEN || null,
}) + '\\n');
const url = args[args.length - 1];
if (args.includes('--dump-json')) {
  if (url.includes('/Slow/')) {
    setTimeout(() => {}, 10_000);
  } else {
    process.stdout.write(JSON.stringify(probe(url)));
  }
} else {
  const outputDir = value('--directory');
  fs.mkdirSync(outputDir, { recursive: true });
  if (url.includes('/TooBig/')) {
    fs.writeFileSync(path.join(outputDir, 'asset_001.jpg'), Buffer.alloc(64));
  } else if (url.includes('/Symlink/')) {
    const outside = path.join(outputDir, '..', 'outside-media.jpg');
    fs.writeFileSync(outside, 'outside');
    fs.symlinkSync(outside, path.join(outputDir, 'asset_001.jpg'));
  } else {
    const extensions = url.includes('/stories/')
      ? ['mp4']
      : url.includes('instagram.com') ? ['jpg', 'mp4', 'jpg'] : ['jpg', 'mp4'];
    for (let index = 0; index < extensions.length; index += 1) {
      fs.writeFileSync(path.join(outputDir, 'asset_' + String(index + 1).padStart(3, '0') + '.' + extensions[index]), 'asset-' + (index + 1));
    }
  }
}

function probe(url) {
  if (url.includes('/TooMany/')) return instagram('TooMany', 3);
  if (url.includes('/TooBig/')) return instagram('TooBig', 1);
  if (url.includes('/Symlink/')) return instagram('Symlink', 1);
  if (url.includes('/stories/')) return instagramStory(url);
  if (url.includes('instagram.com')) return instagram('AbC', 3);
  return [
    [2, {
      tweet_id: '123', count: '2', content: 'X mixed-media caption', date: '2026-08-30T01:02:03+00:00',
      author: { id: '9007199254740993999', name: 'openai', nick: 'OpenAI' },
    }],
    [3, 'https://pbs.example.test/one.jpg', { num: '1', media_id: 'x-media-1', type: 'photo', extension: 'jpg', width: '1200', height: '900' }],
    [3, 'https://video.example.test/two.mp4', { num: '2', media_id: 'x-media-2', type: 'animated_gif', extension: 'mp4', width: '640', height: '480', duration: '2.5' }],
  ];
}

function instagramStory(url) {
  const match = url.match(/\\/stories\\/([^/]+)\\/(\\d+)/);
  const storyId = match && match[2] || '3975498055704781626';
  return [
    [2, {
      post_id: storyId, count: '1', type: 'story', username: match && match[1] || '0kviv',
      owner_id: 'ig-owner-story', fullname: 'Story Creator', date: '2026-08-30T12:00:00+00:00',
    }],
    [3, 'https://cdn.example.test/story.mp4', {
      num: '1', media_id: storyId, type: 'video', extension: 'mp4', width: '1080', height: '1920', duration: '9.5',
    }],
  ];
}

function instagram(shortcode, count) {
  const messages = [[2, {
    post_shortcode: shortcode, post_id: '9007199254740993555', count: String(count),
    username: 'creator.name', owner_id: '9007199254740993123', fullname: 'Creator Name',
    description: 'Instagram carousel caption', date: '2026-08-29T12:34:56+00:00',
  }]];
  const extensions = ['jpg', 'mp4', 'jpg'];
  for (let index = 0; index < count; index += 1) {
    const position = index + 1;
    messages.push([3, 'https://cdn.example.test/' + position + '.' + extensions[index], {
      num: String(position), media_id: 'ig-media-' + position,
      type: extensions[index] === 'mp4' ? 'video' : 'image', extension: extensions[index],
      width: '1080', height: '1350', duration: extensions[index] === 'mp4' ? '4.5' : '0',
    }]);
  }
  return messages;
}
`;
}

async function readInvocationLog(logPath) {
  const text = await readFile(logPath, 'utf8');
  return text.trim() ? text.trim().split('\n').map((line) => JSON.parse(line)) : [];
}

function argumentValue(args, flag) {
  const index = args.indexOf(flag);
  return index < 0 ? '' : args[index + 1];
}
