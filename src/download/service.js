import path from 'node:path';
import { readdir, rm } from 'node:fs/promises';
import {
  detectPlatform,
  normalizePlatformHandle,
  parsePostReference,
  platformRegistry as defaultPlatformRegistry,
} from '../platforms/index.js';
import { archivePlatformDownload } from '../platforms/archive.js';
import { extractVideoId, fileSize, makePublicFileUrl, randomToken } from '../util/files.js';

const DEFAULT_MAX_QUEUE_SIZE = 50;
const DEFAULT_MAX_PER_USER = 3;
const DEFAULT_MAX_PER_GUILD = 12;

export class DownloadService {
  constructor({
    config,
    store,
    metadataFetcher = null,
    downloader = null,
    platformRegistry = defaultPlatformRegistry,
    platformProbers = {},
    platformDownloaders = {},
    now = () => Date.now(),
    logger = console,
  } = {}) {
    if (!config) throw new Error('DownloadService requires config.');
    if (!store) throw new Error('DownloadService requires store.');
    this.config = config;
    this.store = store;
    this.metadataFetcher = metadataFetcher;
    this.downloader = downloader;
    this.platformRegistry = platformRegistry;
    this.platformProbers = new Map(Object.entries(platformProbers ?? {}));
    this.platformDownloaders = new Map(Object.entries(platformDownloaders ?? {}));
    if (typeof metadataFetcher === 'function') {
      this.platformProbers.set('tiktok', (sourceUrl, options = {}) => (
        metadataFetcher(sourceUrl, options.config ?? this.config)
      ));
    }
    if (typeof downloader === 'function') this.platformDownloaders.set('tiktok', downloader);
    this.now = now;
    this.logger = logger ?? console;
    this.concurrency = Math.max(1, Number(config.maxConcurrentDownloads) || 1);
    this.maxQueueSize = Math.max(1, Number(config.maxDownloadQueueSize) || DEFAULT_MAX_QUEUE_SIZE);
    this.maxPerUser = Math.max(1, Number(config.maxQueuedDownloadsPerUser) || DEFAULT_MAX_PER_USER);
    this.maxPerGuild = Math.max(1, Number(config.maxQueuedDownloadsPerGuild) || DEFAULT_MAX_PER_GUILD);
  }

  #queue = [];
  #active = 0;
  #admitted = 0;
  #identityInFlight = new Map();
  #downloadInFlight = new Map();
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
    const source = resolveDownloadSource(resolvedSourceUrl, this.platformRegistry);
    const validatedSourceUrl = source.canonicalUrl;

    const reservation = this.#reserveRequest({ type, requestedBy, guildId });
    let jobId = null;
    try {
      const initialVideoId = String(
        providedMetadata?.id
          || providedMetadata?.remoteId
          || source.reference?.remoteId
          || extractVideoId(validatedSourceUrl)
          || '',
      );
      jobId = this.store.createJob({
        type,
        status: 'queued',
        platform: source.platform,
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
        platform: source.platform,
        adapter: source.adapter,
        reference: source.reference,
        username,
        metadata: providedMetadata,
      });
      if (!createDelivery) {
        this.store.updateJob(jobId, {
          status: 'complete',
          platform: asset.platform,
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
        platform: result.platform,
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
    if (type === 'monitor' && permanent) {
      const existing = this.store.getPermanentMonitorDeliveryForFile?.(asset.fileId, { scopeId });
      if (existing?.token) {
        return {
          ...asset,
          jobId: existing.job_id == null ? null : Number(existing.job_id),
          token: existing.token,
          publicUrl: makePublicFileUrl(this.config, existing.token),
          delivery,
          linkPermanent: true,
          reused: Boolean(asset.reused),
          deliveryReused: true,
        };
      }
    }
    const jobId = this.store.createJob({
      type,
      status: 'complete',
      platform: asset.platform || 'tiktok',
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
      deliveryReused: false,
    };
  }

  status() {
    return {
      concurrency: this.concurrency,
      active: this.#active,
      queued: Math.max(0, this.#admitted - this.#active),
      admitted: this.#admitted,
      workQueued: this.#queue.length,
      inFlightAssets: this.#downloadInFlight.size,
      identityInFlight: this.#identityInFlight.size,
      pendingUsers: sumCounts(this.#pendingByUser),
      pendingGuilds: sumCounts(this.#pendingByGuild),
    };
  }

  async waitForIdle() {
    while (this.#admitted || this.#active || this.#queue.length || this.#downloadInFlight.size || this.#identityInFlight.size) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  #reserveRequest({ type, requestedBy, guildId }) {
    if (this.#admitted >= this.maxQueueSize) {
      throw new Error('The download queue is full. Please try again shortly.');
    }
    const appliesRequesterLimits = type !== 'monitor';
    const userKey = appliesRequesterLimits ? String(requestedBy ?? '') : '';
    const guildKey = appliesRequesterLimits ? String(guildId ?? '') : '';
    if (userKey && (this.#pendingByUser.get(userKey) ?? 0) >= this.maxPerUser) {
      throw new Error(`You already have ${this.maxPerUser} download request(s) in progress.`);
    }
    if (guildKey && (this.#pendingByGuild.get(guildKey) ?? 0) >= this.maxPerGuild) {
      throw new Error(`This server already has ${this.maxPerGuild} download request(s) in progress.`);
    }
    this.#admitted += 1;
    increment(this.#pendingByUser, userKey);
    increment(this.#pendingByGuild, guildKey);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.#admitted = Math.max(0, this.#admitted - 1);
        decrement(this.#pendingByUser, userKey);
        decrement(this.#pendingByGuild, guildKey);
      },
    };
  }

  async #getAsset(input) {
    const metadata = await this.#resolveMetadata(input);
    const key = canonicalDownloadKey(input.sourceUrl, metadata, input.platform);
    const existing = this.#downloadInFlight.get(key);
    if (existing) return existing;

    const promise = this.#enqueue(() => this.#materializeAsset(input, metadata))
      .finally(() => {
        if (this.#downloadInFlight.get(key) === promise) this.#downloadInFlight.delete(key);
      });
    this.#downloadInFlight.set(key, promise);
    return promise;
  }

  #resolveMetadata(input) {
    if (input.metadata) {
      return Promise.resolve(normalizePlatformMetadata(input.metadata, input));
    }
    if (input.adapter?.capabilities?.probeBeforeDownload === false && input.reference?.remoteId) {
      return Promise.resolve(normalizePlatformMetadata({
        id: input.reference.remoteId,
        remoteId: input.reference.remoteId,
        webpage_url: input.reference.canonicalUrl || input.sourceUrl,
      }, input));
    }

    const identityKey = canonicalDownloadKey(input.sourceUrl, null, input.platform);
    const existing = this.#identityInFlight.get(identityKey);
    if (existing) return existing;

    const platformProbe = this.platformProbers.get(input.platform)
      || (typeof input.adapter?.probe === 'function'
        ? (sourceUrl, options) => input.adapter.probe(sourceUrl, options)
        : null);
    const metadataOperation = typeof platformProbe === 'function'
      ? () => platformProbe(input.sourceUrl, {
        config: this.config,
        platform: input.platform,
        reference: input.reference,
      })
      : null;
    if (!metadataOperation) {
      throw new Error(`${displayPlatform(input.platform)} metadata extraction is not configured.`);
    }

    const promise = this.#enqueue(metadataOperation)
      .then((metadata) => normalizePlatformMetadata(metadata, input))
      .finally(() => {
        if (this.#identityInFlight.get(identityKey) === promise) this.#identityInFlight.delete(identityKey);
      });
    this.#identityInFlight.set(identityKey, promise);
    return promise;
  }

  async #materializeAsset(input, metadata) {
    const { sourceUrl, platform, requestedUsername = input.username } = input;
    const resolvedUsername = requestedUsername || metadata?.uploader || metadata?.channel || '';
    const downloadMetadata = resolvedUsername
      ? { ...metadata, uploader: resolvedUsername, username: resolvedUsername }
      : metadata;
    const existing = await this.#findReusableDownload(downloadMetadata, platform, input.adapter);
    if (existing) {
      return this.#resultFromExistingAsset(
        existing,
        downloadMetadata,
        sourceUrl,
        resolvedUsername,
        platform,
        input.adapter,
      );
    }

    const platformDownloader = this.platformDownloaders.get(platform)
      || (typeof input.adapter?.download === 'function'
        ? (downloadUrl, options) => input.adapter.download(downloadUrl, options)
        : null);
    if (typeof platformDownloader !== 'function') {
      throw new Error(`${displayPlatform(platform)} downloads are not configured on this server.`);
    }
    const downloaded = await platformDownloader(sourceUrl, {
      ...this.config,
      metadata: downloadMetadata,
      downloadDir: this.config.downloadDir,
      keepSlideshowImages: true,
      platform,
      reference: input.reference,
    });
    const archiveOwnedStaging = input.adapter?.capabilities?.archiveOwnedStaging === true;
    const archived = archiveOwnedStaging && downloaded?.outputDir
      ? await archivePlatformDownload(downloaded, {
        downloadDir: this.config.downloadDir,
        now: this.now(),
      })
      : downloaded;
    const extracted = archived?.post && typeof archived.post === 'object'
      ? { ...archived.post, ...archived }
      : archived;
    const assets = normalizeDownloadedAssets(
      extracted?.assets,
      extracted?.slideshowImagePaths,
    );
    const filePath = extracted?.filePath || extracted?.bundlePath || assets[0]?.path || '';
    if (!filePath) throw new Error(`${displayPlatform(platform)} extraction completed without a saved media file.`);
    const sizeBytes = extracted.sizeBytes ?? await fileSize(filePath);
    const filename = extracted.filename || path.basename(filePath);
    const videoId = String(
      extracted.remoteId
        || extracted.videoId
        || extracted.id
        || downloadMetadata.remoteId
        || downloadMetadata.id
        || '',
    );
    const extractedUsername = extracted.username
      || extracted.uploader
      || extracted.creator?.handle
      || '';
    const finalUsername = input.adapter?.capabilities?.preferRequestedCreatorHandle === true
      ? resolvedUsername || extractedUsername
      : extractedUsername || resolvedUsername;
    const profile = this.#persistPlatformProfile({
      platform,
      reference: input.reference,
      extracted,
      username: finalUsername,
    });
    const fileRecord = {
      platform,
      videoId,
      username: finalUsername,
      sourceUrl,
      filePath,
      filename,
      sizeBytes,
    };
    const mediaType = extracted.mediaType || downloadMetadata.mediaType || inferMediaType(assets);
    const publishedAt = extracted.publishedAt ?? extracted.timestamp ?? downloadMetadata.timestamp;
    const duration = downloadMetadata.duration ?? extracted.duration;
    const mediaRecord = {
      platform,
      remoteId: videoId,
      profileId: profile?.id ?? null,
      canonicalUrl: input.reference?.canonicalUrl || sourceUrl,
      sourceUrl,
      creatorHandle: finalUsername,
      creatorRemoteId: extracted.creator?.remoteId
        || extracted.creator?.id
        || extracted.creatorRemoteId
        || extracted.ownerId
        || '',
      title: downloadMetadata.title || extracted.title || '',
      description: downloadMetadata.description || extracted.description || extracted.caption || '',
      mediaType,
      publishedAt,
      duration,
      metadata: buildPersistedMediaMetadata({
        platform,
        remoteId: videoId,
        profile,
        creatorHandle: finalUsername,
        extracted,
        mediaType,
        publishedAt,
        duration,
        assetCount: Math.max(assets.length, filePath ? 1 : 0),
      }),
      assets,
      filePath,
      filename,
      sizeBytes,
    };
    const persistedAt = this.now();
    let fileId;
    if (typeof this.store.createFileWithMedia === 'function') {
      try {
        ({ fileId } = this.store.createFileWithMedia({ file: fileRecord, media: mediaRecord }, persistedAt));
      } catch (error) {
        if (
          archiveOwnedStaging
          && archived !== downloaded
          && archiveIsConfirmedUnpersisted(this.store, platform, videoId, filePath, this.logger)
        ) {
          await removeOwnedArchiveDirectory(this.config.downloadDir, extracted.outputDir, this.logger);
        }
        throw error;
      }
    } else {
      fileId = this.store.createFileRecord(fileRecord, persistedAt);
      if (typeof this.store.recordMediaDownload === 'function') {
        this.store.recordMediaDownload({ ...mediaRecord, fileId }, persistedAt);
      }
    }
    return {
      ...extracted,
      ...downloadMetadata,
      platform,
      fileId,
      sourceUrl,
      filePath,
      primaryFile: extracted.primaryFile || assets[0]?.path || filePath,
      filename,
      sizeBytes,
      videoId,
      remoteId: videoId,
      username: finalUsername,
      title: downloadMetadata.title || extracted.title || '',
      description: downloadMetadata.description || extracted.description || extracted.caption || '',
      thumbnailUrl: downloadMetadata.thumbnail || extracted.thumbnailUrl || extracted.thumbnail || '',
      mediaType: extracted.mediaType || downloadMetadata.mediaType || inferMediaType(assets),
      duration: Number(downloadMetadata.duration ?? extracted.duration ?? 0) || 0,
      assets,
      reused: false,
    };
  }

  #persistPlatformProfile({ platform, reference, extracted, username }) {
    if (!username || typeof this.store.upsertPlatformProfile !== 'function') return null;
    let handle;
    try {
      handle = normalizePlatformHandle(platform, username);
    } catch {
      return null;
    }
    try {
      return this.store.upsertPlatformProfile({
        platform,
        remoteId: extracted.creator?.remoteId
          || extracted.creator?.id
          || extracted.creatorRemoteId
          || extracted.ownerId
          || null,
        handle,
        displayName: extracted.creator?.displayName
          || extracted.creator?.name
          || extracted.displayName
          || '',
        profileUrl: extracted.creator?.profileUrl
          || extracted.profileUrl
          || profileUrlFromReference(platform, handle, reference),
      }, this.now());
    } catch (error) {
      this.logger?.warn?.(`[downloads] Could not persist ${displayPlatform(platform)} profile @${handle}: ${error?.message ?? error}`);
      return null;
    }
  }

  async #findReusableDownload(metadata, platform = 'tiktok', adapter = null) {
    const videoId = metadata?.id || metadata?.videoId || '';
    const existing = typeof this.store.getLatestFileByPost === 'function'
      ? this.store.getLatestFileByPost(platform, videoId)
      : adapter?.capabilities?.legacyVideoIdentity === true
        ? this.store.getLatestFileByVideoId(videoId)
        : null;
    if (!existing) return null;
    try {
      return { ...existing, size_bytes: await fileSize(existing.path) };
    } catch {
      return null;
    }
  }

  async #resultFromExistingAsset(fileRecord, metadata, sourceUrl, username, platform = 'tiktok', adapter = null) {
    const storedPost = typeof this.store.getMediaPost === 'function'
      ? this.store.getMediaPost(platform, metadata?.id || fileRecord.video_id || '')
      : null;
    const storedAssets = typeof this.store.listMediaAssetsForFile === 'function'
      ? this.store.listMediaAssetsForFile(fileRecord.id).map(normalizeStoredAsset)
      : [];
    const contentAssets = storedAssets.filter((asset) => asset.role === 'content');
    const storedPublishedAt = storedPost?.published_at == null
      ? null
      : new Date(Number(storedPost.published_at)).toISOString();
    return {
      ...metadata,
      platform,
      fileId: fileRecord.id,
      sourceUrl,
      filePath: fileRecord.path,
      primaryFile: fileRecord.path,
      filename: fileRecord.filename || path.basename(fileRecord.path),
      sizeBytes: Number(fileRecord.size_bytes || 0),
      videoId: metadata?.id || fileRecord.video_id || '',
      remoteId: metadata?.id || fileRecord.video_id || '',
      username: adapter?.capabilities?.preferRequestedCreatorHandle === true
        ? username || metadata?.uploader || metadata?.channel || storedPost?.creator_handle || fileRecord.username || ''
        : storedPost?.creator_handle || fileRecord.username || metadata?.uploader || metadata?.channel || username || '',
      title: metadata?.title || storedPost?.title || '',
      description: metadata?.description || storedPost?.description || '',
      thumbnailUrl: metadata?.thumbnail || '',
      mediaType: metadata?.mediaType || storedPost?.media_type || inferMediaType(contentAssets),
      imageCount: metadata?.imageCount ?? contentAssets.filter((asset) => asset.kind === 'image').length,
      publishedAt: metadata?.publishedAt ?? storedPublishedAt,
      slideshowImagePaths: await findSlideshowImagePaths(fileRecord.path, metadata),
      assets: contentAssets,
      assetCount: contentAssets.length,
      duration: Number(metadata?.duration ?? storedPost?.duration_seconds ?? 0) || 0,
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
      void Promise.resolve()
        .then(task.work)
        .then(task.resolve, task.reject)
        .finally(() => {
          this.#active -= 1;
          this.#drainQueue();
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

export function canonicalDownloadKey(sourceUrl, metadata = null, platformInput = '') {
  const reference = parsePostReference(sourceUrl);
  const platform = String(
    platformInput
      || metadata?.platform
      || reference?.platform
      || detectPlatform(sourceUrl)
      || 'unknown',
  ).toLowerCase();
  const videoId = String(
    metadata?.remoteId
      || metadata?.id
      || metadata?.videoId
      || reference?.remoteId
      || (platform === 'tiktok' ? extractVideoId(sourceUrl) : '')
      || '',
  ).trim();
  if (videoId) return `${platform}:post:${encodeURIComponent(videoId)}`;
  try {
    const url = new URL(String(sourceUrl));
    url.search = '';
    url.hash = '';
    return `${platform}:url:${url.toString()}`;
  } catch {
    return `${platform}:url:${String(sourceUrl).trim()}`;
  }
}

export function resolveDownloadSource(value, registry = defaultPlatformRegistry) {
  const match = registry?.forUrl?.(value);
  if (!match) {
    throw new Error('A credential-free HTTPS TikTok, Instagram, or X/Twitter post URL, or a TikTok/Instagram Story URL, is required.');
  }
  const canonicalUrl = match.adapter.canonicalizeUrl(match.url);
  const reference = match.adapter.parsePostReference(match.url);
  if (!reference && !isTikTokShortPostUrl(match.url, match.adapter.platform)) {
    throw new Error('A TikTok, Instagram, or X/Twitter post URL, or a TikTok/Instagram Story URL, is required; profile and feed URLs are not accepted here.');
  }
  return Object.freeze({
    adapter: match.adapter,
    platform: match.adapter.platform,
    canonicalUrl,
    reference,
  });
}

function normalizePlatformMetadata(metadata, input) {
  const value = metadata && typeof metadata === 'object' ? metadata : {};
  return {
    ...value,
    platform: input.platform,
    id: String(value.id || value.remoteId || input.reference?.remoteId || ''),
    remoteId: String(value.remoteId || value.id || input.reference?.remoteId || ''),
    webpage_url: value.webpage_url || value.canonicalUrl || input.reference?.canonicalUrl || input.sourceUrl,
  };
}

function normalizeDownloadedAssets(values, slideshowImagePaths = []) {
  const candidates = Array.isArray(values) && values.length
    ? values
    : Array.isArray(slideshowImagePaths)
      ? slideshowImagePaths.map((assetPath, position) => ({ path: assetPath, position, kind: 'image' }))
      : [];
  return candidates
    .filter((asset) => asset && typeof asset === 'object' && (asset.path || asset.filePath))
    .map((asset, index) => ({
      ...asset,
      position: Number.isInteger(Number(asset.position)) ? Number(asset.position) : index,
      path: String(asset.path || asset.filePath),
      filePath: String(asset.filePath || asset.path),
      filename: asset.filename || path.basename(String(asset.path || asset.filePath)),
    }))
    .sort((a, b) => a.position - b.position);
}

function normalizeStoredAsset(asset = {}) {
  return {
    id: Number(asset.id),
    position: Number(asset.position ?? 0),
    role: String(asset.role ?? 'content'),
    remoteId: String(asset.remote_id ?? ''),
    kind: String(asset.kind ?? ''),
    mimeType: String(asset.mime_type ?? ''),
    path: String(asset.path ?? ''),
    filename: String(asset.filename ?? ''),
    sizeBytes: Number(asset.size_bytes ?? 0),
    width: asset.width == null ? null : Number(asset.width),
    height: asset.height == null ? null : Number(asset.height),
    duration: asset.duration_seconds == null ? null : Number(asset.duration_seconds),
  };
}

function inferMediaType(assets) {
  if (!assets.length) return '';
  const kinds = new Set(assets.map((asset) => asset.kind || asset.mediaType).filter(Boolean));
  if (assets.length > 1 && kinds.size > 1) return 'mixed';
  if (assets.length > 1) return 'gallery';
  return kinds.values().next().value || '';
}

function buildPersistedMediaMetadata({
  platform,
  remoteId,
  profile,
  creatorHandle,
  extracted,
  mediaType,
  publishedAt,
  duration,
  assetCount,
}) {
  const creatorRemoteId = String(
    extracted?.creator?.remoteId
      || extracted?.creator?.id
      || extracted?.creatorRemoteId
      || extracted?.ownerId
      || profile?.remote_id
      || '',
  ).slice(0, 256);
  const displayName = String(
    extracted?.creator?.displayName
      || extracted?.creator?.name
      || extracted?.displayName
      || profile?.display_name
      || '',
  ).slice(0, 512);
  const metadata = {
    schemaVersion: 1,
    platform,
    remoteId: String(remoteId ?? '').slice(0, 256),
    creator: {
      remoteId: creatorRemoteId,
      handle: String(creatorHandle ?? '').slice(0, 200),
      displayName,
    },
    mediaType: String(mediaType ?? '').slice(0, 64),
    assetCount: Math.max(0, Number(assetCount) || 0),
  };
  const timestamp = normalizePersistedTimestamp(publishedAt);
  if (timestamp != null) metadata.publishedAt = timestamp;
  const durationSeconds = Number(duration);
  if (Number.isFinite(durationSeconds) && durationSeconds >= 0) metadata.durationSeconds = durationSeconds;
  return metadata;
}

function normalizePersistedTimestamp(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  const number = Number(value);
  if (Number.isFinite(number) && number >= 0) {
    const milliseconds = number > 10_000_000_000 ? number : number * 1_000;
    const date = new Date(milliseconds);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  const date = new Date(String(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function isTikTokShortPostUrl(url, platform) {
  if (platform !== 'tiktok') return false;
  const host = url.hostname.toLowerCase();
  if (host === 'vm.tiktok.com' || host === 'vt.tiktok.com') {
    return /^\/[A-Za-z0-9_-]+\/?$/.test(url.pathname);
  }
  return /^\/t\/[A-Za-z0-9_-]+\/?$/i.test(url.pathname);
}

function displayPlatform(platform) {
  if (platform === 'x') return 'X/Twitter';
  if (platform === 'instagram') return 'Instagram';
  return platform === 'tiktok' ? 'TikTok' : 'This platform';
}

function profileUrlFromReference(platform, username, reference) {
  if (reference?.creatorHandle === username && reference?.canonicalUrl) {
    if (platform === 'tiktok') return `https://www.tiktok.com/@${username}`;
    if (platform === 'x') return `https://x.com/${username}`;
  }
  if (platform === 'instagram') return `https://www.instagram.com/${username}/`;
  if (platform === 'x') return `https://x.com/${username}`;
  return `https://www.tiktok.com/@${username}`;
}

async function removeOwnedArchiveDirectory(downloadDir, outputDir, logger) {
  const root = path.resolve(String(downloadDir ?? ''));
  const candidate = path.resolve(String(outputDir ?? ''));
  const relative = path.relative(root, candidate);
  if (!outputDir || !relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    logger?.warn?.('[downloads] Refused to remove an unowned archive directory after persistence failed.');
    return;
  }
  try {
    await rm(candidate, { recursive: true, force: true });
  } catch (cleanupError) {
    logger?.warn?.(`[downloads] Could not remove an unpersisted archive directory: ${cleanupError?.message ?? cleanupError}`);
  }
}

function archiveIsConfirmedUnpersisted(store, platform, remoteId, filePath, logger) {
  if (typeof store?.getLatestFileByPost !== 'function') {
    logger?.warn?.('[downloads] Could not confirm whether a failed archive persistence attempt committed; preserving its bytes.');
    return false;
  }
  try {
    const persisted = store.getLatestFileByPost(platform, remoteId);
    return !persisted || path.resolve(String(persisted.path ?? '')) !== path.resolve(String(filePath ?? ''));
  } catch (queryError) {
    logger?.warn?.(`[downloads] Could not confirm whether a failed archive persistence attempt committed; preserving its bytes: ${queryError?.message ?? queryError}`);
    return false;
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
