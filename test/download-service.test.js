import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDownloadService } from '../src/download/service.js';
import { createStore } from '../src/state/store.js';

test('DownloadService coalesces concurrent requests into one immutable asset with separate deliveries', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tiktok-dlp-download-service-'));
  const store = createStore(path.join(dir, 'state.db'));
  const downloadDir = path.join(dir, 'downloads');
  let downloads = 0;
  try {
    const service = createDownloadService({
      config: {
        downloadDir,
        publicBaseUrl: 'https://example.test',
        downloadLinkTtlMinutes: 30,
        maxConcurrentDownloads: 1,
        maxDownloadQueueSize: 10,
        maxQueuedDownloadsPerUser: 2,
        maxQueuedDownloadsPerGuild: 4,
      },
      store,
      metadataFetcher: async () => ({
        id: '1234567890123456789',
        uploader: 'creator',
        title: 'Shared post',
        webpage_url: 'https://www.tiktok.com/@creator/video/1234567890123456789',
      }),
      downloader: async () => {
        downloads += 1;
        const filePath = path.join(downloadDir, 'creator', 'shared.mp4');
        await mkdir(path.dirname(filePath), { recursive: true });
        await writeFile(filePath, 'video');
        return {
          filePath,
          primaryFile: filePath,
          filename: 'shared.mp4',
          sizeBytes: 5,
          videoId: '1234567890123456789',
          username: 'creator',
          title: 'Shared post',
        };
      },
    });

    const [first, second] = await Promise.all([
      service.request('https://www.tiktok.com/@creator/video/1234567890123456789', {
        requestedBy: 'user-a',
        guildId: 'guild-a',
        channelId: 'channel-a',
      }),
      service.request('https://www.tiktok.com/@creator/video/1234567890123456789', {
        requestedBy: 'user-b',
        guildId: 'guild-b',
        channelId: 'channel-b',
      }),
    ]);

    assert.equal(downloads, 1);
    assert.equal(first.fileId, second.fileId);
    assert.notEqual(first.token, second.token);
    assert.equal(store.stats().fileCount, 1);
    assert.equal(store.getToken(first.token).owner_id, 'user-a');
    assert.equal(store.getToken(second.token).owner_id, 'user-b');
    assert.equal(store.listDownloadLinksByRequester('user-a').length, 1);
    assert.equal(store.listDownloadLinksByRequester('user-b').length, 1);

    const monitorDelivery = await service.createDeliveryForAsset(first, {
      type: 'monitor',
      scopeId: 'guild:guild-a',
      permanent: true,
    });
    assert.equal(store.getToken(monitorDelivery.token).expires_at, 0);
    assert.notEqual(store.getToken(first.token).expires_at, 0);
    assert.deepEqual(
      store.listPermanentDownloadsByRequester('user-a', { includeMonitored: true, scopeId: 'guild:guild-a' }).map((link) => link.token),
      [monitorDelivery.token],
    );
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('DownloadService applies per-user ingress limits before queuing more work', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tiktok-dlp-download-limit-'));
  const store = createStore(path.join(dir, 'state.db'));
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  try {
    const service = createDownloadService({
      config: {
        downloadDir: path.join(dir, 'downloads'),
        publicBaseUrl: 'https://example.test',
        downloadLinkTtlMinutes: 30,
        maxConcurrentDownloads: 1,
        maxQueuedDownloadsPerUser: 1,
      },
      store,
      metadataFetcher: async () => ({ id: '1234567890123456789', uploader: 'creator' }),
      downloader: async () => {
        await blocked;
        const filePath = path.join(dir, 'downloads', 'one.mp4');
        await mkdir(path.dirname(filePath), { recursive: true });
        await writeFile(filePath, 'video');
        return { filePath, filename: 'one.mp4', sizeBytes: 5, videoId: '1234567890123456789', username: 'creator' };
      },
    });
    const first = service.request('https://www.tiktok.com/@creator/video/1234567890123456789', { requestedBy: 'user-a' });
    await assert.rejects(
      service.request('https://www.tiktok.com/@creator/video/1234567890123456788', { requestedBy: 'user-a' }),
      /already have 1 download request/i,
    );
    release();
    await first;
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
