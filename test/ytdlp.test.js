import { mkdtemp, chmod, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  buildDownloadArgs,
  buildMetadataArgs,
  classifyYtdlpError,
  downloadVideo,
  fetchPhotoPostMetadata,
  fetchVideoMetadata,
  listProfileStories,
  listProfileVideos,
  parsePhotoPostMetadata,
} from '../src/tiktok/ytdlp.js';

const TEST_SEC_UID = `MS4wLjABAAAA${'a'.repeat(64)}`;

test('buildMetadataArgs builds a conservative metadata command', () => {
  const args = buildMetadataArgs('https://www.tiktok.com/@user/video/123', {
    cookiesFile: '/tmp/cookies.txt',
    extraArgs: ['--extractor-args', 'tiktok:foo=bar'],
  });

  assert.deepStrictEqual(args, [
    '--ignore-config',
    '--no-warnings',
    '--no-progress',
    '--quiet',
    '--socket-timeout',
    '20',
    '--skip-download',
    '--dump-single-json',
    '--no-playlist',
    '--cookies',
    '/tmp/cookies.txt',
    '--extractor-args',
    'tiktok:foo=bar',
    'https://www.tiktok.com/@user/video/123',
  ]);

  const playlistArgs = buildMetadataArgs('https://www.tiktok.com/@user', {
    flatPlaylist: true,
    limit: 7,
  });
  assert.deepStrictEqual(playlistArgs.slice(-3), ['--playlist-end', '7', 'https://www.tiktok.com/@user']);
});

test('buildDownloadArgs points yt-dlp at explicit output dirs', () => {
  const args = buildDownloadArgs('https://www.tiktok.com/@user/video/123', {
    outputDir: '/tmp/out',
    cookiesFile: '/tmp/cookies.txt',
    format: 'bv*+ba/b',
    extraArgs: ['--print', 'after_move:filepath'],
  });

  assert.deepStrictEqual(args, [
    '--ignore-config',
    '--no-warnings',
    '--no-progress',
    '--quiet',
    '--newline',
    '--retries',
    '3',
    '--fragment-retries',
    '3',
    '--extractor-retries',
    '3',
    '--retry-sleep',
    'exp=1:30',
    '--socket-timeout',
    '20',
    '--no-playlist',
    '--format',
    'bv*+ba/b',
    '--restrict-filenames',
    '--merge-output-format',
    'mp4',
    '--write-info-json',
    '--write-thumbnail',
    '--write-description',
    '--output',
    '%(id)s.%(ext)s',
    '--paths',
    'home:/tmp/out',
    '--paths',
    'temp:/tmp/out',
    '--cookies',
    '/tmp/cookies.txt',
    '--print',
    'after_move:filepath',
    'https://www.tiktok.com/@user/video/123',
  ]);
});

test('classifyYtdlpError maps common yt-dlp failures', () => {
  assert.equal(classifyYtdlpError({ code: 'ENOENT' }).kind, 'not_installed');
  assert.equal(classifyYtdlpError(new Error('Video unavailable')).kind, 'not_found');
  assert.equal(classifyYtdlpError(new Error('Sign in to confirm your age')).kind, 'auth_required');
});

test('fetchVideoMetadata, listProfileVideos, and downloadVideo work with a fake executable', async () => {
  const fake = await createFakeYtDlp();
  const url = 'https://www.tiktok.com/@creator/video/9876543210';

  const metadata = await fetchVideoMetadata(url, { ytdlpPath: fake });
  assert.equal(metadata.id, '9876543210');
  assert.equal(metadata.title, 'A video');
  assert.equal(metadata.uploader, 'creator');

  const profile = await listProfileVideos('https://www.tiktok.com/@creator', { ytdlpPath: fake });
  assert.equal(profile.count, 2);
  assert.equal(profile.entries[0].videoId, '111');
  assert.equal(profile.entries[1].title, 'Second');

  const cachedProfile = await listProfileVideos('https://www.tiktok.com/@creator', {
    ytdlpPath: fake,
    username: 'creator',
    watch: { sec_uid: TEST_SEC_UID },
  });
  assert.equal(cachedProfile.sourceUrl, `tiktokuser:${TEST_SEC_UID}`);
  assert.equal(cachedProfile.metadata.channel_id, TEST_SEC_UID);

  const storyFetch = createStoryFetch();
  const stories = await listProfileStories('creator', { fetchImpl: storyFetch, limit: 2 });
  assert.equal(stories.count, 1);
  assert.equal(stories.entries[0].mediaType, 'story');
  assert.equal(stories.entries[0].url, 'https://www.tiktok.com/@creator/story/3333333333');
  assert.equal(stories.entries[0].directVideoUrl, 'https://cdn.example.test/story.mp4');
  assert.equal(stories.entries[0].duration, 12);

  const cachedStoryFetch = createStoryFetch();
  const cachedStories = await listProfileStories('creator', {
    fetchImpl: cachedStoryFetch,
    limit: 2,
    username: 'creator',
    watch: { author_id: '424242424242', sec_uid: TEST_SEC_UID },
  });
  assert.equal(cachedStories.count, 1);
  assert.equal(cachedStoryFetch.profileRequests, 0);

  const storyRoot = await mkdtemp(path.join(os.tmpdir(), 'tiktok-story-downloads-'));
  const storyDownload = await downloadVideo(stories.entries[0].url, {
    fetchImpl: storyFetch,
    metadata: stories.entries[0],
    downloadDir: storyRoot,
  });
  assert.equal(storyDownload.mediaType, 'story');
  assert.equal(storyDownload.filename, '3333333333.mp4');
  assert.equal(storyDownload.duration, 12);
  assert.ok(storyDownload.primaryFile.startsWith(storyRoot));
  assert.equal((await readFile(storyDownload.primaryFile)).toString(), 'fake story video');

  const download = await downloadVideo(url, { ytdlpPath: fake });
  assert.equal(download.metadata.id, '9876543210');
  assert.equal(download.files.length, 1);
  assert.equal(path.basename(download.primaryFile), 'downloaded.mp4');
  assert.ok(download.downloadDir.startsWith(os.tmpdir()));

  const finalRoot = await mkdtemp(path.join(os.tmpdir(), 'tiktok-downloads-'));
  const movedDownload = await downloadVideo(url, { ytdlpPath: fake, downloadDir: finalRoot });
  assert.equal(movedDownload.files.length, 1);
  assert.equal(path.basename(movedDownload.primaryFile), 'downloaded.mp4');
  assert.ok(movedDownload.primaryFile.startsWith(finalRoot));
  assert.equal(path.relative(finalRoot, movedDownload.primaryFile).startsWith('.tmp'), false);
});

test('photo post fallback parses and packages slideshow images', async () => {
  const fake = await createUnsupportedYtDlp();
  const fetchImpl = createPhotoFetch();
  const url = 'https://www.tiktok.com/t/ZP8GUpGWj/';

  const metadata = await fetchVideoMetadata(url, { ytdlpPath: fake, fetchImpl });
  assert.equal(metadata.id, '7640994586499878174');
  assert.equal(metadata.uploader, 'user400567892112');
  assert.equal(metadata.mediaType, 'slideshow');
  assert.equal(metadata.imageCount, 2);

  const finalRoot = await mkdtemp(path.join(os.tmpdir(), 'tiktok-photo-downloads-'));
  const download = await downloadVideo(url, { ytdlpPath: fake, fetchImpl, downloadDir: finalRoot });
  assert.equal(download.mediaType, 'slideshow');
  assert.equal(download.imageCount, 2);
  assert.equal(download.filename, '20260517T224146Z__user400567892112__7640994586499878174.zip');
  assert.equal(path.extname(download.primaryFile), '.zip');
  assert.ok(download.primaryFile.startsWith(finalRoot));

  const archive = await readFile(download.primaryFile);
  assert.equal(archive.subarray(0, 4).toString('hex'), '504b0304');
  assert.ok(archive.includes(Buffer.from('001.jpg')));
  assert.ok(archive.includes(Buffer.from('002.jpg')));
  assert.ok(archive.includes(Buffer.from('manifest.json')));

  const galleryRoot = await mkdtemp(path.join(os.tmpdir(), 'tiktok-photo-gallery-downloads-'));
  const galleryDownload = await downloadVideo(url, {
    ytdlpPath: fake,
    fetchImpl,
    downloadDir: galleryRoot,
    keepSlideshowImages: true,
  });
  assert.deepEqual(
    galleryDownload.slideshowImagePaths.map((filePath) => path.basename(filePath)),
    [
      '20260517T224146Z__user400567892112__7640994586499878174__001.jpg',
      '20260517T224146Z__user400567892112__7640994586499878174__002.jpg',
    ],
  );
});

test('downloadVideo rejects successful yt-dlp runs that only leave non-video artifacts', async () => {
  const fake = await createArtifactOnlyYtDlp();
  const root = await mkdtemp(path.join(os.tmpdir(), 'tiktok-incomplete-download-'));
  const sourceUrl = 'https://www.tiktok.com/@creator/video/9876543210';

  await assert.rejects(
    downloadVideo(sourceUrl, {
      ytdlpPath: fake,
      downloadDir: root,
      disablePhotoFallback: true,
      metadata: {
        id: '9876543210',
        uploader: 'creator',
        webpage_url: sourceUrl,
      },
    }),
    (error) => {
      assert.equal(error.kind, 'no_video_file');
      assert.deepEqual(error.files.sort(), [
        '9876543210.description',
        '9876543210.info.json',
        '9876543210.jpg',
        '9876543210.m4a',
      ]);
      return true;
    },
  );

  assert.deepEqual(await readdir(path.join(root, '.tmp')), []);
});

test('downloadVideo converts artifact-only photo posts through the slideshow fallback', async () => {
  const fake = await createArtifactOnlyYtDlp();
  const root = await mkdtemp(path.join(os.tmpdir(), 'tiktok-artifact-photo-fallback-'));
  const sourceUrl = 'https://www.tiktok.com/t/ZP8GUpGWj/';

  const result = await downloadVideo(sourceUrl, {
    ytdlpPath: fake,
    fetchImpl: createPhotoFetch(),
    downloadDir: root,
    metadata: {
      id: '7640994586499878174',
      uploader: 'user400567892112',
      webpage_url: sourceUrl,
    },
  });

  assert.equal(result.mediaType, 'slideshow');
  assert.equal(path.extname(result.primaryFile), '.zip');
  assert.ok((await readFile(result.primaryFile)).includes(Buffer.from('manifest.json')));
});

test('slideshow fallback streams image bodies and rejects configured size/count limits', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tiktok-photo-limits-'));
  const metadata = {
    id: 'streamed-photo',
    title: 'streamed photo',
    uploader: 'creator',
    mediaType: 'slideshow',
    imageUrls: ['https://cdn.example.test/streamed.jpg'],
  };
  const image = Buffer.from('streamed image bytes');
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    url: 'https://cdn.example.test/streamed.jpg',
    headers: { get: (name) => name === 'content-type' ? 'image/jpeg' : null },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(image.subarray(0, 6));
        controller.enqueue(image.subarray(6));
        controller.close();
      },
    }),
  });
  const result = await downloadVideo('https://www.tiktok.com/@creator/photo/streamed-photo', {
    metadata,
    fetchImpl,
    downloadDir: root,
    maxSlideshowItemBytes: 1024,
    maxSlideshowTotalBytes: 1024,
  });
  assert.equal(result.mediaType, 'slideshow');
  assert.ok((await readFile(result.primaryFile)).includes(Buffer.from('streamed image bytes')));

  await assert.rejects(
    downloadVideo('https://www.tiktok.com/@creator/photo/too-many', {
      metadata: { ...metadata, imageUrls: Array.from({ length: 3 }, (_, index) => `https://cdn.example.test/${index}.jpg`) },
      fetchImpl,
      downloadDir: root,
      maxSlideshowImages: 2,
    }),
    /exceeding the configured limit/i,
  );
  const tempEntries = await readdir(path.join(root, '.tmp')).catch(() => []);
  assert.deepEqual(tempEntries, []);
});

test('photo metadata streaming enforces its byte limit before parsing', async () => {
  const oversized = Buffer.from('<html>this metadata is too large</html>');
  await assert.rejects(
    fetchPhotoPostMetadata('https://www.tiktok.com/@creator/photo/streamed-metadata', {
      maxPhotoMetadataBytes: 8,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        url: 'https://www.tiktok.com/@creator/photo/streamed-metadata',
        headers: { get: () => null },
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(oversized.subarray(0, 8));
            controller.enqueue(oversized.subarray(8));
            controller.close();
          },
        }),
      }),
    }),
    /size limit/i,
  );
});

test('listProfileStories refreshes cached no-story profiles before hitting the story API', async () => {
  const storyFetch = createStoryFetch({ userStoryStatus: 0, hasItems: false });
  const stories = await listProfileStories('creator', {
    fetchImpl: storyFetch,
    limit: 2,
    username: 'creator',
    watch: { author_id: '424242424242', sec_uid: TEST_SEC_UID, has_story: 0 },
  });

  assert.equal(stories.count, 0);
  assert.equal(storyFetch.profileRequests, 1);
  assert.equal(storyFetch.apiRequests, 0);
  assert.equal(stories.metadata.hasStory, false);
});

test('parsePhotoPostMetadata rejects HTML without image data', () => {
  assert.throws(
    () => parsePhotoPostMetadata('<html></html>', 'https://www.tiktok.com/@user/photo/1'),
    /rehydration data/,
  );
});

async function createFakeYtDlp() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fake-ytdlp-'));
  const scriptPath = path.join(dir, 'yt-dlp');
  const script = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valuesAfter = (flag) => args.flatMap((arg, index) => arg === flag ? [args[index + 1]] : []);

if (has('--dump-single-json')) {
  const sourceUrl = args[args.length - 1] || '';
  if (sourceUrl.includes('/story')) {
    process.stdout.write(JSON.stringify({
      _type: 'playlist',
      id: 'creator-stories',
      title: 'Creator stories',
      entries: [
        { id: '3333333333', title: 'Story', url: '3333333333', duration: 12 },
      ],
    }));
    process.exit(0);
  }

  if (has('--flat-playlist')) {
    const isSecUidProfile = sourceUrl.startsWith('tiktokuser:');
    const secUid = isSecUidProfile ? sourceUrl.slice('tiktokuser:'.length) : 'creator';
    process.stdout.write(JSON.stringify({
      _type: 'playlist',
      id: secUid,
      title: 'Creator uploads',
      entries: [
        { id: '111', title: 'First', uploader: 'creator', uploader_id: '424242424242', channel_id: isSecUidProfile ? secUid : '${TEST_SEC_UID}', webpage_url: 'https://www.tiktok.com/@creator/video/111' },
        { id: '222', title: 'Second', uploader: 'creator', uploader_id: '424242424242', channel_id: isSecUidProfile ? secUid : '${TEST_SEC_UID}', webpage_url: 'https://www.tiktok.com/@creator/video/222' },
      ],
    }));
    process.exit(0);
  }

  process.stdout.write(JSON.stringify({
    id: '9876543210',
    title: 'A video',
    uploader: 'creator',
    webpage_url: 'https://www.tiktok.com/@creator/video/9876543210',
  }));
  process.exit(0);
}

const pathsArgs = valuesAfter('--paths');
const pathsArg = pathsArgs.find((entry) => entry.startsWith('home:')) ?? pathsArgs.find((entry) => entry.startsWith('temp:')) ?? '';
const downloadDir = pathsArg.includes(':') ? pathsArg.slice(pathsArg.indexOf(':') + 1) : pathsArg;
if (!downloadDir) {
  process.stderr.write('missing download dir');
  process.exit(2);
}

fs.mkdirSync(downloadDir, { recursive: true });
const outputPath = path.join(downloadDir, 'downloaded.mp4');
fs.writeFileSync(outputPath, 'fake video');
process.stdout.write(outputPath + '\\n');
process.exit(0);
`;

  await writeFile(scriptPath, script, { mode: 0o755 });
  await chmod(scriptPath, 0o755);
  return scriptPath;
}

async function createUnsupportedYtDlp() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fake-ytdlp-unsupported-'));
  const scriptPath = path.join(dir, 'yt-dlp');
  const script = `#!/usr/bin/env node
process.stderr.write('ERROR: Unsupported URL: https://www.tiktok.com/@user400567892112/photo/7640994586499878174\\n');
process.exit(1);
`;

  await writeFile(scriptPath, script, { mode: 0o755 });
  await chmod(scriptPath, 0o755);
  return scriptPath;
}

async function createArtifactOnlyYtDlp() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fake-ytdlp-artifacts-'));
  const scriptPath = path.join(dir, 'yt-dlp');
  const script = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const paths = args.flatMap((arg, index) => arg === '--paths' ? [args[index + 1]] : []);
const home = paths.find((entry) => entry.startsWith('home:')) || paths.find((entry) => entry.startsWith('temp:')) || '';
const outputDir = home.slice(home.indexOf(':') + 1);
fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(path.join(outputDir, '9876543210.jpg'), 'thumbnail');
fs.writeFileSync(path.join(outputDir, '9876543210.m4a'), 'audio');
fs.writeFileSync(path.join(outputDir, '9876543210.info.json'), '{}');
fs.writeFileSync(path.join(outputDir, '9876543210.description'), 'description');
process.exit(0);
`;

  await writeFile(scriptPath, script, { mode: 0o755 });
  await chmod(scriptPath, 0o755);
  return scriptPath;
}

function createPhotoFetch() {
  return async (url) => {
    const textUrl = String(url);
    if (/\.jpe?g/.test(textUrl)) {
      const image = Buffer.from(`image:${textUrl}`);
      return {
        ok: true,
        status: 200,
        url: textUrl,
        headers: { get: () => 'image/jpeg' },
        arrayBuffer: async () => image.buffer.slice(image.byteOffset, image.byteOffset + image.byteLength),
      };
    }
    return {
      ok: true,
      status: 200,
      url: 'https://www.tiktok.com/@user400567892112/photo/7640994586499878174',
      text: async () => makePhotoHtml(),
    };
  };
}

function createStoryFetch({ userStoryStatus = 1, hasItems = true } = {}) {
  const fetchImpl = async (url) => {
    const textUrl = String(url);
    if (textUrl.includes('/api/story/item_list/')) {
      fetchImpl.apiRequests += 1;
      const parsed = new URL(textUrl);
      assert.equal(parsed.searchParams.get('authorId'), '424242424242');
      assert.equal(parsed.searchParams.get('count'), '2');
      const itemList = hasItems
        ? [
            {
              id: '3333333333',
              desc: 'Story',
              createTime: '1780000000',
              author: {
                uniqueId: 'creator',
              },
              story: {
                ExpiredAt: 1780086400000,
              },
              video: {
                id: '3333333333',
                duration: 12,
                cover: 'https://cdn.example.test/story.jpg',
                PlayAddrStruct: {
                  DataSize: 16,
                  UrlList: ['https://cdn.example.test/story.mp4'],
                },
              },
            },
          ]
        : [];
      return {
        ok: true,
        status: 200,
        url: textUrl,
        json: async () => ({
          statusCode: 0,
          TotalCount: itemList.length,
          itemList,
        }),
      };
    }

    if (textUrl === 'https://cdn.example.test/story.mp4') {
      const video = Buffer.from('fake story video');
      return {
        ok: true,
        status: 200,
        url: textUrl,
        headers: { get: () => 'video/mp4' },
        arrayBuffer: async () => video.buffer.slice(video.byteOffset, video.byteOffset + video.byteLength),
      };
    }

    if (textUrl.includes('www.tiktok.com/@creator')) {
      fetchImpl.profileRequests += 1;
    }
    return {
      ok: true,
      status: 200,
      url: 'https://www.tiktok.com/@creator',
      text: async () => makeStoryProfileHtml({ userStoryStatus }),
    };
  };
  fetchImpl.profileRequests = 0;
  fetchImpl.apiRequests = 0;
  return fetchImpl;
}

function makeStoryProfileHtml({ userStoryStatus = 1 } = {}) {
  const data = {
    __DEFAULT_SCOPE__: {
      'webapp.user-detail': {
        userInfo: {
          user: {
            id: '424242424242',
            uniqueId: 'creator',
            secUid: TEST_SEC_UID,
            UserStoryStatus: userStoryStatus,
          },
        },
      },
    },
  };
  return `<html><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify(data)}</script></html>`;
}

function makePhotoHtml() {
  const data = {
    __DEFAULT_SCOPE__: {
      'webapp.reflow.video.detail': {
        itemInfo: {
          itemStruct: {
            id: '7640994586499878174',
            desc: 'I know this much is true',
            createTime: '1779057706',
            author: {
              uniqueId: 'user400567892112',
              nickname: 'creator',
            },
            imagePost: {
              images: [
                {
                  imageURL: {
                    urlList: ['https://cdn.example.test/one.jpeg'],
                  },
                  imageWidth: 100,
                  imageHeight: 100,
                },
                {
                  imageURL: {
                    urlList: ['https://cdn.example.test/two.jpeg'],
                  },
                  imageWidth: 200,
                  imageHeight: 200,
                },
              ],
            },
          },
        },
      },
    },
  };
  return `<html><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify(data)}</script></html>`;
}
