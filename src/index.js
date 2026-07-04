import path from 'node:path';
import { loadConfig, loadEnvFile, ensureRuntimeDirs, validateRuntimeConfig } from './config.js';
import { createStore } from './state/store.js';
import { startHttpServer } from './http/server.js';
import { startDiscordBot, sendVideoAlert } from './discord/client.js';
import { registerCommands } from './discord/register-commands.js';
import { TikTokMonitor } from './tiktok/monitor.js';
import { downloadVideo, fetchVideoMetadata } from './tiktok/ytdlp.js';
import { fileSize, makePublicFileUrl, randomToken } from './util/files.js';

await loadEnvFile();

const config = loadConfig();
validateRuntimeConfig(config);
await ensureRuntimeDirs(config);

const store = createStore(config.stateDbPath);
let discordClient = null;

async function downloadOne(sourceUrl, { delivery = 'auto', type = 'manual', username = '', requestedBy = '' } = {}) {
  const metadata = await fetchVideoMetadata(sourceUrl, config);
  const jobId = store.createJob({
    type,
    status: 'downloading',
    requestedBy,
    username: username || metadata.uploader || metadata.channel || '',
    sourceUrl,
    videoId: metadata.id || '',
    title: metadata.title || '',
  });

  try {
    const downloaded = await downloadVideo(sourceUrl, {
      ...config,
      metadata,
      downloadDir: config.downloadDir,
    });
    const sizeBytes = downloaded.sizeBytes ?? await fileSize(downloaded.filePath);
    const filename = downloaded.filename || path.basename(downloaded.filePath);
    const fileId = store.createFileRecord({
      videoId: metadata.id || downloaded.videoId || '',
      username: username || downloaded.username || metadata.uploader || '',
      requestedBy,
      sourceUrl,
      filePath: downloaded.filePath,
      filename,
      sizeBytes,
    });
    const token = randomToken();
    const expiresAt = Date.now() + config.downloadLinkTtlHours * 60 * 60 * 1000;
    store.createLinkToken({ token, fileId, expiresAt });

    const result = {
      ...downloaded,
      ...metadata,
      jobId,
      fileId,
      token,
      publicUrl: makePublicFileUrl(config, token),
      sourceUrl,
      filePath: downloaded.filePath,
      filename,
      sizeBytes,
      videoId: metadata.id || downloaded.videoId || '',
      username: username || downloaded.username || metadata.uploader || metadata.channel || '',
      title: metadata.title || downloaded.title || '',
      description: metadata.description || '',
      thumbnailUrl: metadata.thumbnail || downloaded.thumbnailUrl || '',
      delivery,
    };

    store.updateJob(jobId, {
      status: 'complete',
      file_id: fileId,
      video_id: result.videoId,
      username: result.username,
      title: result.title,
    });
    return result;
  } catch (error) {
    store.updateJob(jobId, { status: 'failed', error: error.message ?? String(error) });
    throw error;
  }
}

const monitor = new TikTokMonitor({
  config,
  store,
  downloader: {
    listProfileVideos: async (username) => {
      const { listProfileVideos } = await import('./tiktok/ytdlp.js');
      return listProfileVideos(username, config);
    },
    downloadVideo: async (video) => downloadOne(video.url || video.webpage_url || video.sourceUrl, {
      type: 'monitor',
      username: video.username,
    }),
  },
  alert: async ({ result, video, watch }) => {
    if (!discordClient) return;
    await sendVideoAlert({ client: discordClient, config, store, result, video, watch });
  },
});

const httpService = await startHttpServer({ config, store, monitor });
discordClient = await startDiscordBot({ config, store, monitor, downloadOne, registerCommands });

async function shutdown(signal) {
  console.log(`[shutdown] Received ${signal}`);
  monitor.stop();
  await discordClient?.destroy?.();
  await new Promise((resolve) => httpService.server.close(resolve));
  store.close();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
