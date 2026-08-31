import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalDownloadKey, createDownloadService } from '../src/download/service.js';
import { createPlatformRegistry, tiktokAdapter } from '../src/platforms/index.js';
import { createStore } from '../src/state/store.js';

test('DownloadService dispatches TikTok probes and downloads through its platform adapter', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tiktok-adapter-download-service-'));
  const store = createStore(path.join(dir, 'state.db'));
  const downloadDir = path.join(dir, 'downloads');
  const calls = [];
  try {
    const registry = createPlatformRegistry([{
      ...tiktokAdapter,
      async probe(sourceUrl, options) {
        calls.push({ operation: 'probe', sourceUrl, options });
        return {
          id: '1234567890123456789',
          uploader: 'creator',
          title: 'Adapter post',
          webpage_url: sourceUrl,
        };
      },
      async download(sourceUrl, options) {
        calls.push({ operation: 'download', sourceUrl, options });
        const filePath = path.join(downloadDir, 'creator', 'adapter.mp4');
        await mkdir(path.dirname(filePath), { recursive: true });
        await writeFile(filePath, 'video');
        return {
          filePath,
          primaryFile: filePath,
          filename: 'adapter.mp4',
          sizeBytes: 5,
          videoId: '1234567890123456789',
          username: 'creator',
          title: 'Adapter post',
        };
      },
    }]);
    const service = createDownloadService({
      config: {
        downloadDir,
        publicBaseUrl: 'https://example.test',
        maxConcurrentDownloads: 1,
        adapterMarker: 'config-reached-adapter',
      },
      store,
      platformRegistry: registry,
    });

    const result = await service.request(
      'https://m.tiktok.com/@Creator/video/1234567890123456789?utm_source=share',
    );

    assert.deepEqual(calls.map((call) => call.operation), ['probe', 'download']);
    assert.equal(calls[0].sourceUrl, 'https://www.tiktok.com/@creator/video/1234567890123456789');
    assert.equal(calls[0].options.config.adapterMarker, 'config-reached-adapter');
    assert.equal(calls[0].options.reference.remoteId, '1234567890123456789');
    assert.equal(calls[1].options.adapterMarker, 'config-reached-adapter');
    assert.equal(calls[1].options.metadata.title, 'Adapter post');
    assert.equal(result.platform, 'tiktok');
    assert.equal(result.videoId, '1234567890123456789');
    assert.equal(result.username, 'creator');
    assert.equal(store.getLatestFileByPost('tiktok', result.videoId).id, result.fileId);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('DownloadService coalesces concurrent requests into one immutable asset with separate deliveries', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tiktok-dlp-download-service-'));
  const store = createStore(path.join(dir, 'state.db'));
  const downloadDir = path.join(dir, 'downloads');
  let downloads = 0;
  let releaseMetadata;
  const metadataGate = new Promise((resolve) => { releaseMetadata = resolve; });
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
      metadataFetcher: async () => {
        await metadataGate;
        return {
          id: '1234567890123456789',
          uploader: 'creator',
          title: 'Shared post',
          webpage_url: 'https://www.tiktok.com/@creator/video/1234567890123456789',
        };
      },
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

    const firstPromise = service.request('https://www.tiktok.com/@creator/video/1234567890123456789', {
      requestedBy: 'user-a',
      guildId: 'guild-a',
      channelId: 'channel-a',
    });
    const secondPromise = service.request('https://www.tiktok.com/@creator/video/1234567890123456789', {
      requestedBy: 'user-b',
      guildId: 'guild-b',
      channelId: 'channel-b',
    });
    const thirdPromise = service.request('https://www.tiktok.com/t/ZMshortlink/', {
      requestedBy: 'user-c',
      guildId: 'guild-c',
      channelId: 'channel-c',
      metadata: {
        id: '1234567890123456789',
        uploader: 'creator',
        title: 'Shared post',
        webpage_url: 'https://www.tiktok.com/@creator/video/1234567890123456789',
      },
    });
    releaseMetadata();
    const [first, second, third] = await Promise.all([firstPromise, secondPromise, thirdPromise]);

    assert.equal(downloads, 1);
    assert.equal(first.fileId, second.fileId);
    assert.equal(first.fileId, third.fileId);
    assert.notEqual(first.token, second.token);
    assert.notEqual(first.token, third.token);
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
    assert.equal(monitorDelivery.deliveryReused, false);
    assert.equal(store.getToken(monitorDelivery.token).expires_at, 0);
    assert.notEqual(store.getToken(first.token).expires_at, 0);
    assert.deepEqual(
      store.listPermanentDownloadsByRequester('user-a', { includeMonitored: true, scopeId: 'guild:guild-a' }).map((link) => link.token),
      [monitorDelivery.token],
    );

    const restartedService = createDownloadService({
      config: {
        downloadDir,
        publicBaseUrl: 'https://example.test',
        downloadLinkTtlMinutes: 30,
      },
      store,
    });
    const retriedMonitorDelivery = await restartedService.createDeliveryForAsset(first, {
      type: 'monitor',
      scopeId: 'guild:guild-a',
      permanent: true,
    });
    assert.equal(retriedMonitorDelivery.deliveryReused, true);
    assert.equal(retriedMonitorDelivery.token, monitorDelivery.token);
    assert.equal(retriedMonitorDelivery.jobId, monitorDelivery.jobId);
    assert.equal(store.db.prepare(`
      SELECT COUNT(*) AS count
      FROM link_tokens
      WHERE file_id = ? AND scope_id = ? AND delivery_type = 'monitor' AND expires_at = 0
    `).get(first.fileId, 'guild:guild-a').count, 1);

    const otherScopeDelivery = await restartedService.createDeliveryForAsset(first, {
      type: 'monitor',
      scopeId: 'guild:guild-b',
      permanent: true,
    });
    assert.notEqual(otherScopeDelivery.token, monitorDelivery.token);
    assert.equal(otherScopeDelivery.deliveryReused, false);
    assert.equal(store.db.prepare(`
      SELECT COUNT(*) AS count
      FROM link_tokens
      WHERE file_id = ? AND delivery_type = 'monitor' AND expires_at = 0
    `).get(first.fileId).count, 2);
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

test('DownloadService bounds metadata extraction with the shared worker concurrency', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tiktok-dlp-download-metadata-limit-'));
  const store = createStore(path.join(dir, 'state.db'));
  const downloadDir = path.join(dir, 'downloads');
  let releaseFirstMetadata;
  const firstMetadataGate = new Promise((resolve) => {
    releaseFirstMetadata = resolve;
  });
  let activeMetadata = 0;
  let maxActiveMetadata = 0;
  const metadataStarts = [];
  try {
    const service = createDownloadService({
      config: {
        downloadDir,
        publicBaseUrl: 'https://example.test',
        maxConcurrentDownloads: 1,
        maxDownloadQueueSize: 10,
      },
      store,
      metadataFetcher: async (sourceUrl) => {
        activeMetadata += 1;
        maxActiveMetadata = Math.max(maxActiveMetadata, activeMetadata);
        metadataStarts.push(sourceUrl);
        try {
          if (sourceUrl.includes('1234567890123456789')) await firstMetadataGate;
          const id = sourceUrl.match(/video\/(\d+)/)?.[1] ?? '';
          return { id, uploader: `creator-${id.slice(-1)}` };
        } finally {
          activeMetadata -= 1;
        }
      },
      downloader: async (sourceUrl, options) => {
        const id = options.metadata.id;
        const filePath = path.join(downloadDir, `${id}.mp4`);
        await mkdir(path.dirname(filePath), { recursive: true });
        await writeFile(filePath, sourceUrl);
        return { filePath, filename: `${id}.mp4`, sizeBytes: sourceUrl.length, videoId: id };
      },
    });

    const first = service.request('https://www.tiktok.com/@creator/video/1234567890123456789', {
      requestedBy: 'user-a',
    });
    const second = service.request('https://www.tiktok.com/@creator/video/1234567890123456788', {
      requestedBy: 'user-b',
    });

    await waitFor(() => metadataStarts.length === 1);
    assert.equal(maxActiveMetadata, 1);
    assert.deepEqual(service.status(), {
      concurrency: 1,
      active: 1,
      queued: 1,
      admitted: 2,
      workQueued: 1,
      inFlightAssets: 0,
      identityInFlight: 2,
      pendingUsers: 2,
      pendingGuilds: 0,
    });

    releaseFirstMetadata();
    await Promise.all([first, second]);
    assert.equal(metadataStarts.length, 2);
    assert.equal(maxActiveMetadata, 1);
    assert.equal(service.status().admitted, 0);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('DownloadService counts coalesced monitor requests against global admission', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tiktok-dlp-download-global-limit-'));
  const store = createStore(path.join(dir, 'state.db'));
  const downloadDir = path.join(dir, 'downloads');
  let releaseMetadata;
  const metadataGate = new Promise((resolve) => {
    releaseMetadata = resolve;
  });
  let metadataCalls = 0;
  let downloads = 0;
  try {
    const service = createDownloadService({
      config: {
        downloadDir,
        publicBaseUrl: 'https://example.test',
        maxConcurrentDownloads: 1,
        maxDownloadQueueSize: 2,
      },
      store,
      metadataFetcher: async () => {
        metadataCalls += 1;
        await metadataGate;
        return { id: '1234567890123456789', uploader: 'creator' };
      },
      downloader: async () => {
        downloads += 1;
        const filePath = path.join(downloadDir, 'shared.mp4');
        await mkdir(path.dirname(filePath), { recursive: true });
        await writeFile(filePath, 'video');
        return {
          filePath,
          filename: 'shared.mp4',
          sizeBytes: 5,
          videoId: '1234567890123456789',
          username: 'creator',
        };
      },
    });

    const sourceUrl = 'https://www.tiktok.com/@creator/video/1234567890123456789';
    const first = service.request(sourceUrl, { type: 'monitor', createDelivery: false });
    const second = service.request(sourceUrl, { type: 'monitor', createDelivery: false });
    await waitFor(() => metadataCalls === 1);

    assert.equal(service.status().admitted, 2);
    assert.equal(service.status().identityInFlight, 1);
    await assert.rejects(
      service.request('https://www.tiktok.com/@creator/video/1234567890123456788', {
        type: 'monitor',
        createDelivery: false,
      }),
      /download queue is full/i,
    );
    assert.equal(metadataCalls, 1);

    releaseMetadata();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.equal(downloads, 1);
    assert.equal(firstResult.fileId, secondResult.fileId);
    assert.equal(service.status().admitted, 0);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});


test('DownloadService rejects unsafe and non-post sources before creating jobs or invoking download work', async () => {
  let jobs = 0;
  let metadataCalls = 0;
  let downloadCalls = 0;
  const service = createDownloadService({
    config: { downloadDir: '/tmp/downloads' },
    store: {
      createJob() {
        jobs += 1;
        return jobs;
      },
    },
    metadataFetcher: async () => {
      metadataCalls += 1;
      return {};
    },
    downloader: async () => {
      downloadCalls += 1;
      return {};
    },
  });

  for (const sourceUrl of [
    'http://www.tiktok.com/@creator/video/1234567890123456789',
    'https://user:password@www.tiktok.com/@creator/video/1234567890123456789',
    'https://www.tiktok.com.evil.test/@creator/video/1234567890123456789',
    'tiktokuser:internal-profile-id',
    'https://www.instagram.com/creator/',
    'https://x.com/creator',
    'not a URL',
  ]) {
    await assert.rejects(service.request(sourceUrl), /TikTok, Instagram, or X\/Twitter post URL/i);
  }

  assert.equal(jobs, 0);
  assert.equal(metadataCalls, 0);
  assert.equal(downloadCalls, 0);
});

test('DownloadService routes Instagram posts without a metadata probe and preserves ordered assets', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'media-download-service-instagram-'));
  const store = createStore(path.join(dir, 'state.db'));
  let metadataCalls = 0;
  let galleryCalls = 0;
  try {
    const firstPath = path.join(dir, 'downloads', 'instagram', 'creator', 'post__01.jpg');
    const bundlePath = path.join(dir, 'downloads', 'instagram', 'creator', 'post.zip');
    const service = createDownloadService({
      config: {
        downloadDir: path.join(dir, 'downloads'),
        publicBaseUrl: 'https://example.test',
        maxConcurrentDownloads: 1,
      },
      store,
      metadataFetcher: async () => {
        metadataCalls += 1;
        throw new Error('TikTok metadata must not run for Instagram.');
      },
      platformDownloaders: {
        instagram: async (sourceUrl, options) => {
          galleryCalls += 1;
          assert.equal(sourceUrl, 'https://www.instagram.com/p/AbC_1/');
          assert.equal(options.reference.remoteId, 'AbC_1');
          await mkdir(path.dirname(firstPath), { recursive: true });
          await writeFile(firstPath, 'image');
          await writeFile(bundlePath, 'bundle');
          return {
            remoteId: 'AbC_1',
            username: 'creator',
            title: 'A carousel',
            mediaType: 'gallery',
            bundlePath,
            assets: [
              { position: 1, path: firstPath, kind: 'image' },
              { position: 0, path: firstPath, kind: 'image' },
            ],
          };
        },
      },
    });

    const result = await service.request('https://instagram.com/p/AbC_1/?igsh=tracking', {
      requestedBy: 'user-a',
    });

    assert.equal(metadataCalls, 0);
    assert.equal(galleryCalls, 1);
    assert.equal(result.platform, 'instagram');
    assert.equal(result.videoId, 'AbC_1');
    assert.equal(result.username, 'creator');
    assert.equal(result.filePath, bundlePath);
    assert.deepEqual(result.assets.map((asset) => asset.position), [0, 1]);
    assert.equal(store.getLatestFileByPost('instagram', 'AbC_1').id, result.fileId);
    assert.equal(store.getLatestFileByVideoId('AbC_1'), null);
    assert.equal(store.getMediaPost('instagram', 'AbC_1').media_type, 'gallery');
    assert.equal(store.listMediaAssetsForFile(result.fileId).length, 3);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('DownloadService trusts the extracted X creator over a stale status URL handle', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'media-download-service-x-creator-'));
  const store = createStore(path.join(dir, 'state.db'));
  const downloadDir = path.join(dir, 'downloads');
  let downloadCalls = 0;
  try {
    const service = createDownloadService({
      config: { downloadDir, publicBaseUrl: 'https://example.test', maxConcurrentDownloads: 1 },
      store,
      platformDownloaders: {
        x: async () => {
          downloadCalls += 1;
          const filePath = path.join(downloadDir, 'x', 'correct', '123.mp4');
          await mkdir(path.dirname(filePath), { recursive: true });
          await writeFile(filePath, 'video');
          return {
            remoteId: '123',
            creator: { remoteId: 'x-user-1', handle: 'correct', displayName: 'Correct Creator' },
            mediaType: 'video',
            filePath,
            filename: '123.mp4',
            sizeBytes: 5,
            assets: [{ position: 1, path: filePath, filename: '123.mp4', kind: 'video', sizeBytes: 5 }],
          };
        },
      },
    });

    const result = await service.request('https://x.com/wrong/status/123', { username: 'wrong' });

    assert.equal(result.username, 'correct');
    assert.equal(store.getLatestFileByPost('x', '123').username, 'correct');
    assert.equal(store.getPlatformProfile('x', 'x-user-1').handle, 'correct');
    assert.equal(store.getPlatformProfile({ platform: 'x', handle: 'wrong' }), null);
    const reused = await service.request('https://x.com/anotherwrong/status/123', {
      username: 'anotherwrong',
    });
    assert.equal(reused.reused, true);
    assert.equal(reused.username, 'correct');
    assert.equal(downloadCalls, 1);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('DownloadService removes an uncommitted platform archive when persistence fails', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'media-download-service-persistence-failure-'));
  const store = createStore(path.join(dir, 'state.db'));
  const downloadDir = path.join(dir, 'downloads');
  let archivedPath = '';
  try {
    const service = createDownloadService({
      config: { downloadDir, publicBaseUrl: 'https://example.test', maxConcurrentDownloads: 1 },
      store,
      platformDownloaders: {
        instagram: async () => {
          const outputDir = await mkdtemp(path.join(dir, 'gallery-stage-'));
          const filePath = path.join(outputDir, 'asset.jpg');
          await writeFile(filePath, 'image');
          return {
            outputDir,
            post: {
              platform: 'instagram',
              remoteId: 'AbC',
              creator: { remoteId: 'ig-1', handle: 'creator' },
              mediaType: 'image',
            },
            assets: [{ position: 0, filePath, filename: 'asset.jpg', kind: 'image', sizeBytes: 5 }],
          };
        },
      },
    });

    store.createFileWithMedia = (input) => {
      archivedPath = input.file.filePath;
      throw new Error('simulated commit failure');
    };

    await assert.rejects(
      service.request('https://www.instagram.com/p/AbC/'),
      /simulated commit failure/,
    );
    assert.ok(archivedPath);
    await assert.rejects(access(path.dirname(archivedPath)), { code: 'ENOENT' });
    assert.equal(store.stats().fileCount, 0);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('DownloadService persists a small normalized metadata record instead of raw extractor output', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'media-download-service-metadata-'));
  const store = createStore(path.join(dir, 'state.db'));
  const downloadDir = path.join(dir, 'downloads');
  const rawMetadata = {
    id: '1234567890123456789',
    uploader: 'creator',
    title: 'Saved title',
    formats: Array.from({ length: 500 }, (_, index) => ({
      url: `https://cdn.example.test/media?signature=secret-${index}`,
    })),
    http_headers: { Authorization: 'secret' },
    requested_downloads: [{ url: 'https://cdn.example.test/signed?token=secret' }],
  };
  try {
    const service = createDownloadService({
      config: { downloadDir, publicBaseUrl: 'https://example.test', maxConcurrentDownloads: 1 },
      store,
      metadataFetcher: async () => rawMetadata,
      downloader: async () => {
        const filePath = path.join(downloadDir, 'creator', 'post.mp4');
        await mkdir(path.dirname(filePath), { recursive: true });
        await writeFile(filePath, 'video');
        return {
          ...rawMetadata,
          metadata: rawMetadata,
          filePath,
          filename: 'post.mp4',
          sizeBytes: 5,
          videoId: rawMetadata.id,
          username: rawMetadata.uploader,
          mediaType: 'video',
        };
      },
    });

    await service.request('https://www.tiktok.com/@creator/video/1234567890123456789');
    const post = store.getMediaPost('tiktok', rawMetadata.id);
    const metadata = JSON.parse(post.metadata_json);
    assert.deepEqual(metadata, {
      schemaVersion: 1,
      platform: 'tiktok',
      remoteId: rawMetadata.id,
      creator: { remoteId: '', handle: 'creator', displayName: '' },
      mediaType: 'video',
      assetCount: 1,
    });
    assert.ok(Buffer.byteLength(post.metadata_json, 'utf8') < 1_024);
    assert.doesNotMatch(post.metadata_json, /formats|signature|authorization|secret/i);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('download identity keys include the platform', () => {
  const tiktok = canonicalDownloadKey('https://www.tiktok.com/@creator/video/123');
  const x = canonicalDownloadKey('https://x.com/creator/status/123');
  assert.equal(tiktok, 'tiktok:post:123');
  assert.equal(x, 'x:post:123');
  assert.notEqual(tiktok, x);
});

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for condition.');
}
