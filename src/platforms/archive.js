import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createZipFile } from '../tiktok/ytdlp.js';
import { fileSize, moveDirectoryContents, slugify } from '../util/files.js';
import { normalizePlatform } from './references.js';

export async function archivePlatformDownload(downloaded, {
  downloadDir,
  now = Date.now(),
} = {}) {
  if (!downloadDir) throw new Error('A download directory is required to archive platform media.');
  const post = downloaded?.post && typeof downloaded.post === 'object' ? downloaded.post : {};
  let platform;
  try {
    platform = normalizePlatform(post.platform);
  } catch {
    throw new Error('A downloaded platform post requires a supported platform identity.');
  }
  const remoteId = String(post.remoteId ?? '').trim();
  const sourceDir = path.resolve(String(downloaded?.outputDir ?? ''));
  const downloadRoot = path.resolve(downloadDir);
  const rawAssets = Array.isArray(downloaded?.assets) ? downloaded.assets : [];
  if (!remoteId || !downloaded?.outputDir || !rawAssets.length) {
    throw new Error('A downloaded platform post requires an identity, staging directory, and media assets.');
  }
  const rootFromSource = path.relative(sourceDir, downloadRoot);
  if (!rootFromSource || (!rootFromSource.startsWith('..') && !path.isAbsolute(rootFromSource))) {
    throw new Error('The adapter staging directory must not contain the configured download directory.');
  }

  const publishedAt = normalizeDate(post.publishedAt, now);
  const safeCreator = slugify(post.creator?.handle || 'unknown', 'unknown');
  const safeRemoteId = slugify(remoteId, 'post');
  const dateDir = path.join(
    downloadRoot,
    platform,
    safeCreator,
    String(publishedAt.getUTCFullYear()),
    String(publishedAt.getUTCMonth() + 1).padStart(2, '0'),
    String(publishedAt.getUTCDate()).padStart(2, '0'),
  );
  await mkdir(dateDir, { recursive: true });
  const targetDir = await mkdtemp(path.join(dateDir, `${safeRemoteId}-`));

  try {
    const relativeAssets = rawAssets.map((asset, index) => {
      const sourcePath = path.resolve(String(asset?.filePath ?? asset?.path ?? ''));
      const relative = path.relative(sourceDir, sourcePath);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`Downloaded asset ${index + 1} is outside its staging directory.`);
      }
      return { asset, relative };
    });
    await moveDirectoryContents(sourceDir, targetDir);
    const assets = relativeAssets.map(({ asset, relative }) => ({
      ...asset,
      path: path.join(targetDir, relative),
      filePath: path.join(targetDir, relative),
      filename: asset.filename || path.basename(relative),
    }));

    let filePath = assets[0].path;
    if (assets.length > 1) {
      const stamp = publishedAt.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
      const base = `${stamp}__${safeCreator}__${safeRemoteId}`;
      const manifestPath = path.join(targetDir, `${base}.manifest.json`);
      const bundlePath = path.join(targetDir, `${base}.zip`);
      await writeFile(manifestPath, JSON.stringify({
        platform,
        remoteId,
        canonicalUrl: post.canonicalUrl || '',
        creator: post.creator || null,
        caption: post.caption || '',
        publishedAt: post.publishedAt ?? null,
        mediaType: post.mediaType || '',
        assets: assets.map((asset) => ({
          position: asset.position,
          remoteId: asset.remoteId || '',
          kind: asset.kind || '',
          mimeType: asset.mimeType || '',
          filename: asset.filename,
          width: asset.width ?? null,
          height: asset.height ?? null,
          duration: asset.duration ?? null,
          altText: asset.altText || '',
        })),
      }, null, 2));
      try {
        await createZipFile(bundlePath, [
          ...assets.map((asset, index) => ({
            name: `${String(index + 1).padStart(3, '0')}__${safeArchiveName(asset.filename, index)}`,
            filePath: asset.path,
          })),
          { name: 'manifest.json', filePath: manifestPath },
        ]);
      } finally {
        await rm(manifestPath, { force: true });
      }
      filePath = bundlePath;
    }

    return {
      ...downloaded,
      post,
      assets,
      outputDir: targetDir,
      filePath,
      primaryFile: assets[0].path,
      bundlePath: assets.length > 1 ? filePath : '',
      filename: path.basename(filePath),
      sizeBytes: await fileSize(filePath),
    };
  } catch (error) {
    await rm(targetDir, { recursive: true, force: true }).catch(() => {});
    await rm(sourceDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

function normalizeDate(value, fallback) {
  let date;
  if (value instanceof Date) date = value;
  else if (typeof value === 'string' && value.trim()) date = new Date(value);
  else {
    const number = Number(value);
    const milliseconds = Number.isFinite(number) && number > 0
      ? (number > 10_000_000_000 ? number : number * 1_000)
      : Number(fallback);
    date = new Date(milliseconds);
  }
  return Number.isNaN(date.getTime()) ? new Date(Number(fallback)) : date;
}

function safeArchiveName(value, index) {
  const extension = path.extname(String(value ?? '')).slice(0, 16);
  const stem = slugify(path.basename(String(value ?? ''), extension), `asset-${index + 1}`);
  return `${stem}${extension.toLowerCase()}`;
}
