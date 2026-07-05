import { mkdtemp, chmod, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  buildDownloadArgs,
  buildMetadataArgs,
  classifyYtdlpError,
  downloadVideo,
  fetchVideoMetadata,
  listProfileVideos,
  parsePhotoPostMetadata,
} from '../src/tiktok/ytdlp.js';

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
  if (has('--flat-playlist')) {
    process.stdout.write(JSON.stringify({
      _type: 'playlist',
      id: 'creator',
      title: 'Creator uploads',
      entries: [
        { id: '111', title: 'First', webpage_url: 'https://www.tiktok.com/@creator/video/111' },
        { id: '222', title: 'Second', webpage_url: 'https://www.tiktok.com/@creator/video/222' },
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
