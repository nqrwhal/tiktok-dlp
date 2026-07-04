import { cp, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export function normalizeUsername(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('Username is required.');

  try {
    const url = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
    const firstPathPart = url.pathname.split('/').filter(Boolean)[0] ?? '';
    if (url.hostname.includes('tiktok.com') && firstPathPart.startsWith('@')) {
      return cleanUsername(firstPathPart.slice(1));
    }
  } catch {
    // Fall back to plain username parsing.
  }

  return cleanUsername(raw.replace(/^@/, ''));
}

export function profileUrl(username) {
  return `https://www.tiktok.com/@${normalizeUsername(username)}`;
}

export function isTikTokUrl(value) {
  try {
    const url = new URL(String(value));
    return /(^|\.)tiktok\.com$/i.test(url.hostname);
  } catch {
    return false;
  }
}

export function extractTikTokUrls(value, limit = 5) {
  const matches = String(value ?? '').match(/https?:\/\/[^\s<>()]+/gi) ?? [];
  const urls = [];
  const seen = new Set();

  for (const match of matches) {
    const cleaned = match.replace(/[.,!?;:)\]}>'"]+$/g, '');
    if (!isTikTokUrl(cleaned) || seen.has(cleaned)) continue;
    seen.add(cleaned);
    urls.push(cleaned);
    if (urls.length >= limit) break;
  }

  return urls;
}

export function extractVideoId(value) {
  const text = String(value ?? '');
  const videoMatch = text.match(/\/video\/(\d+)/);
  if (videoMatch) return videoMatch[1];
  const lastDigits = text.match(/(\d{10,})/g)?.at(-1);
  return lastDigits ?? '';
}

export function slugify(value, fallback = 'video') {
  const slug = String(value ?? '')
    .normalize('NFKD')
    .replace(/[^\w\s.-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80)
    .replace(/[.-]+$/g, '');
  return slug || fallback;
}

export function makeDownloadLayout(config, metadata = {}) {
  const username = normalizeUsername(metadata.uploader || metadata.channel || metadata.creator || metadata.username || 'unknown');
  const videoId = String(metadata.id || extractVideoId(metadata.webpage_url || metadata.original_url || '') || Date.now());
  const timestamp = metadata.timestamp ? new Date(metadata.timestamp * 1000) : parseUploadDate(metadata.upload_date) ?? new Date();
  const yyyy = String(timestamp.getUTCFullYear());
  const mm = String(timestamp.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(timestamp.getUTCDate()).padStart(2, '0');
  const stamp = timestamp.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const titleSlug = slugify(metadata.title || metadata.description || videoId, videoId);
  const safeUser = slugify(username, 'unknown');
  const basename = `${stamp}__${safeUser}__${videoId}__${titleSlug}`;
  const dir = path.join(config.downloadDir, safeUser, yyyy, mm, dd);
  return { username, videoId, dir, basename };
}

export async function fileSize(filePath) {
  const stats = await stat(filePath);
  return stats.size;
}

export function shouldUploadToDiscord(sizeBytes, config) {
  return Number(sizeBytes) > 0 && Number(sizeBytes) <= config.discordUploadLimitBytes;
}

export function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export async function moveDirectoryContents(fromDir, toDir) {
  await mkdir(toDir, { recursive: true });
  const entries = await readdir(fromDir);
  const moved = [];
  for (const entry of entries) {
    const fromPath = path.join(fromDir, entry);
    const toPath = path.join(toDir, entry);
    await movePath(fromPath, toPath);
    moved.push(toPath);
  }
  await rm(fromDir, { recursive: true, force: true });
  return moved;
}

export function pickPrimaryVideo(paths) {
  return paths.find((entry) => /\.mp4$/i.test(entry))
    ?? paths.find((entry) => /\.(webm|mov|mkv|m4v)$/i.test(entry))
    ?? '';
}

export function makePublicFileUrl(config, token) {
  if (!config.publicBaseUrl) return '';
  return `${config.publicBaseUrl}/files/${encodeURIComponent(token)}`;
}

function cleanUsername(value) {
  const username = String(value ?? '').trim().replace(/^@/, '');
  if (
    !/^[A-Za-z0-9._]{1,32}$/.test(username)
    || username.startsWith('.')
    || username.endsWith('.')
    || username.includes('..')
  ) {
    throw new Error('TikTok username must be 1-32 characters and use letters, numbers, dots, or underscores.');
  }
  return username;
}

function parseUploadDate(value) {
  const text = String(value ?? '');
  if (!/^\d{8}$/.test(text)) return null;
  const yyyy = Number(text.slice(0, 4));
  const mm = Number(text.slice(4, 6));
  const dd = Number(text.slice(6, 8));
  return new Date(Date.UTC(yyyy, mm - 1, dd));
}

async function movePath(fromPath, toPath) {
  try {
    await rename(fromPath, toPath);
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    await cp(fromPath, toPath, { recursive: true });
    await rm(fromPath, { recursive: true, force: true });
  }
}
