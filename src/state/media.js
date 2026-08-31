import path from 'node:path';
import { normalizePlatform } from '../platforms/references.js';

const MAX_METADATA_JSON_BYTES = 32 * 1024;
const MAX_METADATA_DEPTH = 5;
const MAX_METADATA_ENTRIES = 128;
const MAX_METADATA_ARRAY_ITEMS = 32;
const MAX_METADATA_STRING_LENGTH = 2_048;
const TRANSIENT_METADATA_KEY = /^(?:formats?|requested_downloads?|thumbnails?|http_headers?|headers?|cookies?|fragments?)$|urls?$/i;

export function migrateMediaSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS media_posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      remote_id TEXT NOT NULL,
      profile_id INTEGER REFERENCES platform_profiles(id) ON DELETE SET NULL,
      canonical_url TEXT NOT NULL DEFAULT '',
      source_url TEXT NOT NULL DEFAULT '',
      creator_handle TEXT NOT NULL DEFAULT '',
      creator_remote_id TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      media_type TEXT NOT NULL DEFAULT '',
      published_at INTEGER,
      duration_seconds REAL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(platform, remote_id)
    );

    CREATE TABLE IF NOT EXISTS media_assets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL REFERENCES media_posts(id) ON DELETE CASCADE,
      file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      role TEXT NOT NULL DEFAULT 'content',
      remote_id TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT '',
      mime_type TEXT NOT NULL DEFAULT '',
      path TEXT NOT NULL,
      filename TEXT NOT NULL,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      width INTEGER,
      height INTEGER,
      duration_seconds REAL,
      created_at INTEGER NOT NULL,
      UNIQUE(file_id, role, position, path)
    );

    CREATE INDEX IF NOT EXISTS idx_media_posts_profile_published
      ON media_posts(profile_id, published_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_media_posts_platform_created
      ON media_posts(platform, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_media_assets_post_position
      ON media_assets(post_id, role, position, id);
    CREATE INDEX IF NOT EXISTS idx_media_assets_file_position
      ON media_assets(file_id, role, position, id);
  `);
}

export function recordMediaDownload(db, input = {}, now = Date.now(), { manageTransaction = true } = {}) {
  const normalized = normalizeMediaDownload(input, now);
  if (manageTransaction) db.exec('BEGIN IMMEDIATE');
  try {
    assertMediaIdentity(db, normalized);
    db.prepare(`
      INSERT INTO media_posts (
        platform, remote_id, profile_id, canonical_url, source_url,
        creator_handle, creator_remote_id, title, description, media_type,
        published_at, duration_seconds, metadata_json, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(platform, remote_id) DO UPDATE SET
        profile_id = COALESCE(excluded.profile_id, media_posts.profile_id),
        canonical_url = CASE WHEN excluded.canonical_url <> '' THEN excluded.canonical_url ELSE media_posts.canonical_url END,
        source_url = CASE WHEN excluded.source_url <> '' THEN excluded.source_url ELSE media_posts.source_url END,
        creator_handle = CASE WHEN excluded.creator_handle <> '' THEN excluded.creator_handle ELSE media_posts.creator_handle END,
        creator_remote_id = CASE WHEN excluded.creator_remote_id <> '' THEN excluded.creator_remote_id ELSE media_posts.creator_remote_id END,
        title = CASE WHEN excluded.title <> '' THEN excluded.title ELSE media_posts.title END,
        description = CASE WHEN excluded.description <> '' THEN excluded.description ELSE media_posts.description END,
        media_type = CASE WHEN excluded.media_type <> '' THEN excluded.media_type ELSE media_posts.media_type END,
        published_at = COALESCE(excluded.published_at, media_posts.published_at),
        duration_seconds = COALESCE(excluded.duration_seconds, media_posts.duration_seconds),
        metadata_json = CASE WHEN excluded.metadata_json <> '{}' THEN excluded.metadata_json ELSE media_posts.metadata_json END,
        updated_at = excluded.updated_at
    `).run(
      normalized.platform,
      normalized.remoteId,
      normalized.profileId,
      normalized.canonicalUrl,
      normalized.sourceUrl,
      normalized.creatorHandle,
      normalized.creatorRemoteId,
      normalized.title,
      normalized.description,
      normalized.mediaType,
      normalized.publishedAt,
      normalized.durationSeconds,
      normalized.metadataJson,
      normalized.now,
      normalized.now,
    );

    const post = getMediaPost(db, normalized.platform, normalized.remoteId);
    db.prepare('DELETE FROM media_assets WHERE file_id = ?').run(normalized.fileId);
    const insertAsset = db.prepare(`
      INSERT INTO media_assets (
        post_id, file_id, position, role, remote_id, kind, mime_type,
        path, filename, size_bytes, width, height, duration_seconds, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const asset of normalized.assets) {
      insertAsset.run(
        post.id,
        normalized.fileId,
        asset.position,
        asset.role,
        asset.remoteId,
        asset.kind,
        asset.mimeType,
        asset.path,
        asset.filename,
        asset.sizeBytes,
        asset.width,
        asset.height,
        asset.durationSeconds,
        normalized.now,
      );
    }
    const result = {
      post: getMediaPost(db, normalized.platform, normalized.remoteId),
      assets: listMediaAssetsForFile(db, normalized.fileId),
    };
    if (manageTransaction) db.exec('COMMIT');
    return result;
  } catch (error) {
    if (manageTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

function assertMediaIdentity(db, normalized) {
  const file = db.prepare('SELECT platform, video_id FROM files WHERE id = ?').get(normalized.fileId);
  if (
    !file
    || normalizePlatform(file.platform) !== normalized.platform
    || String(file.video_id ?? '') !== normalized.remoteId
  ) {
    throw new Error('The media post identity must match its file platform and remote ID.');
  }
  if (normalized.profileId == null) return;
  const profile = db.prepare('SELECT platform FROM platform_profiles WHERE id = ?').get(normalized.profileId);
  if (!profile || normalizePlatform(profile.platform) !== normalized.platform) {
    throw new Error('The media post profile must belong to the same platform.');
  }
}

export function getMediaPost(db, platformInput, remoteIdInput) {
  let platform;
  try {
    platform = normalizePlatform(platformInput);
  } catch {
    return null;
  }
  const remoteId = normalizeRemoteId(remoteIdInput, false);
  if (!remoteId) return null;
  return db.prepare(`
    SELECT * FROM media_posts WHERE platform = ? AND remote_id = ?
  `).get(platform, remoteId) ?? null;
}

export function listMediaAssetsForFile(db, fileIdInput) {
  const fileId = normalizePositiveInteger(fileIdInput, 'file', false);
  if (!fileId) return [];
  return db.prepare(`
    SELECT *
    FROM media_assets
    WHERE file_id = ?
    ORDER BY CASE role WHEN 'content' THEN 0 WHEN 'primary' THEN 1 WHEN 'package' THEN 2 ELSE 3 END,
      position, id
  `).all(fileId);
}

export function listMediaAssetPathsForFiles(db, fileIds = []) {
  const ids = [...new Set((Array.isArray(fileIds) ? fileIds : [fileIds])
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0))];
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(', ');
  return db.prepare(`
    SELECT DISTINCT file_id, path
    FROM media_assets
    WHERE file_id IN (${placeholders})
    ORDER BY file_id, path
  `).all(...ids);
}

function normalizeMediaDownload(input, now) {
  const platform = normalizePlatform(input.platform);
  const remoteId = normalizeRemoteId(input.remoteId ?? input.videoId ?? input.id);
  const fileId = normalizePositiveInteger(input.fileId, 'file');
  const timestamp = normalizeNonNegativeInteger(now, 'timestamp');
  const file = input.file ?? {};
  const contentAssets = Array.isArray(input.assets) ? input.assets : [];
  const assets = contentAssets.map((asset, index) => normalizeMediaAsset(asset, index, 'content'));
  const deliveryPath = String(file.path ?? input.filePath ?? '').trim();
  if (deliveryPath && !assets.some((asset) => asset.path === deliveryPath)) {
    assets.push(normalizeMediaAsset({
      path: deliveryPath,
      filename: file.filename ?? input.filename,
      sizeBytes: file.sizeBytes ?? input.sizeBytes,
      kind: path.extname(deliveryPath).toLowerCase() === '.zip' ? 'archive' : input.mediaType,
      position: assets.length,
      role: path.extname(deliveryPath).toLowerCase() === '.zip' ? 'package' : 'primary',
    }, assets.length, 'primary'));
  }
  if (!assets.length) throw new Error('A media download requires at least one saved asset path.');

  return {
    platform,
    remoteId,
    fileId,
    profileId: normalizePositiveInteger(input.profileId, 'profile', false),
    canonicalUrl: normalizeText(input.canonicalUrl, 2_000),
    sourceUrl: normalizeText(input.sourceUrl, 2_000),
    creatorHandle: normalizeText(input.creatorHandle ?? input.username, 200),
    creatorRemoteId: normalizeText(input.creatorRemoteId, 256),
    title: normalizeText(input.title, 1_000),
    description: normalizeText(input.description ?? input.caption, 20_000),
    mediaType: normalizeText(input.mediaType, 64).toLowerCase(),
    publishedAt: normalizeOptionalTimestamp(input.publishedAt ?? input.timestamp),
    durationSeconds: normalizeOptionalNumber(input.durationSeconds ?? input.duration),
    metadataJson: normalizeMetadataJson(input.metadata ?? input.metadataJson),
    assets,
    now: timestamp,
  };
}

function normalizeMediaAsset(input, fallbackPosition, fallbackRole) {
  if (!input || typeof input !== 'object') throw new Error('Media assets must be objects.');
  const assetPath = String(input.path ?? input.filePath ?? '').trim();
  if (!assetPath || assetPath.includes('\0')) throw new Error('Every media asset requires a valid saved path.');
  const filename = normalizeText(input.filename || path.basename(assetPath), 512);
  if (!filename) throw new Error('Every media asset requires a filename.');
  return {
    position: normalizeNonNegativeInteger(input.position ?? fallbackPosition, 'asset position'),
    role: normalizeText(input.role || fallbackRole || 'content', 32).toLowerCase() || 'content',
    remoteId: normalizeText(input.remoteId ?? input.id, 256),
    kind: normalizeText(input.kind ?? input.mediaType, 64).toLowerCase(),
    mimeType: normalizeText(input.mimeType ?? input.mime_type, 128).toLowerCase(),
    path: assetPath,
    filename,
    sizeBytes: normalizeNonNegativeInteger(input.sizeBytes ?? input.size ?? 0, 'asset size'),
    width: normalizeOptionalInteger(input.width),
    height: normalizeOptionalInteger(input.height),
    durationSeconds: normalizeOptionalNumber(input.durationSeconds ?? input.duration),
  };
}

function normalizeRemoteId(value, required = true) {
  const remoteId = String(value ?? '').trim();
  if (!remoteId && !required) return '';
  if (!remoteId || remoteId.length > 256 || /[\u0000-\u001f\u007f]/.test(remoteId)) {
    throw new Error('A media post requires a valid remote ID.');
  }
  return remoteId;
}

function normalizeText(value, maximum) {
  return String(value ?? '').trim().slice(0, maximum);
}

function normalizeMetadataJson(value) {
  let parsed = value;
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > MAX_METADATA_JSON_BYTES * 2) return '{}';
    try {
      parsed = JSON.parse(value);
    } catch {
      return '{}';
    }
  }
  if (!parsed || typeof parsed !== 'object') return '{}';
  try {
    const budget = { entries: MAX_METADATA_ENTRIES };
    const sanitized = sanitizeMetadataValue(parsed, 0, budget);
    const serialized = JSON.stringify(sanitized && typeof sanitized === 'object' ? sanitized : {});
    return Buffer.byteLength(serialized, 'utf8') <= MAX_METADATA_JSON_BYTES ? serialized : '{}';
  } catch {
    return '{}';
  }
}

function sanitizeMetadataValue(value, depth, budget) {
  if (value == null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return value.slice(0, MAX_METADATA_STRING_LENGTH);
  if (depth >= MAX_METADATA_DEPTH || budget.entries <= 0 || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    const result = [];
    for (const item of value.slice(0, MAX_METADATA_ARRAY_ITEMS)) {
      if (budget.entries <= 0) break;
      budget.entries -= 1;
      result.push(sanitizeMetadataValue(item, depth + 1, budget));
    }
    return result;
  }
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (budget.entries <= 0) break;
    if (TRANSIENT_METADATA_KEY.test(key)) continue;
    budget.entries -= 1;
    result[String(key).slice(0, 128)] = sanitizeMetadataValue(item, depth + 1, budget);
  }
  return result;
}

function normalizePositiveInteger(value, label, required = true) {
  const number = Number(value);
  if ((!Number.isInteger(number) || number <= 0) && !required && (value == null || value === '')) return null;
  if (!Number.isInteger(number) || number <= 0) throw new Error(`A valid ${label} ID is required.`);
  return number;
}

function normalizeNonNegativeInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new Error(`A valid ${label} is required.`);
  return number;
}

function normalizeOptionalInteger(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

function normalizeOptionalNumber(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function normalizeOptionalTimestamp(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    const milliseconds = value.getTime();
    return Number.isFinite(milliseconds) && milliseconds >= 0 ? Math.trunc(milliseconds) : null;
  }
  const number = Number(value);
  if (Number.isFinite(number) && number >= 0) {
    return number > 10_000_000_000 ? Math.trunc(number) : Math.trunc(number * 1_000);
  }
  const milliseconds = Date.parse(String(value));
  return Number.isFinite(milliseconds) && milliseconds >= 0 ? Math.trunc(milliseconds) : null;
}
