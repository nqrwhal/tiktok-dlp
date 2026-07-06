import { extractVideoId, normalizeUsername, profileUrl as makeProfileUrl, storyUrl as makeStoryUrl } from '../util/files.js';

const DEFAULT_POLL_INTERVAL_MS = 60 * 1000;
const DEFAULT_SCAN_LIMIT = 5;
const DEFAULT_BURST_SCAN_LIMIT = 20;
const DEFAULT_CHECK_CONCURRENCY = 2;
const DEFAULT_DOWNLOAD_CONCURRENCY = 1;
const DEFAULT_BACKOFF_BASE_MS = 60 * 1000;
const DEFAULT_BACKOFF_MAX_MS = 60 * 60 * 1000;
const DELETION_CHECK_DELAYS_MS = [
  60 * 1000,
  60 * 1000,
  60 * 1000,
  60 * 1000,
  60 * 1000,
  25 * 60 * 1000,
  30 * 60 * 1000,
  23 * 60 * 60 * 1000,
  24 * 60 * 60 * 1000,
  7 * 24 * 60 * 60 * 1000,
];

export function normalizeWatchedUser(input) {
  const username = normalizeUsername(input?.username ?? input?.profile_url ?? input?.profileUrl ?? input?.url ?? input);
  return {
    username,
    profileUrl: makeProfileUrl(username),
    storyUrl: makeStoryUrl(username),
  };
}

export function resolveVideoId(video) {
  return String(
    video?.id
      ?? video?.video_id
      ?? extractVideoId(video?.webpage_url ?? video?.original_url ?? video?.url ?? video?.source_url ?? '')
      ?? '',
  ).trim();
}

export function resolveVideoSourceUrl(video, fallbackUrl = '') {
  return String(video?.webpage_url ?? video?.original_url ?? video?.url ?? video?.source_url ?? fallbackUrl ?? '').trim();
}

export function resolveVideoTimestampMs(video) {
  const numericTimestamp = Number(video?.timestamp ?? video?.release_timestamp ?? 0);
  if (Number.isFinite(numericTimestamp) && numericTimestamp > 0) {
    return numericTimestamp > 10_000_000_000 ? numericTimestamp : numericTimestamp * 1000;
  }

  const uploadDate = String(video?.upload_date ?? '');
  if (/^\d{8}$/.test(uploadDate)) {
    const yyyy = Number(uploadDate.slice(0, 4));
    const mm = Number(uploadDate.slice(4, 6));
    const dd = Number(uploadDate.slice(6, 8));
    return Date.UTC(yyyy, mm - 1, dd);
  }

  for (const value of [video?.created_at, video?.date, video?.uploadDate]) {
    const parsed = Date.parse(String(value ?? ''));
    if (Number.isFinite(parsed)) return parsed;
  }

  return null;
}

export function isVideoNewerThanWatch(video, watch) {
  const watchCreatedAt = Number(watch?.created_at ?? 0);
  if (!watchCreatedAt) return true;

  const videoTimestampMs = resolveVideoTimestampMs(video);
  if (!videoTimestampMs) return true;

  return videoTimestampMs > watchCreatedAt;
}

export function shouldBaselineVideoWithoutAlert(video, watch) {
  if (resolveVideoMediaType(video) === 'story') return false;

  const watchCreatedAt = Number(watch?.created_at ?? 0);
  if (!watchCreatedAt) return false;

  const videoTimestampMs = resolveVideoTimestampMs(video);
  if (videoTimestampMs) return videoTimestampMs <= watchCreatedAt;

  return !watch?.last_success_at;
}

export function calculateFailureBackoffMs(failureCount, { baseMs = DEFAULT_BACKOFF_BASE_MS, maxMs = DEFAULT_BACKOFF_MAX_MS } = {}) {
  const attempts = Math.max(1, Number(failureCount ?? 0) + 1);
  return Math.min(maxMs, baseMs * (2 ** (attempts - 1)));
}

export function nextDeletionCheckDelayMs(completedChecks = 0) {
  const index = Math.max(0, Number(completedChecks) || 0);
  return DELETION_CHECK_DELAYS_MS[Math.min(index, DELETION_CHECK_DELAYS_MS.length - 1)];
}

export function resolveProfileUsername(profileResult, fallbackUsername = '') {
  const metadata = Array.isArray(profileResult) ? {} : profileResult?.metadata ?? {};
  const entries = Array.isArray(profileResult) ? profileResult : profileResult?.entries ?? [];
  const candidates = [
    metadata.uploader,
    metadata.channel,
    metadata.creator,
    metadata.username,
    entries[0]?.uploader,
    entries[0]?.channel,
    entries[0]?.creator,
    entries[0]?.username,
    fallbackUsername,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return normalizeUsername(candidate);
    } catch {
      // Try the next metadata field.
    }
  }
  return fallbackUsername;
}

export function resolveProfileCreatorId(profileResult) {
  const metadata = Array.isArray(profileResult) ? {} : profileResult?.metadata ?? {};
  const entries = Array.isArray(profileResult) ? profileResult : profileResult?.entries ?? [];
  return resolveProfileAuthorId(profileResult)
    || resolveProfileSecUid(profileResult)
    || String(
      metadata.uploader_id
        ?? metadata.channel_id
        ?? metadata.creator_id
        ?? metadata.user_id
        ?? entries[0]?.uploader_id
        ?? entries[0]?.channel_id
        ?? entries[0]?.creator_id
        ?? entries[0]?.user_id
        ?? '',
    ).trim();
}

export function resolveProfileSecUid(profileResult) {
  const metadata = Array.isArray(profileResult) ? {} : profileResult?.metadata ?? {};
  const entries = Array.isArray(profileResult) ? profileResult : profileResult?.entries ?? [];
  const value = String(
    metadata.secUid
      ?? metadata.sec_uid
      ?? metadata.channel_id
      ?? entries[0]?.channel_id
      ?? '',
  ).trim();
  return /^MS4wLjABAAAA[\w-]{64}$/.test(value) ? value : '';
}

export function resolveProfileAuthorId(profileResult) {
  const metadata = Array.isArray(profileResult) ? {} : profileResult?.metadata ?? {};
  const entries = Array.isArray(profileResult) ? profileResult : profileResult?.entries ?? [];
  const value = String(
    metadata.author_id
      ?? metadata.user_id
      ?? metadata.uploader_id
      ?? metadata.creator_id
      ?? entries[0]?.author_id
      ?? entries[0]?.user_id
      ?? entries[0]?.uploader_id
      ?? entries[0]?.creator_id
      ?? '',
  ).trim();
  return /^\d{10,}$/.test(value) ? value : '';
}

export function resolveVideoMediaType(video) {
  const explicit = String(video?.mediaType ?? video?.media_type ?? video?.type ?? '').toLowerCase();
  if (explicit.includes('story')) return 'story';
  if (explicit.includes('slideshow') || explicit.includes('photo')) return 'slideshow';
  const sourceUrl = String(video?.webpage_url ?? video?.original_url ?? video?.url ?? video?.source_url ?? video?.sourceUrl ?? '').toLowerCase();
  if (/\/story(\/|$)/.test(sourceUrl)) return 'story';
  if (/\/photo(\/|$)/.test(sourceUrl)) return 'slideshow';
  return '';
}

function resolveMethod(target, names) {
  for (const name of names) {
    if (typeof target?.[name] === 'function') return target[name].bind(target);
  }
  throw new Error(`Downloader is missing a required method: ${names.join(' or ')}`);
}

function resolveOptionalMethod(target, names) {
  for (const name of names) {
    if (typeof target?.[name] === 'function') return target[name].bind(target);
  }
  return null;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mergeSummary(target, partial = {}) {
  for (const key of [
    'watchedUsers',
    'skippedUsers',
    'scannedVideos',
    'queuedDownloads',
    'downloadedVideos',
    'alertedVideos',
    'seenVideos',
    'failures',
  ]) {
    target[key] = Number(target[key] ?? 0) + Number(partial[key] ?? 0);
  }
}

async function runWithConcurrency(items, concurrency, worker) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(Math.max(1, Number(concurrency) || 1), queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      await worker(item);
    }
  });
  await Promise.all(workers);
}

function shouldRecordStoryIdentity(storyResult, normalized, watch) {
  const secUid = resolveProfileSecUid(storyResult);
  const authorId = resolveProfileAuthorId(storyResult);
  const username = resolveProfileUsername(storyResult, normalized.username);
  return Boolean(
    (secUid && secUid !== String(watch?.sec_uid ?? watch?.secUid ?? ''))
      || (authorId && authorId !== String(watch?.author_id ?? watch?.authorId ?? ''))
      || (username && username.toLowerCase() !== normalized.username.toLowerCase()),
  );
}

export class TikTokMonitor {
  constructor({
    store,
    downloader,
    alert = async () => {},
    deletionAlert = async () => {},
    usernameChangeAlert = async () => {},
    logger = console,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    scanLimit = DEFAULT_SCAN_LIMIT,
    burstScanLimit = DEFAULT_BURST_SCAN_LIMIT,
    checkConcurrency = DEFAULT_CHECK_CONCURRENCY,
    downloadConcurrency = DEFAULT_DOWNLOAD_CONCURRENCY,
    backoffBaseMs = DEFAULT_BACKOFF_BASE_MS,
    backoffMaxMs = DEFAULT_BACKOFF_MAX_MS,
    now = () => Date.now(),
    sleep = defaultSleep,
  } = {}) {
    if (!store) throw new Error('A store instance is required.');
    if (!downloader) throw new Error('A downloader instance is required.');

    this.store = store;
    this.downloader = downloader;
    this.alert = alert;
    this.deletionAlert = deletionAlert;
    this.usernameChangeAlert = usernameChangeAlert;
    this.logger = logger ?? console;
    this.pollIntervalMs = pollIntervalMs;
    this.scanLimit = Math.max(1, Number(scanLimit) || DEFAULT_SCAN_LIMIT);
    this.burstScanLimit = Math.max(this.scanLimit, Number(burstScanLimit) || DEFAULT_BURST_SCAN_LIMIT);
    this.checkConcurrency = Math.max(1, Number(checkConcurrency) || DEFAULT_CHECK_CONCURRENCY);
    this.downloadConcurrency = Math.max(1, Number(downloadConcurrency) || DEFAULT_DOWNLOAD_CONCURRENCY);
    this.backoffBaseMs = backoffBaseMs;
    this.backoffMaxMs = backoffMaxMs;
    this.now = now;
    this.sleep = sleep;

    this.#listProfileVideos = resolveMethod(downloader, ['listProfileVideos']);
    this.#listProfileStories = resolveOptionalMethod(downloader, ['listProfileStories', 'listStories']);
    this.#downloadVideo = resolveMethod(downloader, ['download', 'downloadVideo']);
    this.#checkVideoAvailable = resolveOptionalMethod(downloader, ['checkVideoAvailable', 'isVideoAvailable']);
  }

  #running = false;
  #timer = null;
  #lastPollAt = null;
  #listProfileVideos;
  #listProfileStories;
  #downloadVideo;
  #checkVideoAvailable;
  #downloadQueue = [];
  #activeDownloads = 0;
  #pendingDownloadIds = new Set();
  #metrics = {
    cycles: 0,
    totalChecks: 0,
    totalFailures: 0,
    totalQueuedDownloads: 0,
    totalCompletedDownloads: 0,
    totalDownloadFailures: 0,
    lastCycleStartedAt: null,
    lastCycleFinishedAt: null,
    lastCycleDurationMs: 0,
    lastSummary: null,
    lastError: '',
  };

  start() {
    if (this.#running) return this;
    this.#running = true;
    this.#schedule(0);
    return this;
  }

  stop() {
    this.#running = false;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    return this;
  }

  async runOnce({ waitForDownloads = false } = {}) {
    const cycleStartedAt = this.now();
    this.#lastPollAt = cycleStartedAt;
    this.#metrics.cycles += 1;
    this.#metrics.lastCycleStartedAt = cycleStartedAt;
    const watches = await Promise.resolve(this.store.listWatches());
    await this.#runDeletionChecks();
    const summary = {
      watchedUsers: 0,
      skippedUsers: 0,
      scannedVideos: 0,
      queuedDownloads: 0,
      downloadedVideos: 0,
      alertedVideos: 0,
      seenVideos: 0,
      failures: 0,
    };
    const downloadPromises = [];

    const dueWatches = [];
    for (const watch of watches ?? []) {
      const now = this.now();
      const dueAt = Number(watch?.next_check_at ?? 0);
      if (dueAt && dueAt > now) {
        summary.skippedUsers += 1;
        continue;
      }
      dueWatches.push(watch);
    }

    await runWithConcurrency(dueWatches, this.checkConcurrency, async (watch) => {
      const partial = await this.#processWatch(watch);
      mergeSummary(summary, partial);
      downloadPromises.push(...partial.downloadPromises);
    });

    if (waitForDownloads && downloadPromises.length) {
      const results = await Promise.allSettled(downloadPromises);
      for (const result of results) {
        if (result.status !== 'fulfilled') continue;
        summary.downloadedVideos += result.value?.downloaded ? 1 : 0;
        summary.alertedVideos += result.value?.alerted ? 1 : 0;
      }
    }

    const cycleFinishedAt = this.now();
    this.#metrics.totalChecks += summary.watchedUsers;
    this.#metrics.totalFailures += summary.failures;
    this.#metrics.lastCycleFinishedAt = cycleFinishedAt;
    this.#metrics.lastCycleDurationMs = Math.max(0, cycleFinishedAt - cycleStartedAt);
    this.#metrics.lastSummary = { ...summary };
    this.logger?.info?.(`[monitor] checked=${summary.watchedUsers} skipped=${summary.skippedUsers} scanned=${summary.scannedVideos} queued=${summary.queuedDownloads} failures=${summary.failures} duration_ms=${this.#metrics.lastCycleDurationMs}`);

    return summary;
  }

  async #processWatch(originalWatch) {
    let watch = originalWatch;
    const now = this.now();
    const partial = {
      watchedUsers: 1,
      skippedUsers: 0,
      scannedVideos: 0,
      queuedDownloads: 0,
      downloadedVideos: 0,
      alertedVideos: 0,
      seenVideos: 0,
      failures: 0,
      downloadPromises: [],
    };

    let normalized;
    try {
      normalized = normalizeWatchedUser(watch);
    } catch (error) {
      partial.failures += 1;
      await Promise.resolve(
        this.store.markWatchFailure(
          String(watch?.username ?? watch?.profile_url ?? watch?.profileUrl ?? ''),
          error,
          now + calculateFailureBackoffMs(watch?.failure_count ?? 0, {
            baseMs: this.backoffBaseMs,
            maxMs: this.backoffMaxMs,
          }),
          now,
        ),
      );
      return partial;
    }

    try {
      const profileResult = await this.#listProfileVideos(normalized.profileUrl, {
        username: normalized.username,
        limit: this.scanLimit,
        watch,
      });
      const identity = this.#recordProfileIdentity(normalized.username, profileResult, now);
      if (identity.changed) {
        normalized = normalizeWatchedUser(identity.username);
        watch = {
          ...watch,
          username: identity.username,
          sec_uid: identity.secUid || watch?.sec_uid,
          author_id: identity.authorId || watch?.author_id,
          creator_id: identity.creatorId || watch?.creator_id,
        };
        await Promise.resolve(this.usernameChangeAlert({
          previousUsername: identity.previousUsername,
          username: identity.username,
          creatorId: identity.creatorId,
          watch,
        }));
      } else {
        watch = {
          ...watch,
          sec_uid: identity.secUid || watch?.sec_uid,
          author_id: identity.authorId || watch?.author_id,
          creator_id: identity.creatorId || watch?.creator_id,
        };
      }
      const profileEntries = Array.isArray(profileResult) ? profileResult : profileResult?.entries ?? [];
      const profileWindow = profileEntries.slice(0, this.scanLimit);
      const profileProcessing = await this.#processVideoEntries(profileWindow, {
        partial,
        watch,
        normalized,
        fallbackUrl: normalized.profileUrl,
        now,
      });

      if (
        profileEntries.length >= this.scanLimit
        && profileProcessing.alertCandidates >= this.scanLimit
        && this.burstScanLimit > this.scanLimit
      ) {
        const burstProfileResult = await this.#listProfileVideos(normalized.profileUrl, {
          username: normalized.username,
          limit: this.burstScanLimit,
          watch,
          burst: true,
        });
        const burstEntries = Array.isArray(burstProfileResult) ? burstProfileResult : burstProfileResult?.entries ?? [];
        await this.#processVideoEntries(burstEntries.slice(this.scanLimit, this.burstScanLimit), {
          partial,
          watch,
          normalized,
          fallbackUrl: normalized.profileUrl,
          now,
        });
      }

      const storyResult = await this.#listStoryVideos(normalized, watch, now);
      if (storyResult.identity?.changed) {
        normalized = normalizeWatchedUser(storyResult.identity.username);
        watch = {
          ...watch,
          username: storyResult.identity.username,
          sec_uid: storyResult.identity.secUid || watch?.sec_uid,
          author_id: storyResult.identity.authorId || watch?.author_id,
          creator_id: storyResult.identity.creatorId || watch?.creator_id,
        };
        await Promise.resolve(this.usernameChangeAlert({
          previousUsername: storyResult.identity.previousUsername,
          username: storyResult.identity.username,
          creatorId: storyResult.identity.creatorId,
          watch,
        }));
      } else if (storyResult.identity) {
        watch = {
          ...watch,
          sec_uid: storyResult.identity.secUid || watch?.sec_uid,
          author_id: storyResult.identity.authorId || watch?.author_id,
          creator_id: storyResult.identity.creatorId || watch?.creator_id,
        };
      }

      await this.#processVideoEntries(storyResult.entries, {
        partial,
        watch,
        normalized,
        fallbackUrl: normalized.storyUrl,
        now,
      });

      await Promise.resolve(this.store.markWatchSuccess(normalized.username, now, now + this.pollIntervalMs));
    } catch (error) {
      partial.failures += 1;
      const failureCount = Number(watch?.failure_count ?? 0);
      const nextCheckAt = now + calculateFailureBackoffMs(failureCount, {
        baseMs: this.backoffBaseMs,
        maxMs: this.backoffMaxMs,
      });
      await Promise.resolve(this.store.markWatchFailure(normalized.username, error, nextCheckAt, now));
      this.logger?.warn?.(`TikTok monitor failed for @${normalized.username}: ${error instanceof Error ? error.message : String(error)}`);
    }

    return partial;
  }

  async #processVideoEntries(entries, { partial, watch, normalized, fallbackUrl, now }) {
    const result = { alertCandidates: 0 };
    for (const video of entries ?? []) {
      partial.scannedVideos += 1;

      const videoId = resolveVideoId(video);
      if (!videoId) continue;

      if (this.#pendingDownloadIds.has(videoId) || await Promise.resolve(this.store.hasSeenVideo(videoId))) {
        partial.seenVideos += 1;
        continue;
      }

      const sourceUrl = resolveVideoSourceUrl(video, fallbackUrl);
      const seenRecord = {
        videoId,
        username: normalized.username,
        sourceUrl,
        title: video?.title ?? video?.description ?? '',
      };

      const baselineOnly = shouldBaselineVideoWithoutAlert(video, watch);
      if (baselineOnly) {
        await Promise.resolve(this.store.markVideoSeen(seenRecord, now));
        partial.seenVideos += 1;
        continue;
      }

      result.alertCandidates += 1;
      const downloadPromise = this.#enqueueDownload({
        videoId,
        video,
        watch,
        normalized,
        sourceUrl,
        seenRecord,
      });
      if (downloadPromise) {
        partial.queuedDownloads += 1;
        partial.downloadPromises.push(downloadPromise);
      }
    }
    return result;
  }

  #recordProfileIdentity(username, profileResult, now) {
    if (typeof this.store.recordWatchIdentity !== 'function') {
      return { changed: false, username, previousUsername: username, creatorId: '' };
    }
    const currentUsername = resolveProfileUsername(profileResult, username);
    const secUid = resolveProfileSecUid(profileResult);
    const authorId = resolveProfileAuthorId(profileResult);
    const creatorId = authorId || secUid || resolveProfileCreatorId(profileResult);
    return this.store.recordWatchIdentity(username, {
      creatorId,
      currentUsername,
      secUid,
      authorId,
    }, now);
  }

  #enqueueDownload(task) {
    if (!task?.videoId || this.#pendingDownloadIds.has(task.videoId)) return null;
    this.#pendingDownloadIds.add(task.videoId);
    this.#metrics.totalQueuedDownloads += 1;

    let resolvePromise;
    let rejectPromise;
    const promise = new Promise((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    promise.catch(() => {});
    this.#downloadQueue.push({ ...task, resolvePromise, rejectPromise });
    this.#drainDownloadQueue();
    return promise;
  }

  #drainDownloadQueue() {
    while (this.#activeDownloads < this.downloadConcurrency && this.#downloadQueue.length) {
      const task = this.#downloadQueue.shift();
      this.#activeDownloads += 1;
      void this.#runDownloadTask(task)
        .then(task.resolvePromise, task.rejectPromise)
        .finally(() => {
          this.#activeDownloads -= 1;
          this.#pendingDownloadIds.delete(task.videoId);
          this.#drainDownloadQueue();
        });
    }
  }

  async #runDownloadTask({ videoId, video, watch, normalized, sourceUrl, seenRecord }) {
    try {
      const downloaded = await this.#downloadVideo(video, {
        watch,
        username: normalized.username,
        profileUrl: normalized.profileUrl,
        sourceUrl,
      });

      await Promise.resolve(
        this.alert({
          watch: { ...watch, username: normalized.username, profileUrl: normalized.profileUrl },
          username: normalized.username,
          profileUrl: normalized.profileUrl,
          video: { ...video, id: videoId, sourceUrl, mediaType: resolveVideoMediaType(video) },
          downloaded,
          result: downloaded,
        }),
      );

      const now = this.now();
      await Promise.resolve(this.store.markVideoSeen({ ...seenRecord, alertedAt: now }, now));
      await Promise.resolve(this.store.scheduleVideoDeletionCheck?.(videoId, now + nextDeletionCheckDelayMs(0)));
      this.#metrics.totalCompletedDownloads += 1;
      return { downloaded: true, alerted: true };
    } catch (error) {
      this.#metrics.totalDownloadFailures += 1;
      this.#metrics.lastError = error instanceof Error ? error.message : String(error);
      this.logger?.warn?.(`TikTok monitor download failed for ${videoId}: ${this.#metrics.lastError}`);
      throw error;
    }
  }

  async #listStoryVideos(normalized, watch, now) {
    if (!this.#listProfileStories) return { entries: [], identity: null };
    try {
      const storyResult = await this.#listProfileStories(normalized.storyUrl, {
        username: normalized.username,
        limit: this.scanLimit,
        watch,
      });
      const entries = Array.isArray(storyResult) ? storyResult : storyResult?.entries ?? [];
      const identity = Array.isArray(storyResult) || !shouldRecordStoryIdentity(storyResult, normalized, watch)
        ? null
        : this.#recordProfileIdentity(normalized.username, storyResult, now);
      return {
        identity,
        entries: entries.map((entry) => ({
          ...entry,
          mediaType: resolveVideoMediaType(entry) || 'story',
        })),
      };
    } catch (error) {
      this.logger?.warn?.(`TikTok story check failed for @${normalized.username}: ${error instanceof Error ? error.message : String(error)}`);
      return { entries: [], identity: null };
    }
  }

  async #runDeletionChecks() {
    if (!this.#checkVideoAvailable || typeof this.store.listVideosDueForDeletionCheck !== 'function') return;
    const now = this.now();
    const due = await Promise.resolve(this.store.listVideosDueForDeletionCheck(now, 25));
    for (const video of due ?? []) {
      try {
        const result = await Promise.resolve(this.#checkVideoAvailable(video));
        if (result?.available === false) {
          const deleted = await Promise.resolve(this.store.markVideoDeleted?.(video.video_id, now)) ?? video;
          await Promise.resolve(this.deletionAlert({
            video: { ...video, ...deleted },
            reason: result.reason || result.message || 'The post is no longer publicly available.',
          }));
          continue;
        }

        const completedChecks = Number(video.deletion_check_count ?? 0) + 1;
        await Promise.resolve(
          this.store.markVideoStillAvailable?.(
            video.video_id,
            now + nextDeletionCheckDelayMs(completedChecks),
            now,
          ),
        );
      } catch (error) {
        await Promise.resolve(this.store.postponeVideoDeletionCheck?.(video.video_id, now + 5 * 60 * 1000, now));
        this.logger?.warn?.(`Deletion check failed for ${video.video_id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  async pollUsername(username, { force = false } = {}) {
    const normalized = normalizeWatchedUser(username);
    const watch = await Promise.resolve(this.store.getWatch?.(normalized.username))
      ?? { username: normalized.username, channel_id: '', failure_count: 0 };
    const originalListWatches = this.store.listWatches?.bind(this.store);
    if (!originalListWatches) throw new Error('Store must provide listWatches().');
    this.store.listWatches = () => [{ ...watch, next_check_at: force ? null : watch.next_check_at }];
    try {
      const summary = await this.runOnce({ waitForDownloads: true });
      return {
        ...summary,
        newVideos: summary.queuedDownloads || summary.downloadedVideos,
        skipped: summary.seenVideos,
      };
    } finally {
      this.store.listWatches = originalListWatches;
    }
  }

  status() {
    return {
      running: this.#running,
      lastPollAt: this.#lastPollAt,
      pollIntervalMs: this.pollIntervalMs,
      scanLimit: this.scanLimit,
      burstScanLimit: this.burstScanLimit,
      checkConcurrency: this.checkConcurrency,
      downloadConcurrency: this.downloadConcurrency,
      queueLength: this.#downloadQueue.length,
      activeDownloads: this.#activeDownloads,
      pendingDownloads: this.#pendingDownloadIds.size,
      metrics: { ...this.#metrics },
    };
  }

  async waitForIdle() {
    while (this.#activeDownloads > 0 || this.#downloadQueue.length > 0) {
      await this.sleep(10);
    }
  }

  async #cycle() {
    if (!this.#running) return;
    let nextDelayMs = this.pollIntervalMs;
    try {
      await this.runOnce();
      nextDelayMs = await this.#delayUntilNextDueWatch();
    } catch (error) {
      this.logger?.error?.(`TikTok monitor loop crashed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    } finally {
      if (this.#running) this.#schedule(nextDelayMs);
    }
  }

  async #delayUntilNextDueWatch() {
    if (typeof this.store.listWatches !== 'function') return this.pollIntervalMs;
    const watches = await Promise.resolve(this.store.listWatches());
    const dueTimes = (watches ?? [])
      .map((watch) => Number(watch?.next_check_at ?? 0))
      .filter((dueAt) => Number.isFinite(dueAt) && dueAt > 0);
    if (!dueTimes.length) return this.pollIntervalMs;

    const now = this.now();
    const nextDueAt = Math.min(...dueTimes);
    return Math.max(0, nextDueAt - now);
  }

  #schedule(delayMs) {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#cycle();
    }, Math.max(0, Number(delayMs ?? 0)));
  }
}
