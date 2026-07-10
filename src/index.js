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
import { fetchVideoMetadata } from './tiktok/ytdlp.js';
import { cleanupExpiredDownloads } from './cleanup/downloads.js';
import { createDownloadService } from './download/service.js';
import { createCreatorImportService } from './import/creator.js';

await loadEnvFile();

const config = loadConfig();
validateRuntimeConfig(config);
await ensureRuntimeDirs(config);

const store = createStore(config.stateDbPath);
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

async function checkVideoAvailable(video) {
  const sourceUrl = video?.source_url || video?.sourceUrl || video?.url || video?.webpage_url || '';
  if (resolveVideoMediaType(video) === 'story') return { available: true, reason: 'Story deletion checks are skipped.' };
  if (!sourceUrl) return { available: false, reason: 'The original post URL is missing.' };
  try {
    await fetchVideoMetadata(sourceUrl, config);
    return { available: true };
  } catch (error) {
    const kind = String(error?.kind ?? '');
    if (['access_denied', 'invalid_url', 'no_formats', 'not_found'].includes(kind)) {
      return { available: false, reason: error.message ?? String(error) };
    }
    throw error;
  }
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
    listProfileVideos: async (username, options = {}) => {
      const { listProfileVideos } = await import('./tiktok/ytdlp.js');
      return listProfileVideos(username, { ...config, ...options });
    },
    listProfileStories: async (username, options = {}) => {
      const { listProfileStories } = await import('./tiktok/ytdlp.js');
      return listProfileStories(username, { ...config, ...options });
    },
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
    const outcomes = await Promise.allSettled(targets.map(async (subscription) => {
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
        store,
        result: scopedResult,
        video,
        watch: { ...watch, channel_id: subscription.channel_id },
      });
    }));
    const failures = outcomes.filter((outcome) => outcome.status === 'rejected');
    if (failures.length) {
      console.warn(`[monitor] ${failures.length} alert delivery target(s) failed for ${video?.id ?? 'unknown'}.`);
    }
  },
  deletionAlert: async ({ video, reason }) => {
    if (!discordClient) return;
    const watch = store.getWatch(video?.username ?? '') ?? null;
    const subscriptions = store.listWatchSubscriptions?.(watch?.username ?? '') ?? [];
    await Promise.allSettled(subscriptions.map(async (subscription) => {
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
    }));
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
