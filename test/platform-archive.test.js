import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { archivePlatformDownload } from '../src/platforms/archive.js';

test('platform archive keeps ordered content assets and creates a delivery ZIP for multi-media posts', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'platform-archive-'));
  const staging = await mkdtemp(path.join(dir, 'staging-'));
  const first = path.join(staging, 'first.jpg');
  const second = path.join(staging, 'second.mp4');
  try {
    await writeFile(first, 'image');
    await writeFile(second, 'video');
    const result = await archivePlatformDownload({
      outputDir: staging,
      post: {
        platform: 'x',
        remoteId: '123',
        canonicalUrl: 'https://x.com/creator/status/123',
        creator: { handle: 'creator' },
        mediaType: 'mixed',
        publishedAt: '2026-08-30T12:34:56Z',
      },
      assets: [
        { position: 0, filePath: first, filename: 'first.jpg', kind: 'image', sizeBytes: 5 },
        { position: 1, filePath: second, filename: 'second.mp4', kind: 'video', sizeBytes: 5 },
      ],
    }, { downloadDir: path.join(dir, 'downloads') });

    assert.equal(result.assets.length, 2);
    assert.equal(result.bundlePath, result.filePath);
    assert.match(result.filePath, /downloads[\/]x[\/]creator[\/]2026[\/]08[\/]30/);
    assert.equal(path.extname(result.filePath), '.zip');
    assert.deepEqual(result.assets.map((asset) => asset.position), [0, 1]);
    assert.equal((await readFile(result.filePath)).subarray(0, 2).toString(), 'PK');
    assert.equal((await readFile(result.assets[0].path)).toString(), 'image');
    assert.equal((await readFile(result.assets[1].path)).toString(), 'video');
    await assert.rejects(access(staging), { code: 'ENOENT' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('platform archive refuses assets outside adapter-owned staging', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'platform-archive-containment-'));
  const staging = await mkdtemp(path.join(dir, 'staging-'));
  const outside = path.join(dir, 'outside.jpg');
  try {
    await writeFile(outside, 'do not remove');
    await assert.rejects(archivePlatformDownload({
      outputDir: staging,
      post: { platform: 'instagram', remoteId: 'AbC', creator: { handle: 'creator' } },
      assets: [{ position: 0, filePath: outside, filename: 'outside.jpg', kind: 'image' }],
    }, { downloadDir: path.join(dir, 'downloads') }), /outside its staging directory/i);
    assert.equal((await readFile(outside)).toString(), 'do not remove');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('platform archive refuses a staging directory that could consume the archive root', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'platform-archive-broad-staging-'));
  const assetPath = path.join(dir, 'asset.jpg');
  try {
    await writeFile(assetPath, 'keep me');
    await assert.rejects(archivePlatformDownload({
      outputDir: dir,
      post: { platform: 'instagram', remoteId: 'AbC', creator: { handle: 'creator' } },
      assets: [{ position: 0, filePath: assetPath, filename: 'asset.jpg', kind: 'image' }],
    }, { downloadDir: path.join(dir, 'downloads') }), /must not contain the configured download directory/i);
    assert.equal((await readFile(assetPath)).toString(), 'keep me');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
