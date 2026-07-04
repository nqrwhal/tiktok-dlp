import { mkdtemp, chmod, writeFile } from 'node:fs/promises';
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

test('buildDownloadArgs points yt-dlp at a temp output dir', () => {
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
});

async function createFakeYtDlp() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fake-ytdlp-'));
  const scriptPath = path.join(dir, 'yt-dlp');
  const script = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : '';
};

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

const pathsArg = valueAfter('--paths');
const downloadDir = pathsArg.startsWith('temp:') ? pathsArg.slice(5) : pathsArg;
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
