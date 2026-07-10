import { stat } from 'node:fs/promises';
import { fetchVideoMetadata, listProfileVideos } from '../tiktok/ytdlp.js';
import { normalizeUsername, profileUrl } from '../util/files.js';

const DEFAULT_MAX_DURATION_SECONDS = 120;
const DEFAULT_PROFILE_TIMEOUT_MS = 10 * 60 * 1000;

export class CreatorImportService {
  constructor({
    config,
    store,
    downloadService,
    profileLister = listProfileVideos,
    metadataFetcher = fetchVideoMetadata,
    fileStat = stat,
    now = () => Date.now(),
    logger = console,
  } = {}) {
    if (!config) throw new Error('CreatorImportService requires config.');
    if (!store) throw new Error('CreatorImportService requires store.');
    if (!downloadService?.request) throw new Error('CreatorImportService requires a download service.');
    this.config = config;
    this.store = store;
    this.downloadService = downloadService;
    this.profileLister = profileLister;
    this.metadataFetcher = metadataFetcher;
    this.fileStat = fileStat;
    this.now = now;
    this.logger = logger ?? console;
    this.concurrency = Math.max(1, Number(config.importConcurrency) || 1);
    const recovered = this.store.resumeIncompleteCreatorImports?.(this.now()) ?? [];
    for (const record of recovered) this.#enqueueImport(record);
    this.#drain();
  }

  #queue = [];
  #active = 0;
  #stopping = false;

  start({ username: input, maxDurationSeconds } = {}) {
    if (this.#stopping) throw serviceUnavailableError('Creator imports are stopping.');
    const username = normalizeUsername(input);
    const durationLimit = normalizeDurationLimit(
      maxDurationSeconds,
      this.config.importMaxDurationSeconds,
    );
    const active = this.store.findActiveCreatorImport?.(username);
    if (active) return { import: active, reused: true };

    const id = this.store.createCreatorImport({
      username,
      maxDurationSeconds: durationLimit,
    }, this.now());
    this.#enqueueImport(this.store.getCreatorImport(id));
    this.#drain();
    return { import: this.store.getCreatorImport(id), reused: false };
  }

  get(id) {
    const record = this.store.getCreatorImport(id);
    if (!record) return null;
    return {
      ...record,
      items: this.store.listCreatorImportItems?.(record.id) ?? [],
    };
  }

  list(limit = 20) {
    return this.store.listCreatorImports(limit);
  }

  status() {
    return {
      active: this.#active,
      queued: this.#queue.length,
      concurrency: this.concurrency,
      stopping: this.#stopping,
    };
  }

  async waitForIdle() {
    while (this.#active || this.#queue.length) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  cancel(id) {
    const result = this.store.requestCreatorImportCancel?.(id, this.now())
      ?? { accepted: false, reason: 'not_found', import: null };
    if (result.accepted && result.import?.status === 'canceled') {
      this.#queue = this.#queue.filter((task) => Number(task.id) !== Number(id));
    }
    return result;
  }

  retry(id) {
    if (this.#stopping) throw serviceUnavailableError('Creator imports are stopping.');
    const result = this.store.retryCreatorImport?.(id, this.now())
      ?? { accepted: false, reason: 'not_found', import: null };
    if (result.accepted) {
      this.#enqueueImport(result.import);
      this.#drain();
    }
    return result;
  }

  async stop({ drain = true } = {}) {
    this.#stopping = true;
    this.#queue = [];
    if (drain) await this.waitForIdle();
  }

  #enqueueImport(record) {
    if (!record || this.#queue.some((task) => Number(task.id) === Number(record.id))) return;
    this.#queue.push({
      id: Number(record.id),
      username: String(record.username),
      maxDurationSeconds: Number(record.max_duration_seconds),
    });
  }

  #drain() {
    while (!this.#stopping && this.#active < this.concurrency && this.#queue.length) {
      const task = this.#queue.shift();
      this.#active += 1;
      void this.#run(task)
        .catch((error) => {
          this.logger?.error?.(`[import] @${task.username} failed: ${error instanceof Error ? error.message : String(error)}`);
        })
        .finally(() => {
          this.#active -= 1;
          this.#drain();
        });
    }
  }

  async #run(task) {
    const startedAt = this.now();
    let record = this.store.beginCreatorImport?.(task.id, startedAt);
    if (!record) return;

    try {
      if (this.#stopping) return this.#pause(task.id);
      if (record.discovery_completed_at == null) {
        const profile = await this.profileLister(profileUrl(task.username), {
          ...this.config,
          username: task.username,
          timeoutMs: Math.max(
            1,
            Number(this.config.importProfileTimeoutMs) || DEFAULT_PROFILE_TIMEOUT_MS,
          ),
        });
        const entries = Array.isArray(profile) ? profile : profile?.entries ?? [];
        this.store.checkpointCreatorImportDiscovery(
          task.id,
          entries.map((entry, index) => checkpointItem(entry, index)),
          this.now(),
        );
        record = this.store.getCreatorImport(task.id);
      }

      while (true) {
        if (this.#stopping) return this.#pause(task.id);
        if (this.#cancelRequested(task.id)) {
          this.store.finalizeCanceledCreatorImport?.(task.id, this.now());
          return;
        }
        const item = this.store.claimNextCreatorImportItem?.(task.id, this.now());
        if (!item) break;
        try {
          const outcome = await this.#processItem(task, item);
          this.store.completeCreatorImportItem(item.id, outcome, this.now());
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.store.completeCreatorImportItem(item.id, {
            status: 'failed',
            videoId: item.video_id,
            error: message,
          }, this.now());
          this.logger?.warn?.(`[import] @${task.username} item failed: ${message}`);
        }
      }

      if (this.#cancelRequested(task.id)) {
        this.store.finalizeCanceledCreatorImport?.(task.id, this.now());
        return;
      }
      if (this.#stopping) return this.#pause(task.id);
      const completedAt = this.now();
      this.store.updateCreatorImport(task.id, {
        status: 'completed',
        completed_at: completedAt,
      }, completedAt);
    } catch (error) {
      if (this.#stopping) return this.#pause(task.id);
      if (this.#cancelRequested(task.id)) {
        this.store.finalizeCanceledCreatorImport?.(task.id, this.now());
        return;
      }
      const completedAt = this.now();
      this.store.updateCreatorImport(task.id, {
        status: 'failed',
        last_error: error instanceof Error ? error.message : String(error),
        completed_at: completedAt,
      }, completedAt);
      throw error;
    }
  }

  async #processItem(task, item) {
    let metadata = parseCheckpointMetadata(item.metadata_json);
    let videoId = String(metadata.id || metadata.videoId || item.video_id || '');
    if (videoId && await this.#isSaved(videoId)) {
      return { status: 'skipped_existing', videoId };
    }

    const sourceUrl = String(item.source_url || sourceUrlFromEntry(metadata)).trim();
    if (!sourceUrl) throw new Error('Profile entry did not include a video URL.');

    let duration = normalizeDuration(metadata.duration);
    if (isUnknownDuration(duration, metadata.mediaType)) {
      metadata = await this.metadataFetcher(sourceUrl, this.config);
      videoId = String(metadata.id || metadata.videoId || videoId);
      if (videoId && await this.#isSaved(videoId)) {
        return { status: 'skipped_existing', videoId };
      }
      duration = normalizeDuration(metadata.duration);
    }

    if (isUnknownDuration(duration, metadata.mediaType)) {
      return {
        status: 'skipped_unknown_duration',
        videoId,
        error: 'Duration remained unavailable after metadata lookup.',
      };
    }
    if (duration > task.maxDurationSeconds) {
      return { status: 'skipped_duration', videoId, durationSeconds: duration };
    }

    const result = await this.downloadService.request(sourceUrl, {
      type: 'import',
      username: task.username,
      metadata,
      permanent: true,
      scopeId: `import:${task.username.toLowerCase()}`,
    });
    return {
      status: result?.reused ? 'skipped_existing' : 'downloaded',
      videoId,
      durationSeconds: duration,
      fileId: result?.fileId ?? null,
    };
  }

  async #isSaved(videoId) {
    const existing = this.store.getLatestFileByVideoId(videoId, { includeTrashed: true });
    if (!existing?.path) return false;
    try {
      const info = await this.fileStat(existing.path);
      return info.isFile();
    } catch {
      return false;
    }
  }

  #cancelRequested(importId) {
    const record = this.store.getCreatorImport(importId);
    return record?.status === 'canceled' || record?.cancel_requested_at != null;
  }

  #pause(importId) {
    this.store.pauseCreatorImport?.(importId, this.now());
  }
}

export function createCreatorImportService(options = {}) {
  return new CreatorImportService(options);
}

export function normalizeDurationLimit(value, fallback = DEFAULT_MAX_DURATION_SECONDS) {
  const resolvedFallback = Math.max(1, Math.min(3_600, Number(fallback) || DEFAULT_MAX_DURATION_SECONDS));
  if (value == null || value === '') return resolvedFallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 3_600) {
    throw new Error('Maximum duration must be between 1 and 3600 seconds.');
  }
  return Math.round(parsed);
}

function normalizeDuration(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function isUnknownDuration(duration, mediaType) {
  return duration == null || (duration === 0 && String(mediaType ?? '').toLowerCase() !== 'slideshow');
}

function checkpointItem(entry, index) {
  const metadata = entry && typeof entry === 'object' ? entry : {};
  const videoId = String(metadata.id || metadata.videoId || '');
  const sourceUrl = sourceUrlFromEntry(metadata);
  const itemKey = videoId
    ? `video:${videoId}`
    : sourceUrl
      ? `url:${sourceUrl}`
      : `position:${index + 1}`;
  return {
    itemKey,
    position: index + 1,
    videoId,
    sourceUrl,
    title: String(metadata.title ?? ''),
    metadataJson: serializeCheckpointMetadata(metadata),
  };
}

function sourceUrlFromEntry(metadata = {}) {
  return String(
    metadata.webpage_url
      || metadata.videoUrl
      || metadata.url
      || metadata.sourceUrl
      || '',
  ).trim();
}

function serializeCheckpointMetadata(metadata) {
  try {
    const serialized = JSON.stringify(metadata ?? {});
    if (serialized.length <= 100_000) return serialized;
  } catch {
    // Fall through to a bounded metadata subset.
  }
  return JSON.stringify({
    id: metadata?.id ?? metadata?.videoId ?? '',
    videoId: metadata?.videoId ?? metadata?.id ?? '',
    webpage_url: sourceUrlFromEntry(metadata),
    title: metadata?.title ?? '',
    duration: metadata?.duration ?? null,
    mediaType: metadata?.mediaType ?? '',
    uploader: metadata?.uploader ?? metadata?.username ?? '',
  });
}

function parseCheckpointMetadata(value) {
  try {
    const parsed = JSON.parse(String(value ?? '{}'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function serviceUnavailableError(message) {
  return Object.assign(new Error(message), { statusCode: 503 });
}
