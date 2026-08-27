import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { parseTikTokPostRef, resolvePhotoPost } from '../src/tiktok/photoResolver.js';
import { fetchPhotoPostMetadata } from '../src/tiktok/ytdlp.js';

const AWEME_ID = '7636317293982649631';
const VIDEO_URL = `https://www.tiktok.com/@kaybug425/video/${AWEME_ID}`;
const PHOTO_URL = `https://www.tiktok.com/@kaybug425/photo/${AWEME_ID}`;

function makeItemStruct({
  id = AWEME_ID,
  desc = 'follower-only slideshow',
  createTime = '1777968743',
  username = 'kaybug425',
  images = [
    { imageURL: { urlList: ['https://cdn.example.test/one.jpeg'] }, imageWidth: 1440, imageHeight: 1080 },
    { imageURL: { urlList: ['https://cdn.example.test/two.jpeg'] }, imageWidth: 720, imageHeight: 540 },
  ],
  music = { duration: 28, playUrl: { urlList: ['https://cdn.example.test/audio.mp3'] } },
  cover = { urlList: ['https://cdn.example.test/cover.webp'] },
} = {}) {
  return {
    id,
    desc,
    createTime,
    author: { uniqueId: username, nickname: 'Kay' },
    video: { duration: 0, cover, originCover: cover },
    music,
    ...(images ? { imagePost: { images } } : {}),
  };
}

function rehydrationHtml(item, { scope = 'webapp.video-detail', statusCode = 0 } = {}) {
  const data = {
    __DEFAULT_SCOPE__: {
      [scope]: statusCode === 0
        ? { itemInfo: { itemStruct: item } }
        : { statusCode, statusMsg: "Someone's post" },
    },
  };
  return `<html><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify(data)}</script></html>`;
}

function textResponse(body, url, contentType = 'text/html') {
  return {
    ok: true,
    status: 200,
    url,
    headers: { get: (name) => (name === 'content-type' ? contentType : null) },
    text: async () => body,
  };
}

function emptyResponse(url) {
  return textResponse('', url);
}

function headerValue(headers, name) {
  const key = Object.keys(headers ?? {}).find((candidate) => candidate.toLowerCase() === name);
  return key ? headers[key] : '';
}

async function makeCookiesFile() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tiktok-photo-resolver-'));
  const cookiesFile = path.join(dir, 'tiktok.txt');
  await writeFile(cookiesFile, [
    '# Netscape HTTP Cookie File',
    '.tiktok.com\tTRUE\t/\tTRUE\t2147483647\tsessionid\ttest-session',
    '.tiktok.com\tTRUE\t/\tTRUE\t2147483647\tsid_tt\ttest-sid',
  ].join('\n'));
  return { dir, cookiesFile };
}

test('parseTikTokPostRef extracts username and aweme id from post URLs', () => {
  assert.deepEqual(parseTikTokPostRef(VIDEO_URL), { username: 'kaybug425', awemeId: AWEME_ID });
  assert.deepEqual(parseTikTokPostRef(PHOTO_URL), { username: 'kaybug425', awemeId: AWEME_ID });
  assert.deepEqual(
    parseTikTokPostRef('https://www.tiktok.com/@Some.User/video/1234567890123456789?q=1'),
    { username: 'some.user', awemeId: '1234567890123456789' },
  );
  assert.deepEqual(parseTikTokPostRef('7636317293982649631'), { username: '', awemeId: AWEME_ID });
  assert.deepEqual(parseTikTokPostRef('https://www.tiktok.com/t/ZP8vHhs9r/'), { username: '', awemeId: '' });
});

test('resolvePhotoPost uses the authenticated desktop video page before other transports', async () => {
  const { dir, cookiesFile } = await makeCookiesFile();
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return textResponse(rehydrationHtml(makeItemStruct()), String(url));
  };

  try {
    const result = await resolvePhotoPost(
      { url: PHOTO_URL },
      { cookiesFile, proxy: 'http://proxy.test:8888', fetchImpl },
    );

    assert.equal(result.ok, true);
    assert.equal(result.awemeId, AWEME_ID);
    assert.equal(result.username, 'kaybug425');
    assert.equal(result.description, 'follower-only slideshow');
    assert.equal(result.createTime, 1777968743);
    assert.equal(result.durationSeconds, 28);
    assert.equal(result.mediaType, 'slideshow');
    assert.equal(result.audioUrl, 'https://cdn.example.test/audio.mp3');
    assert.equal(result.coverUrl, 'https://cdn.example.test/cover.webp');
    assert.deepEqual(
      result.images.map((image) => ({ index: image.index, url: image.url, width: image.width, height: image.height })),
      [
        { index: 1, url: 'https://cdn.example.test/one.jpeg', width: 1440, height: 1080 },
        { index: 2, url: 'https://cdn.example.test/two.jpeg', width: 720, height: 540 },
      ],
    );
    assert.equal(headerValue(result.images[0].headers, 'referer'), 'https://www.tiktok.com/');

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `https://www.tiktok.com/@kaybug425/video/${AWEME_ID}`);
    assert.match(headerValue(calls[0].init.headers, 'user-agent'), /Windows NT 10.0/);
    assert.match(headerValue(calls[0].init.headers, 'cookie'), /sessionid=test-session/);
    assert.ok(calls[0].init.dispatcher);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolvePhotoPost falls back to the unsigned item detail API when the page has no item', async () => {
  const { dir, cookiesFile } = await makeCookiesFile();
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const textUrl = String(url);
    calls.push({ url: textUrl, init });
    if (textUrl.startsWith('https://www.tiktok.com/@')) return emptyResponse(textUrl);
    if (textUrl.includes('/api/item/detail/')) {
      assert.equal(new URL(textUrl).searchParams.get('itemId'), AWEME_ID);
      return textResponse(JSON.stringify({ statusCode: 0, itemInfo: { itemStruct: makeItemStruct() } }), textUrl, 'application/json');
    }
    return emptyResponse(textUrl);
  };

  try {
    const result = await resolvePhotoPost({ url: PHOTO_URL }, { cookiesFile, fetchImpl });
    assert.equal(result.ok, true);
    assert.equal(result.images.length, 2);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].url.startsWith('https://www.tiktok.com/api/item/detail/'), true);
    assert.ok(headerValue(calls[1].init.headers, 'referer').includes(`/video/${AWEME_ID}`));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolvePhotoPost falls back to the source page with a mobile UA as the final transport', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const textUrl = String(url);
    calls.push({ url: textUrl, init });
    if (textUrl.includes('/video/') || textUrl.includes('/api/item/detail/')) {
      return emptyResponse(textUrl);
    }
    return textResponse(rehydrationHtml(makeItemStruct(), { scope: 'webapp.reflow.video.detail' }), textUrl);
  };

  const result = await resolvePhotoPost({ url: PHOTO_URL }, { fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 3);
  assert.match(headerValue(calls[2].init.headers, 'user-agent'), /iPhone/);
  assert.equal(calls[2].url, PHOTO_URL);
});

test('resolvePhotoPost resolves an aweme id without a username via the video page', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return textResponse(rehydrationHtml(makeItemStruct()), String(url));
  };

  const result = await resolvePhotoPost({ awemeId: AWEME_ID }, { fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.username, 'kaybug425');
  assert.equal(result.images.length, 2);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://www.tiktok.com/@_/video/${AWEME_ID}`);
});

test('resolvePhotoPost reports no_images when the item exists without a carousel', async () => {
  const item = makeItemStruct();
  delete item.imagePost;
  const fetchImpl = async (url) => textResponse(
    JSON.stringify({ statusCode: 0, itemInfo: { itemStruct: item } }),
    String(url),
    'application/json',
  );

  const result = await resolvePhotoPost({ awemeId: AWEME_ID, username: 'kaybug425' }, { fetchImpl });
  assert.deepEqual(result, {
    ok: false,
    error: 'no_images',
    message: 'The post resolved but did not include downloadable images.',
  });
});

test('resolvePhotoPost maps permission denials to no_access', async () => {
  const fetchImpl = async (url) => textResponse(
    JSON.stringify({ statusCode: 10221 }),
    String(url),
    'application/json',
  );
  const result = await resolvePhotoPost({ awemeId: AWEME_ID, username: 'kaybug425' }, { fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'no_access');
});

test('resolvePhotoPost returns not_found when no transport yields the item', async () => {
  const fetchImpl = async (url) => emptyResponse(String(url));
  const result = await resolvePhotoPost({ url: PHOTO_URL }, { fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'not_found');
});

test('resolvePhotoPost rejects missing input and propagates fatal fetch errors', async () => {
  assert.deepEqual(
    await resolvePhotoPost({}, { fetchImpl: async () => emptyResponse('') }),
    { ok: false, error: 'invalid_input', message: 'A TikTok post URL or aweme id is required.' },
  );

  const oversized = Buffer.from('<html>too large</html>');
  await assert.rejects(
    resolvePhotoPost(
      { url: 'https://www.tiktok.com/t/ZP8vHhs9r/' },
      {
        maxPhotoMetadataBytes: 8,
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          url: 'https://www.tiktok.com/t/ZP8vHhs9r/',
          headers: { get: () => null },
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(oversized.subarray(0, 8));
              controller.enqueue(oversized.subarray(8));
              controller.close();
            },
          }),
        }),
      },
    ),
    (error) => error?.kind === 'media_size_limit',
  );
});

test('fetchPhotoPostMetadata maps the resolver contract onto slideshow metadata', async () => {
  const fetchImpl = async (url) => textResponse(rehydrationHtml(makeItemStruct()), String(url));
  const metadata = await fetchPhotoPostMetadata(PHOTO_URL, { fetchImpl });

  assert.equal(metadata.id, AWEME_ID);
  assert.equal(metadata.uploader, 'kaybug425');
  assert.equal(metadata.channel, 'kaybug425');
  assert.equal(metadata.title, 'follower-only slideshow');
  assert.equal(metadata.timestamp, 1777968743);
  assert.equal(metadata.duration, 28);
  assert.equal(metadata.mediaType, 'slideshow');
  assert.equal(metadata.imageCount, 2);
  assert.deepEqual(metadata.imageUrls, ['https://cdn.example.test/one.jpeg', 'https://cdn.example.test/two.jpeg']);
  assert.deepEqual(metadata.imagePost.images[0].imageURL.urlList, ['https://cdn.example.test/one.jpeg']);
  assert.equal(metadata.thumbnail, 'https://cdn.example.test/cover.webp');
  assert.equal(metadata.audioUrl, 'https://cdn.example.test/audio.mp3');

  const failing = async (fetcher, expectedKind) => {
    await assert.rejects(
      fetchPhotoPostMetadata(PHOTO_URL, { fetchImpl: fetcher }),
      (error) => error.kind === expectedKind,
    );
  };
  await failing(async (url) => emptyResponse(String(url)), 'photo_metadata_not_found');
  const videoItem = makeItemStruct();
  delete videoItem.imagePost;
  await failing(
    async (url) => textResponse(rehydrationHtml(videoItem), String(url)),
    'photo_images_not_found',
  );
});
