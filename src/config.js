import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export async function loadEnvFile(filePath = path.resolve(process.cwd(), '.env'), env = process.env) {
  try {
    const raw = await readFile(filePath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const equalsIndex = trimmed.indexOf('=');
      if (equalsIndex === -1) continue;
      const key = trimmed.slice(0, equalsIndex).trim();
      let value = trimmed.slice(equalsIndex + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (key && !(key in env)) env[key] = value;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

export function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function parseBoolean(value, fallback = false) {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

export function loadConfig(env = process.env, cwd = process.cwd()) {
  const dataDir = resolvePath(env.DATA_DIR ?? './data', cwd);
  const downloadDir = resolvePath(env.DOWNLOAD_DIR ?? path.join(dataDir, 'downloads'), cwd);
  const stateDbPath = resolvePath(env.STATE_DB ?? path.join(dataDir, 'state.db'), cwd);
  const publicBaseUrl = String(env.PUBLIC_BASE_URL ?? 'https://example.com').replace(/\/+$/, '');
  const uploadLimitMb = parsePositiveInt(env.DISCORD_UPLOAD_LIMIT_MB, 10);
  const httpPort = parsePositiveInt(env.HTTP_PORT, 8080);
  const downloadLinkTtlMinutes = parsePositiveInt(env.DOWNLOAD_LINK_TTL_MINUTES, 30);

  return {
    discordToken: env.DISCORD_TOKEN ?? '',
    discordClientId: env.DISCORD_CLIENT_ID ?? '',
    discordGuildId: env.DISCORD_GUILD_ID ?? '',
    discordChannelId: env.DISCORD_CHANNEL_ID ?? '',
    publicBaseUrl,
    httpPort,
    dataDir,
    downloadDir,
    stateDbPath,
    pollIntervalSeconds: parsePositiveInt(env.POLL_INTERVAL_SECONDS, 60),
    profileScanLimit: parsePositiveInt(env.PROFILE_SCAN_LIMIT, 20),
    discordUploadLimitBytes: uploadLimitMb * 1024 * 1024,
    downloadLinkTtlMinutes,
    downloadLinkTtlHours: Math.max(1, Math.ceil(downloadLinkTtlMinutes / 60)),
    retentionDays: parsePositiveInt(env.RETENTION_DAYS, 30),
    maxConcurrentDownloads: parsePositiveInt(env.MAX_CONCURRENT_DOWNLOADS, 1),
    pingMode: String(env.PING_MODE ?? 'none').toLowerCase(),
    pingRoleId: env.PING_ROLE_ID ?? '',
    ytdlpPath: env.YTDLP_PATH ?? 'yt-dlp',
    ytdlpCookiesFile: env.YTDLP_COOKIES_FILE ? resolvePath(env.YTDLP_COOKIES_FILE, cwd) : '',
    ytdlpRetries: parsePositiveInt(env.YTDLP_RETRIES, 3),
    registerCommandsOnStart: parseBoolean(env.REGISTER_COMMANDS_ON_START, false),
  };
}

export async function ensureRuntimeDirs(config) {
  await mkdir(path.dirname(config.stateDbPath), { recursive: true });
  await mkdir(config.downloadDir, { recursive: true });
}

export function validateRuntimeConfig(config, { requireDiscord = true } = {}) {
  const missing = [];
  if (requireDiscord) {
    if (!config.discordToken) missing.push('DISCORD_TOKEN');
    if (!config.discordClientId) missing.push('DISCORD_CLIENT_ID');
    if (!config.discordChannelId) missing.push('DISCORD_CHANNEL_ID');
  }
  if (config.pingMode === 'role' && !config.pingRoleId) missing.push('PING_ROLE_ID');
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

function resolvePath(value, cwd) {
  return path.isAbsolute(value) ? value : path.resolve(cwd, value);
}
