import path from 'node:path';
import { readdir } from 'node:fs/promises';
import { downloadVideo, fetchVideoMetadata } from '../tiktok/ytdlp.js';
import { assertTikTokDownloadUrl, extractVideoId, fileSize, makePublicFileUrl, randomToken } from '../util/files.js';

const DEFAULT_MAX_QUEUE_SIZE = 50;
const DEFAULT_MAX_PER_USER = 3;
const DEFAULT_MAX_PER_GUILD = 12;
const HANDOFF = Symbol('download-handoff');

export class DownloadService {
  constructor({
    config,
    store,
    metadataFetcher = fetchVideoMetadata,
    downloader = downloadVideo,
    now = () => Date.now(),
    logger = console,
  } = {}) {
    if (!config) throw new Error('DownloadService requires config.');
    if (!store) throw new Error('DownloadService requires store.');
    this.config = config;
    this.store = store;
    this.metadataFetcher = metadataFetcher;
    this.downloader = downloader;
    this.now = now;
    this.logger = logger ?? console;
    this.concurrency = Math.max(1, Number(config.maxConcurrentDownloads) || 1);
    this.maxQueueSize = Math.max(1, Number(config.maxDownloadQueueSize) || DEFAULT_MAX_QUEUE_SIZE);
    this.maxPerUser = Math.max(1, Number(config.maxQueuedDownloadsPerUser) || DEFAULT_MAX_PER_USER);
    this.maxPerGuild = Math.max(1, Number(config.maxQueuedDownloadsPerGuild) || DEFAULT_MAX_PER_GUILD);
  }

  #queue = [];
  #active = 0;
  #inFlightAssets = new Map();
  #pendingByUser = new Map();
  #pendingByGuild = new Map();

  async request(sourceUrl, {
    delivery = 'auto',
    type = 'manual',
    username = '',
    requestedBy = '',
    guildId = '',
    channelId = '',
    scopeId = '',
    permanent = type === 'monitor',
    metadata: providedMetadata = null,
    createDelivery = true,
  } = {}) {
    const resolvedSourceUrl = String(
      sourceUrl
        || providedMetadata?.url
        || providedMetadata?.webpage_url
        || providedMetadata?.sourceUrl
        || '',
    ).trim();
    const validatedSourceUrl = assertTikTokDownloadUrl(resolvedSourceUrl);

    const reservation = this.#reserveRequest({ type, requestedBy, guildId });
    let jobId = null;
    try {
      const initialVideoId = String(providedMetadata?.id || extractVideoId(validatedSourceUrl) || '');
      jobId = this.store.createJob({
        type,
        status: 'queued',
        requestedBy,
        guildId,
        channelId,
        username,
        sourceUrl: validatedSourceUrl,
        videoId: initialVideoId,
        title: String(providedMetadata?.title ?? ''),
      }, this.now());
      const asset = await this.#getAsset({
        sourceUrl: validatedSourceUrl,
        username,
        metadata: providedMetadata,
      });
      if (!createDelivery) {
        this.store.updateJob(jobId, {
          status: 'complete',
          file_id: asset.fileId,
          video_id: asset.videoId,
          username: asset.username,
          title: asset.title,
        }, this.now());
        return {
          ...asset,
          jobId,
          delivery,
          linkPermanent: false,
        };
      }
      const expiresAt = permanent ? 0 : this.now() + this.downloadLinkTtlMs();
      const token = randomToken();
      this.store.createLinkToken({
        token,
        fileId: asset.fileId,
        jobId,
        ownerId: requestedBy,
        scopeId,
        deliveryType: type,
        expiresAt,
      }, this.now());

      const result = {
        ...asset,
        jobId,
        token,
        publicUrl: makePublicFileUrl(this.config, token),
        delivery,
        linkPermanent: expiresAt === 0,
      };
      this.store.updateJob(jobId, {
        status: 'complete',
        file_id: asset.fileId,
        video_id: result.videoId,
        username: result.username,
        title: result.title,
      }, this.now());
      return result;
    } catch (error) {
      if (jobId != null) {
        this.store.updateJob(jobId, { status: 'failed', error: error?.message ?? String(error) }, this.now());
      }
      throw error;
    } finally {
      reservation.release();
    }
  }

  async createDeliveryForAsset(asset, {
    delivery = 'link',
    type = 'monitor',
    requestedBy = '',
    guildId = '',
    channelId = '',
    scopeId = '',
    permanent = type === 'monitor',
  } = {}) {
    if (!asset?.fileId) throw new Error('An existing asset is required to create a delivery.');
    const jobId = this.store.createJob({
      type,
      status: 'complete',
      requestedBy,
      guildId,
      channelId,
      username: asset.username || '',
      sourceUrl: asset.sourceUrl || '',
      videoId: asset.videoId || '',
      title: asset.title || '',
    }, this.now());
    this.store.updateJob(jobId, { file_id: asset.fileId }, this.now());
    const expiresAt = permanent ? 0 : this.now() + this.downloadLinkTtlMs();
    const token = randomToken();
    this.store.createLinkToken({
      token,
      fileId: asset.fileId,
      jobId,
      ownerId: requestedBy,
      scopeId,
      deliveryType: type,
      expiresAt,
    }, this.now());
    return {
      ...asset,
      jobId,
      token,
      publicUrl: makePublicFileUrl(this.config, token),
      delivery,
      linkPermanent: expiresAt === 0,
      reused: Boolean(asset.reused),
    };
  }

  status() {
    return {
      concurrency: this.concurrency,
      active: this.#active,
      queued: this.#queue.length,
      inFlightAssets: this.#inFlightAssets.size,
      pendingUsers: sumCounts(this.#pendingByUser),
      pendingGuilds: sumCounts(this.#pendingByGuild),
    };
  }

  async waitForIdle() {
    while (this.#active || this.#queue.length || this.#inFlightAssets.size) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  #reserveRequest({ type, requestedBy, guildId }) {
    if (type === 'monitor') return { release() {} };
    const userKey = String(requestedBy ?? '');
    const guildKey = String(guildId ?? '');
    if (this.#queue.length + this.#active >= this.maxQueueSize) {
      throw new Error('The download queue is full. Please try again shortly.');
    }
    if (userKey && (this.#pendingByUser.get(userKey) ?? 0) >= this.maxPerUser) {
      throw new Error(`You already have ${this.maxPerUser} download request(s) in progress.`);
    }
    if (guildKey && (this.#pendingByGuild.get(guildKey) ?? 0) >= this.maxPerGuild) {
      throw new Error(`This server already has ${this.maxPerGuild} download request(s) in progress.`);
    }
    increment(this.#pendingByUser, userKey);
    increment(this.#pendingByGuild, guildKey);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        decrement(this.#pendingByUser, userKey);
        decrement(this.#pendingByGuild, guildKey);
      },
    };
  }

  #getAsset(input) {
    const initialKey = canonicalDownloadKey(input.sourceUrl, input.metadata);
    const existing = this.#inFlightAssets.get(initialKey);
    if (existing) return existing;

    const task = { keys: new Set([initialKey]), promise: null };
    task.promise = this.#enqueue(async () => {
      const metadata = input.metadata ?? await this.metadataFetcher(input.sourceUrl, this.config);
      const canonicalKey = canonicalDownloadKey(input.sourceUrl, metadata);
      const canonicalExisting = this.#inFlightAssets.get(canonicalKey);
      if (canonicalExisting && canonicalExisting !== task.promise) {
        return { [HANDOFF]: canonicalExisting };
      }
      task.keys.add(canonicalKey);
      this.#inFlightAssets.set(canonicalKey, task.promise);
      return this.#materializeAsset(input.sourceUrl, metadata, input.username);
    }).finally(() => {
      for (const key of task.keys) {
        if (this.#inFlightAssets.get(key) === task.promise) this.#inFlightAssets.delete(key);
      }
    });
    this.#inFlightAssets.set(initialKey, task.promise);
    return task.promise;
  }

  async #materializeAsset(sourceUrl, metadata, requestedUsername) {
    const resolvedUsername = requestedUsername || metadata?.uploader || metadata?.channel || '';
    const downloadMetadata = resolvedUsername
      ? { ...metadata, uploader: resolvedUsername, username: resolvedUsername }
      : metadata;
    const existing = await this.#findReusableDownload(downloadMetadata);
    if (existing) {
      return this.#resultFromExistingAsset(existing, downloadMetadata, sourceUrl, resolvedUsername);
    }

    const downloaded = await this.downloader(sourceUrl, {
      ...this.config,
      metadata: downloadMetadata,
      downloadDir: this.config.downloadDir,
      keepSlideshowImages: true,
    });
    const sizeBytes = downloaded.sizeBytes ?? await fileSize(downloaded.filePath);
    const filename = downloaded.filename || path.basename(downloaded.filePath);
    const fileId = this.store.createFileRecord({
      videoId: downloadMetadata.id || downloaded.videoId || '',
      username: resolvedUsername || downloaded.username || '',
      sourceUrl,
      filePath: downloaded.filePath,
      filename,
      sizeBytes,
    }, this.now());
    return {
      ...downloaded,
      ...downloadMetadata,
      fileId,
      sourceUrl,
      filePath: downloaded.filePath,
      primaryFile: downloaded.primaryFile || downloaded.filePath,
      filename,
      sizeBytes,
      videoId: downloadMetadata.id || downloaded.videoId || '',
      username: resolvedUsername || downloaded.username || '',
      title: downloadMetadata.title || downloaded.title || '',
      description: downloadMetadata.description || downloaded.description || '',
      thumbnailUrl: downloadMetadata.thumbnail || downloaded.thumbnailUrl || '',
      mediaType: downloadMetadata.mediaType || downloaded.mediaType || '',
      duration: Number(downloadMetadata.duration ?? downloaded.duration ?? 0) || 0,
      reused: false,
    };
  }

  async #findReusableDownload(metadata) {
    const videoId = metadata?.id || metadata?.videoId || '';
    const existing = this.store.getLatestFileByVideoId(videoId);
    if (!existing) return null;
    try {
      return { ...existing, size_bytes: await fileSize(existing.path) };
    } catch {
      return null;
    }
  }

  async #resultFromExistingAsset(fileRecord, metadata, sourceUrl, username) {
    return {
      ...metadata,
      fileId: fileRecord.id,
      sourceUrl,
      filePath: fileRecord.path,
      primaryFile: fileRecord.path,
      filename: fileRecord.filename || path.basename(fileRecord.path),
      sizeBytes: Number(fileRecord.size_bytes || 0),
      videoId: metadata?.id || fileRecord.video_id || '',
      username: username || metadata?.uploader || metadata?.channel || fileRecord.username || '',
      title: metadata?.title || '',
      description: metadata?.description || '',
      thumbnailUrl: metadata?.thumbnail || '',
      mediaType: metadata?.mediaType || '',
      imageCount: metadata?.imageCount,
      slideshowImagePaths: await findSlideshowImagePaths(fileRecord.path, metadata),
      duration: Number(metadata?.duration ?? 0) || 0,
      reused: true,
    };
  }

  #enqueue(work) {
    return new Promise((resolve, reject) => {
      this.#queue.push({ work, resolve, reject });
      this.#drainQueue();
    });
  }

  #drainQueue() {
    while (this.#active < this.concurrency && this.#queue.length) {
      const task = this.#queue.shift();
      this.#active += 1;
      let handedOff = false;
      void Promise.resolve()
        .then(task.work)
        .then((result) => {
          if (result?.[HANDOFF]) {
            handedOff = true;
            this.#active -= 1;
            this.#drainQueue();
            result[HANDOFF].then(task.resolve, task.reject);
            return;
          }
          task.resolve(result);
        }, task.reject)
        .finally(() => {
          if (!handedOff) {
            this.#active -= 1;
            this.#drainQueue();
          }
        });
    }
  }

  downloadLinkTtlMs() {
    return Math.max(1, Number(this.config.downloadLinkTtlMinutes) || 30) * 60 * 1000;
  }
}

export function createDownloadService(options = {}) {
  return new DownloadService(options);
}

export function canonicalDownloadKey(sourceUrl, metadata = null) {
  const videoId = String(metadata?.id || metadata?.videoId || extractVideoId(sourceUrl) || '').trim();
  if (videoId) return `video:${videoId}`;
  try {
    const url = new URL(String(sourceUrl));
    url.search = '';
    url.hash = '';
    return `url:${url.toString()}`;
  } catch {
    return `url:${String(sourceUrl).trim()}`;
  }
}

async function findSlideshowImagePaths(filePath, metadata = {}) {
  if (metadata?.mediaType !== 'slideshow') return [];
  const imageCount = Number(metadata?.imageCount ?? 0);
  if (!Number.isFinite(imageCount) || imageCount <= 0 || imageCount > 10) return [];
  const dir = path.dirname(filePath);
  const prefix = `${path.basename(filePath, path.extname(filePath))}__`;
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => name.startsWith(prefix) && /\.(jpe?g|png|webp|gif|heic)$/i.test(name))
      .sort()
      .slice(0, 10)
      .map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

function increment(map, key) {
  if (!key) return;
  map.set(key, (map.get(key) ?? 0) + 1);
}

function decrement(map, key) {
  if (!key) return;
  const next = (map.get(key) ?? 1) - 1;
  if (next > 0) map.set(key, next);
  else map.delete(key);
}

function sumCounts(map) {
  let total = 0;
  for (const value of map.values()) total += value;
  return total;
}
