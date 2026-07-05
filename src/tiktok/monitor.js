import { extractVideoId, normalizeUsername, profileUrl as makeProfileUrl } from '../util/files.js';

const DEFAULT_POLL_INTERVAL_MS = 60 * 1000;
const DEFAULT_SCAN_LIMIT = 20;
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
  return String(
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
    this.scanLimit = scanLimit;
    this.backoffBaseMs = backoffBaseMs;
    this.backoffMaxMs = backoffMaxMs;
    this.now = now;
    this.sleep = sleep;

    this.#listProfileVideos = resolveMethod(downloader, ['listProfileVideos']);
    this.#downloadVideo = resolveMethod(downloader, ['download', 'downloadVideo']);
    this.#checkVideoAvailable = resolveOptionalMethod(downloader, ['checkVideoAvailable', 'isVideoAvailable']);
  }

  #running = false;
  #timer = null;
  #lastPollAt = null;
  #listProfileVideos;
  #downloadVideo;
  #checkVideoAvailable;

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
    await this.#runDeletionChecks();
    const summary = {
      watchedUsers: 0,
      skippedUsers: 0,
      scannedVideos: 0,
      downloadedVideos: 0,
      alertedVideos: 0,
      seenVideos: 0,
      failures: 0,
    };

    for (const originalWatch of watches ?? []) {
      let watch = originalWatch;
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
        const identity = this.#recordProfileIdentity(normalized.username, profileResult, now);
        if (identity.changed) {
          normalized = normalizeWatchedUser(identity.username);
          watch = { ...watch, username: identity.username };
          await Promise.resolve(this.usernameChangeAlert({
            previousUsername: identity.previousUsername,
            username: identity.username,
            creatorId: identity.creatorId,
            watch,
          }));
        }
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
          await Promise.resolve(this.store.scheduleVideoDeletionCheck?.(videoId, now + nextDeletionCheckDelayMs(0)));
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

  #recordProfileIdentity(username, profileResult, now) {
    if (typeof this.store.recordWatchIdentity !== 'function') {
      return { changed: false, username, previousUsername: username, creatorId: '' };
    }
    const currentUsername = resolveProfileUsername(profileResult, username);
    const creatorId = resolveProfileCreatorId(profileResult);
    return this.store.recordWatchIdentity(username, { creatorId, currentUsername }, now);
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
