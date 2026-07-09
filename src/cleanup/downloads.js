import { readdir, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';

export async function cleanupExpiredDownloads({ config, store, now = Date.now(), log = console } = {}) {
  if (!config?.downloadDir || !store?.listFilesWithoutActiveLinks || !store?.deleteFileRecords) {
    throw new Error('cleanupExpiredDownloads requires config.downloadDir and compatible store methods.');
  }

  const batchSize = Math.max(1, Math.min(1_000, Number(config.cleanupBatchSize) || 100));
  const totals = { files: 0, deleted: 0, failed: 0, expiredTokens: 0, prunedJobs: 0 };
  totals.expiredTokens = Number(store.deleteExpiredTokens?.(now) ?? 0);
  const retentionMs = Math.max(1, Number(config.retentionDays) || 30) * 24 * 60 * 60 * 1000;
  totals.prunedJobs = Number(store.pruneOldJobs?.(now - retentionMs, batchSize) ?? 0);

  while (true) {
    const files = store.claimFilesForDeletion?.(now, batchSize)
      ?? store.listFilesWithoutActiveLinks(now, batchSize);
    if (!files.length) break;

    const removal = await removeStoredFiles(files, config);
    for (const failure of removal.failed) {
      store.markFileDeletionFailed?.(failure.file.id, failure.error, now);
    }
    const failedIds = new Set(removal.failed.map((failure) => failure.file.id));
    const removableIds = files.filter((file) => !failedIds.has(file.id)).map((file) => file.id);
    const deletedRecords = store.deleteFileRecords(removableIds);
    totals.files += deletedRecords;
    totals.deleted += removal.deleted;
    totals.failed += removal.failed.length;

    if (!removableIds.length || files.length < batchSize) break;
  }

  if (totals.failed) {
    log?.warn?.(`[cleanup] ${totals.failed} expired download file(s) could not be removed from disk.`);
  }
  return totals;
}

export async function removeStoredFiles(files, config) {
  const byPath = new Map();
  const failed = [];
  let deleted = 0;

  for (const file of files) {
    const filePath = resolveStoredDownloadPath(config.downloadDir, file.path);
    if (!filePath) {
      failed.push({ file, error: new Error('Stored download path is outside the configured download directory.') });
      continue;
    }
    const group = byPath.get(filePath) ?? [];
    group.push(file);
    byPath.set(filePath, group);
  }

  for (const [filePath, group] of byPath) {
    let error = null;
    try {
      const paths = await resolveRelatedStoredDownloadPaths(filePath);
      for (const relatedPath of paths) {
        await rm(relatedPath, { force: true });
        deleted += 1;
      }
      await removeEmptyParents(path.dirname(filePath), config.downloadDir);
    } catch (caught) {
      error = caught;
    }
    if (error) {
      for (const file of group) failed.push({ file, error });
    }
  }

  return { deleted, failed };
}

async function resolveRelatedStoredDownloadPaths(filePath) {
  const resolved = path.resolve(filePath);
  const paths = [resolved];
  const dir = path.dirname(resolved);
  const extension = path.extname(resolved).toLowerCase();
  const stem = path.basename(resolved, extension);
  const galleryPrefix = extension === '.zip' ? `${stem}__` : '';
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const isVideoSidecar = extension === '.mp4' && entry.name.startsWith(`${stem}.`);
      const isGalleryImage = galleryPrefix
        && entry.name.startsWith(galleryPrefix)
        && /\.(jpe?g|png|webp|gif|heic)$/i.test(entry.name);
      if (!isVideoSidecar && !isGalleryImage) continue;
      paths.push(path.join(dir, entry.name));
    }
  } catch {
    return paths;
  }
  return [...new Set(paths)];
}

async function removeEmptyParents(startDir, downloadDir) {
  const root = path.resolve(downloadDir);
  let current = path.resolve(startDir);

  while (current.startsWith(root) && current !== root) {
    try {
      await rmdir(current);
    } catch {
      return;
    }
    current = path.dirname(current);
  }
}

function resolveStoredDownloadPath(downloadDir, filePath) {
  const root = path.resolve(downloadDir);
  const resolved = path.isAbsolute(String(filePath ?? ''))
    ? path.resolve(String(filePath))
    : path.resolve(root, String(filePath ?? ''));
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return resolved;
}
