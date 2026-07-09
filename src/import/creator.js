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
    this.store.failIncompleteCreatorImports?.(this.now());
  }

  #queue = [];
  #active = 0;

  start({ username: input, maxDurationSeconds } = {}) {
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
    this.#queue.push({ id, username, maxDurationSeconds: durationLimit });
    this.#drain();
    return { import: this.store.getCreatorImport(id), reused: false };
  }

  get(id) {
    return this.store.getCreatorImport(id);
  }

  list(limit = 20) {
    return this.store.listCreatorImports(limit);
  }

  status() {
    return { active: this.#active, queued: this.#queue.length, concurrency: this.concurrency };
  }

  async waitForIdle() {
    while (this.#active || this.#queue.length) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  #drain() {
    while (this.#active < this.concurrency && this.#queue.length) {
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
    this.store.updateCreatorImport(task.id, { status: 'running', started_at: startedAt }, startedAt);
    const counts = {
      discovered_count: 0,
      processed_count: 0,
      downloaded_count: 0,
      skipped_existing_count: 0,
      skipped_duration_count: 0,
      failed_count: 0,
      last_error: null,
    };

    try {
      const profile = await this.profileLister(profileUrl(task.username), {
        ...this.config,
        username: task.username,
        timeoutMs: Math.max(
          1,
          Number(this.config.importProfileTimeoutMs) || DEFAULT_PROFILE_TIMEOUT_MS,
        ),
      });
      const entries = Array.isArray(profile) ? profile : profile?.entries ?? [];
      counts.discovered_count = entries.length;
      this.store.updateCreatorImport(task.id, counts, this.now());

      for (const entry of entries) {
        try {
          await this.#processEntry(task, entry, counts);
        } catch (error) {
          counts.failed_count += 1;
          counts.last_error = error instanceof Error ? error.message : String(error);
          this.logger?.warn?.(`[import] @${task.username} item failed: ${counts.last_error}`);
        } finally {
          counts.processed_count += 1;
          this.store.updateCreatorImport(task.id, counts, this.now());
        }
      }

      const completedAt = this.now();
      this.store.updateCreatorImport(task.id, {
        ...counts,
        status: 'completed',
        completed_at: completedAt,
      }, completedAt);
    } catch (error) {
      const completedAt = this.now();
      this.store.updateCreatorImport(task.id, {
        ...counts,
        status: 'failed',
        last_error: error instanceof Error ? error.message : String(error),
        completed_at: completedAt,
      }, completedAt);
      throw error;
    }
  }

  async #processEntry(task, entry, counts) {
    let metadata = entry && typeof entry === 'object' ? entry : {};
    let videoId = String(metadata.id || metadata.videoId || '');
    if (videoId && await this.#isSaved(videoId)) {
      counts.skipped_existing_count += 1;
      return;
    }

    const sourceUrl = String(
      metadata.webpage_url
        || metadata.videoUrl
        || metadata.url
        || metadata.sourceUrl
        || '',
    ).trim();
    if (!sourceUrl) throw new Error('Profile entry did not include a video URL.');

    let duration = normalizeDuration(metadata.duration);
    if (duration == null || (duration === 0 && metadata.mediaType !== 'slideshow')) {
      metadata = await this.metadataFetcher(sourceUrl, this.config);
      videoId = String(metadata.id || metadata.videoId || videoId);
      if (videoId && await this.#isSaved(videoId)) {
        counts.skipped_existing_count += 1;
        return;
      }
      duration = normalizeDuration(metadata.duration);
    }

    if (duration != null && duration > task.maxDurationSeconds) {
      counts.skipped_duration_count += 1;
      return;
    }

    const result = await this.downloadService.request(sourceUrl, {
      type: 'import',
      username: task.username,
      metadata,
      permanent: true,
      scopeId: `import:${task.username.toLowerCase()}`,
    });
    if (result?.reused) counts.skipped_existing_count += 1;
    else counts.downloaded_count += 1;
  }

  async #isSaved(videoId) {
    const existing = this.store.getLatestFileByVideoId(videoId);
    if (!existing?.path) return false;
    try {
      const info = await this.fileStat(existing.path);
      return info.isFile();
    } catch {
      return false;
    }
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
