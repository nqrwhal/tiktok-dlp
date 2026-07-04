import { extractVideoId, normalizeUsername, profileUrl as makeProfileUrl } from '../util/files.js';

const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_SCAN_LIMIT = 20;
const DEFAULT_BACKOFF_BASE_MS = 60 * 1000;
const DEFAULT_BACKOFF_MAX_MS = 60 * 60 * 1000;

export function normalizeWatchedUser(input) {
  const username = normalizeUsername(input?.username ?? input?.profile_url ?? input?.profileUrl ?? input?.url ?? input);
  return {
    username,
    profileUrl: makeProfileUrl(username),
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

function resolveMethod(target, names) {
  for (const name of names) {
    if (typeof target?.[name] === 'function') return target[name].bind(target);
  }
  throw new Error(`Downloader is missing a required method: ${names.join(' or ')}`);
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class TikTokMonitor {
  constructor({
    store,
    downloader,
    alert = async () => {},
    logger = console,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    scanLimit = DEFAULT_SCAN_LIMIT,
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
    this.logger = logger ?? console;
    this.pollIntervalMs = pollIntervalMs;
    this.scanLimit = scanLimit;
    this.backoffBaseMs = backoffBaseMs;
    this.backoffMaxMs = backoffMaxMs;
    this.now = now;
    this.sleep = sleep;

    this.#listProfileVideos = resolveMethod(downloader, ['listProfileVideos']);
    this.#downloadVideo = resolveMethod(downloader, ['download', 'downloadVideo']);
  }

  #running = false;
  #timer = null;
  #lastPollAt = null;
  #listProfileVideos;
  #downloadVideo;

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

  async runOnce() {
    this.#lastPollAt = this.now();
    const watches = await Promise.resolve(this.store.listWatches());
    const summary = {
      watchedUsers: 0,
      skippedUsers: 0,
      scannedVideos: 0,
      downloadedVideos: 0,
      alertedVideos: 0,
      seenVideos: 0,
      failures: 0,
    };

    for (const watch of watches ?? []) {
      const now = this.now();
      const dueAt = Number(watch?.next_check_at ?? 0);
      if (dueAt && dueAt > now) {
        summary.skippedUsers += 1;
        continue;
      }

      summary.watchedUsers += 1;

      let normalized;
      try {
        normalized = normalizeWatchedUser(watch);
      } catch (error) {
        summary.failures += 1;
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
        continue;
      }

      try {
        const profileResult = await this.#listProfileVideos(normalized.profileUrl, {
          username: normalized.username,
          limit: this.scanLimit,
          watch,
        });
        const videos = Array.isArray(profileResult) ? profileResult : profileResult?.entries ?? [];

        for (const video of (videos ?? []).slice(0, this.scanLimit)) {
          summary.scannedVideos += 1;

          const videoId = resolveVideoId(video);
          if (!videoId) continue;

          if (await Promise.resolve(this.store.hasSeenVideo(videoId))) {
            summary.seenVideos += 1;
            continue;
          }

          const sourceUrl = resolveVideoSourceUrl(video, normalized.profileUrl);
          const seenRecord = {
            videoId,
            username: normalized.username,
            sourceUrl,
            title: video?.title ?? video?.description ?? '',
          };

          const baselineOnly = shouldBaselineVideoWithoutAlert(video, watch);
          if (baselineOnly) {
            await Promise.resolve(this.store.markVideoSeen(seenRecord, now));
            summary.seenVideos += 1;
            continue;
          }

          const downloaded = await this.#downloadVideo(video, {
            watch,
            username: normalized.username,
            profileUrl: normalized.profileUrl,
            sourceUrl,
          });

          summary.downloadedVideos += 1;

          await Promise.resolve(
            this.alert({
              watch: { ...watch, username: normalized.username, profileUrl: normalized.profileUrl },
              username: normalized.username,
              profileUrl: normalized.profileUrl,
              video: { ...video, id: videoId, sourceUrl },
              downloaded,
              result: downloaded,
            }),
          );

          summary.alertedVideos += 1;

          await Promise.resolve(this.store.markVideoSeen({ ...seenRecord, alertedAt: now }, now));
        }

        await Promise.resolve(this.store.markWatchSuccess(normalized.username, now));
      } catch (error) {
        summary.failures += 1;
        const failureCount = Number(watch?.failure_count ?? 0);
        const nextCheckAt = now + calculateFailureBackoffMs(failureCount, {
          baseMs: this.backoffBaseMs,
          maxMs: this.backoffMaxMs,
        });
        await Promise.resolve(this.store.markWatchFailure(normalized.username, error, nextCheckAt, now));
        this.logger?.warn?.(`TikTok monitor failed for @${normalized.username}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return summary;
  }

  async pollUsername(username, { force = false } = {}) {
    const normalized = normalizeWatchedUser(username);
    const watch = await Promise.resolve(this.store.getWatch?.(normalized.username))
      ?? { username: normalized.username, channel_id: '', failure_count: 0 };
    const originalListWatches = this.store.listWatches?.bind(this.store);
    if (!originalListWatches) throw new Error('Store must provide listWatches().');
    this.store.listWatches = () => [{ ...watch, next_check_at: force ? null : watch.next_check_at }];
    try {
      const summary = await this.runOnce();
      return {
        ...summary,
        newVideos: summary.downloadedVideos,
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
    };
  }

  async #cycle() {
    if (!this.#running) return;
    try {
      await this.runOnce();
    } catch (error) {
      this.logger?.error?.(`TikTok monitor loop crashed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    } finally {
      if (this.#running) this.#schedule(this.pollIntervalMs);
    }
  }

  #schedule(delayMs) {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#cycle();
    }, Math.max(0, Number(delayMs ?? 0)));
  }
}
