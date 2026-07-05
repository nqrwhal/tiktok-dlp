import path from 'node:path';
import { loadConfig, loadEnvFile, ensureRuntimeDirs, validateRuntimeConfig } from './config.js';
import { createStore } from './state/store.js';
import { startHttpServer } from './http/server.js';
import { startDiscordBot, sendVideoAlert } from './discord/client.js';
import { registerCommands } from './discord/register-commands.js';
import { TikTokMonitor } from './tiktok/monitor.js';
import { downloadVideo, fetchVideoMetadata } from './tiktok/ytdlp.js';
import { fileSize, makePublicFileUrl, randomToken } from './util/files.js';
import { cleanupExpiredDownloads } from './cleanup/downloads.js';

await loadEnvFile();

const config = loadConfig();
validateRuntimeConfig(config);
await ensureRuntimeDirs(config);

const store = createStore(config.stateDbPath);
store.setMonitorLinkTokensPermanent();
store.capTemporaryLinkTokenTtl(downloadLinkTtlMs());
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

async function downloadOne(sourceUrl, { delivery = 'auto', type = 'manual', username = '', requestedBy = '', permanent = type === 'monitor' } = {}) {
  const metadata = await fetchVideoMetadata(sourceUrl, config);
  const resolvedUsername = username || metadata.uploader || metadata.channel || '';
  const downloadMetadata = resolvedUsername
    ? { ...metadata, uploader: resolvedUsername, username: resolvedUsername }
    : metadata;
  const jobId = store.createJob({
    type,
    status: 'downloading',
    requestedBy,
    username: resolvedUsername,
    sourceUrl,
    videoId: downloadMetadata.id || '',
    title: downloadMetadata.title || '',
  });

  try {
    const existing = await findReusableDownload(downloadMetadata);
    if (existing) {
      const result = createDownloadResultFromFile({
        metadata: downloadMetadata,
        sourceUrl,
        delivery,
        jobId,
        fileRecord: existing,
        username: resolvedUsername,
        permanent,
      });
      store.updateJob(jobId, {
        status: 'complete',
        file_id: result.fileId,
        video_id: result.videoId,
        username: result.username,
        title: result.title,
      });
      return result;
    }

    const downloaded = await downloadVideo(sourceUrl, {
      ...config,
      metadata: downloadMetadata,
      downloadDir: config.downloadDir,
    });
    const sizeBytes = downloaded.sizeBytes ?? await fileSize(downloaded.filePath);
    const filename = downloaded.filename || path.basename(downloaded.filePath);
    const fileId = store.createFileRecord({
      videoId: downloadMetadata.id || downloaded.videoId || '',
      username: resolvedUsername || downloaded.username || '',
      requestedBy,
      sourceUrl,
      filePath: downloaded.filePath,
      filename,
      sizeBytes,
    });
    const token = randomToken();
    const expiresAt = permanent ? 0 : Date.now() + downloadLinkTtlMs();
    store.createLinkToken({ token, fileId, expiresAt });

    const result = {
      ...downloaded,
      ...downloadMetadata,
      jobId,
      fileId,
      token,
      publicUrl: makePublicFileUrl(config, token),
      sourceUrl,
      filePath: downloaded.filePath,
      filename,
      sizeBytes,
      videoId: downloadMetadata.id || downloaded.videoId || '',
      username: resolvedUsername || downloaded.username || '',
      title: downloadMetadata.title || downloaded.title || '',
      description: downloadMetadata.description || '',
      thumbnailUrl: downloadMetadata.thumbnail || downloaded.thumbnailUrl || '',
      delivery,
      linkPermanent: expiresAt === 0,
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

async function findReusableDownload(metadata) {
  const videoId = metadata.id || metadata.videoId || '';
  const existing = store.getLatestFileByVideoId(videoId);
  if (!existing) return null;

  try {
    const sizeBytes = await fileSize(existing.path);
    return { ...existing, size_bytes: sizeBytes };
  } catch {
    return null;
  }
}

function createDownloadResultFromFile({ metadata, sourceUrl, delivery, jobId, fileRecord, username = '', permanent = false }) {
  const token = randomToken();
  const expiresAt = permanent ? 0 : Date.now() + downloadLinkTtlMs();
  store.createLinkToken({ token, fileId: fileRecord.id, expiresAt });

  return {
    ...metadata,
    jobId,
    fileId: fileRecord.id,
    token,
    publicUrl: makePublicFileUrl(config, token),
    sourceUrl,
    filePath: fileRecord.path,
    primaryFile: fileRecord.path,
    filename: fileRecord.filename || path.basename(fileRecord.path),
    sizeBytes: Number(fileRecord.size_bytes || 0),
    videoId: metadata.id || fileRecord.video_id || '',
    username: username || metadata.uploader || metadata.channel || fileRecord.username || '',
    title: metadata.title || '',
    description: metadata.description || '',
    thumbnailUrl: metadata.thumbnail || '',
    delivery,
    reused: true,
    linkPermanent: expiresAt === 0,
  };
}

function downloadLinkTtlMs() {
  return config.downloadLinkTtlMinutes * 60 * 1000;
}

const monitor = new TikTokMonitor({
  config,
  store,
  downloader: {
    listProfileVideos: async (username) => {
      const { listProfileVideos } = await import('./tiktok/ytdlp.js');
      return listProfileVideos(username, config);
    },
    downloadVideo: async (video, options = {}) => downloadOne(video.url || video.webpage_url || video.sourceUrl || options.sourceUrl, {
      type: 'monitor',
      username: options.username || video.username,
      permanent: true,
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
  clearInterval(cleanupTimer);
  await discordClient?.destroy?.();
  await new Promise((resolve) => httpService.server.close(resolve));
  store.close();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
