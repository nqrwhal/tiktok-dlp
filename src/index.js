import { loadConfig, loadEnvFile, ensureRuntimeDirs, validateRuntimeConfig } from './config.js';
import { createStore } from './state/store.js';
import { startHttpServer } from './http/server.js';
import {
  monitorScopeId,
  resolveMonitorDeliveryScope,
  startDiscordBot,
  sendDeletionAlert,
  sendUsernameChangeAlert,
  sendVideoAlert,
} from './discord/client.js';
import { registerCommands } from './discord/register-commands.js';
import { TikTokMonitor, resolveVideoMediaType } from './tiktok/monitor.js';
import { getPlatformAdapter } from './platforms/index.js';
import { cleanupExpiredDownloads } from './cleanup/downloads.js';
import { createDownloadService } from './download/service.js';
import { createCreatorImportService } from './import/creator.js';

export async function deliverMonitorAlerts(targets, deliver, {
  videoId = 'unknown',
  eventType = 'new_post',
  store = null,
} = {}) {
  const deliveryTargets = Array.isArray(targets) ? targets : [];
  let pendingTargets = deliveryTargets;
  if (typeof store?.isAlertDelivered === 'function') {
    const pendingFlags = await Promise.all(deliveryTargets.map(async (target) => {
      const key = alertDeliveryKey(target, videoId, eventType);
      if (!key) return true;
      return !await Promise.resolve(store.isAlertDelivered(key));
    }));
    pendingTargets = deliveryTargets.filter((target, index) => pendingFlags[index]);
  }
  const outcomes = await Promise.allSettled(pendingTargets.map(async (target) => {
    const key = alertDeliveryKey(target, videoId, eventType);
    try {
      const result = await deliver(target);
      if (key && typeof store?.markAlertDelivered === 'function') {
        await Promise.resolve(store.markAlertDelivered(key));
      }
      return result;
    } catch (error) {
      if (key && typeof store?.markAlertDeliveryFailed === 'function') {
        try {
          await Promise.resolve(store.markAlertDeliveryFailed({ ...key, error }));
        } catch (stateError) {
          console.warn('[monitor] Failed to persist alert delivery failure.', stateError);
        }
      }
      throw error;
    }
  }));
  const failures = outcomes.filter((outcome) => outcome.status === 'rejected');
  if (!failures.length) return outcomes;

  const message = `[monitor] ${failures.length} of ${pendingTargets.length} alert delivery target(s) failed for ${videoId}.`;
  const errors = failures.map((failure) => failure.reason);
  console.warn(message, errors);
  const error = new AggregateError(errors, message);
  error.failedTargets = failures.length;
  error.targetCount = pendingTargets.length;
  error.totalTargets = deliveryTargets.length;
  error.videoId = videoId;
  throw error;
}

function alertDeliveryKey(target, videoId, eventType) {
  const subscriptionId = Number(target?.id);
  const normalizedVideoId = String(videoId ?? '').trim();
  const normalizedEventType = String(eventType ?? '').trim();
  if (
    !normalizedVideoId
    || normalizedVideoId === 'unknown'
    || !Number.isInteger(subscriptionId)
    || subscriptionId <= 0
    || !normalizedEventType
  ) {
    return null;
  }
  return { videoId: normalizedVideoId, subscriptionId, eventType: normalizedEventType };
}

export async function checkVideoAvailability(
  video,
  config,
  availabilityChecker = getPlatformAdapter('tiktok')?.checkAvailability,
) {
  const sourceUrl = video?.source_url || video?.sourceUrl || video?.url || video?.webpage_url || '';
  if (resolveVideoMediaType(video) === 'story') {
    return { available: true, reason: 'Story deletion checks are skipped.' };
  }
  if (!sourceUrl) {
    throw Object.assign(new Error('The original post URL is missing.'), { kind: 'invalid_url' });
  }
  if (typeof availabilityChecker !== 'function') {
    throw new Error('TikTok availability checks are not configured.');
  }
  try {
    const result = await availabilityChecker(sourceUrl, { config, video });
    return typeof result?.available === 'boolean' ? result : { available: true };
  } catch (error) {
    if (String(error?.kind ?? '') === 'not_found') {
      return { available: false, reason: error.message ?? String(error) };
    }
    throw error;
  }
}

if (process.env.NODE_ENV !== 'test') {
  await loadEnvFile();

  const config = loadConfig();
  validateRuntimeConfig(config);
  await ensureRuntimeDirs(config);

  const store = createStore(config.stateDbPath);
  const backfilledDeletionChecks = store.backfillDeletionChecks?.() ?? 0;
  if (backfilledDeletionChecks > 0) {
    console.log(`[monitor] Scheduled deletion checks for ${backfilledDeletionChecks} saved post(s).`);
  }
  let discordClient = null;
  const cleanupTimer = setInterval(() => {
    cleanupExpiredDownloads({ config, store }).catch((error) => {
      console.error('[cleanup] Expired download cleanup failed:', error);
    });
  }, 60 * 60 * 1000);
  cleanupTimer.unref?.();
  cleanupExpiredDownloads({ config, store }).catch((error) => {
    console.error('[cleanup] Initial expired download cleanup failed:', error);
  });
  const downloadService = createDownloadService({ config, store });
  const creatorImportService = createCreatorImportService({ config, store, downloadService });
  const downloadOne = downloadService.request.bind(downloadService);
  const tiktokPlatformAdapter = getPlatformAdapter('tiktok');
  if (
    typeof tiktokPlatformAdapter?.listCreatorPosts !== 'function'
    || typeof tiktokPlatformAdapter?.listCreatorStories !== 'function'
    || typeof tiktokPlatformAdapter?.checkAvailability !== 'function'
  ) {
    throw new Error('The TikTok platform adapter is missing required monitor operations.');
  }

  async function checkVideoAvailable(video) {
    return checkVideoAvailability(video, config, tiktokPlatformAdapter.checkAvailability);
  }

  const monitor = new TikTokMonitor({
    config,
    store,
    pollIntervalMs: config.pollIntervalSeconds * 1000,
    scanLimit: config.profileScanLimit,
    burstScanLimit: config.profileBurstScanLimit,
    checkConcurrency: config.monitorConcurrency,
    downloadConcurrency: config.maxConcurrentDownloads,
    deletionCheckConcurrency: config.deletionCheckConcurrency,
    deletionCheckBatchSize: config.deletionCheckBatchSize,
    downloader: {
      listProfileVideos: async (username, options = {}) => (
        tiktokPlatformAdapter.listCreatorPosts(username, { ...config, ...options })
      ),
      listProfileStories: async (username, options = {}) => (
        tiktokPlatformAdapter.listCreatorStories(username, { ...config, ...options })
      ),
      downloadVideo: async (video, options = {}) => downloadOne(video.url || video.webpage_url || video.sourceUrl || options.sourceUrl, {
        type: 'monitor',
        username: options.username || video.username,
        permanent: true,
        metadata: video.mediaType === 'story' ? video : null,
        createDelivery: false,
      }),
      checkVideoAvailable,
    },
    alert: async ({ result, video, watch }) => {
      if (!discordClient) return;
      const subscriptions = store.listWatchSubscriptions?.(watch?.username ?? '') ?? [];
      const targets = subscriptions.length ? subscriptions : [{
        guild_id: '',
        channel_id: watch?.channel_id || config.discordChannelId,
      }];
      await deliverMonitorAlerts(targets, async (subscription) => {
        const targetScope = await resolveMonitorDeliveryScope(discordClient, subscription);
        const scopedResult = await downloadService.createDeliveryForAsset(result, {
          type: 'monitor',
          guildId: targetScope.guildId,
          channelId: targetScope.channelId,
          scopeId: targetScope.scopeId,
          permanent: true,
        });
        await sendVideoAlert({
          client: discordClient,
          config,
          result: scopedResult,
          video,
          watch: { ...watch, channel_id: subscription.channel_id },
        });
      }, {
        videoId: video?.id ?? video?.video_id ?? 'unknown',
        eventType: 'new_post',
        store,
      });
    },
    deletionAlert: async ({ video, reason }) => {
      if (!discordClient) {
        throw new Error('Discord is not ready to deliver deletion alerts.');
      }
      const watch = store.getWatch(video?.username ?? '') ?? null;
      const subscriptions = store.listWatchSubscriptions?.(watch?.username ?? '') ?? [];
      if (!subscriptions.length) return { delivered: false, retry: false };
      await deliverMonitorAlerts(subscriptions, async (subscription) => {
        const targetScope = await resolveMonitorDeliveryScope(discordClient, subscription);
        const legacyChannelScopeId = monitorScopeId({ channelId: targetScope.channelId });
        const permanentToken = store.getLatestPermanentTokenForVideo?.(video?.video_id, {
          scopeId: targetScope.scopeId,
        }) || (targetScope.scopeId !== legacyChannelScopeId
          ? store.getLatestPermanentTokenForVideo?.(video?.video_id, { scopeId: legacyChannelScopeId })
          : '') || '';
        await sendDeletionAlert({
          client: discordClient,
          config,
          video: { ...video, permanent_token: permanentToken },
          watch: { ...watch, channel_id: subscription.channel_id },
          reason,
        });
      }, {
        videoId: video?.video_id ?? 'unknown',
        eventType: 'deletion',
        store,
      });
      return { delivered: true };
    },
    usernameChangeAlert: async (change) => {
      if (!discordClient) return;
      const subscriptions = store.listWatchSubscriptions?.(change?.username ?? '') ?? [];
      await Promise.allSettled(subscriptions.map((subscription) => sendUsernameChangeAlert({
        client: discordClient,
        config,
        change,
        watch: { ...change.watch, channel_id: subscription.channel_id },
      })));
    },
  });

  const httpService = await startHttpServer({ config, store, monitor, creatorImportService });
  discordClient = await startDiscordBot({ config, store, monitor, downloadOne, downloadService, registerCommands });

  async function shutdown(signal) {
    console.log(`[shutdown] Received ${signal}`);
    monitor.stop();
    clearInterval(cleanupTimer);
    const importDrain = creatorImportService.stop?.({ drain: true });
    await discordClient?.destroy?.();
    await new Promise((resolve) => httpService.server.close(resolve));
    await importDrain;
    store.close();
    process.exit(0);
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
