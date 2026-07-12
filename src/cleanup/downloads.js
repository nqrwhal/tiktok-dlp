import { readdir, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';

const MAX_PRUNED_JOBS_PER_RUN = 10_000;

export async function cleanupExpiredDownloads({ config, store, now = Date.now(), log = console } = {}) {
  if (!config?.downloadDir || !store?.listFilesWithoutActiveLinks || !store?.deleteFileRecords) {
    throw new Error('cleanupExpiredDownloads requires config.downloadDir and compatible store methods.');
  }

  const batchSize = Math.max(1, Math.min(1_000, Number(config.cleanupBatchSize) || 100));
  const totals = {
    files: 0,
    deleted: 0,
    failed: 0,
    expiredTokens: 0,
    prunedJobs: 0,
    trashFiles: 0,
    trashDeleted: 0,
    trashFailed: 0,
  };
  totals.expiredTokens = Number(store.deleteExpiredTokens?.(now) ?? 0);
  const retentionMs = Math.max(1, Number(config.retentionDays) || 30) * 24 * 60 * 60 * 1000;
  const jobsCutoff = now - retentionMs;
  while (store.pruneOldJobs && totals.prunedJobs < MAX_PRUNED_JOBS_PER_RUN) {
    const limit = Math.min(batchSize, MAX_PRUNED_JOBS_PER_RUN - totals.prunedJobs);
    const pruned = Number(store.pruneOldJobs(jobsCutoff, limit, now) ?? 0);
    totals.prunedJobs += pruned;
    if (pruned < limit) break;
  }
  const orphanGraceMs = config.cleanupOrphanGraceMinutes == null
    ? 0
    : Math.max(1, Number(config.cleanupOrphanGraceMinutes) || 15) * 60 * 1000;
  const orphanCreatedBefore = now - orphanGraceMs;

  while (true) {
    const files = store.claimFilesForDeletion?.(now, batchSize, orphanCreatedBefore)
      ?? store.listFilesWithoutActiveLinks(now, batchSize, orphanCreatedBefore);
    if (!files.length) break;

    const protectedPaths = resolveProtectedStoredPaths(store, files, config.downloadDir);
    const removal = await removeStoredFiles(files, config, { protectedPaths });
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

  const trashRetentionDays = Number(config.archiveTrashRetentionDays);
  if (Number.isFinite(trashRetentionDays) && trashRetentionDays > 0 && store.claimTrashedFilesForDeletion) {
    const trashCutoff = now - trashRetentionDays * 24 * 60 * 60 * 1000;
    const files = store.claimTrashedFilesForDeletion(trashCutoff, now, batchSize);
    if (files.length) {
      const protectedPaths = resolveProtectedStoredPaths(store, files, config.downloadDir);
      const removal = await removeStoredFiles(files, config, { protectedPaths });
      for (const failure of removal.failed) {
        store.markFileDeletionFailed?.(failure.file.id, failure.error, now);
      }
      const failedIds = new Set(removal.failed.map((failure) => failure.file.id));
      const removableIds = files.filter((file) => !failedIds.has(file.id)).map((file) => file.id);
      const deletedRecords = store.deleteFileRecords(removableIds);
      totals.files += deletedRecords;
      totals.deleted += removal.deleted;
      totals.failed += removal.failed.length;
      totals.trashFiles = deletedRecords;
      totals.trashDeleted = removal.deleted;
      totals.trashFailed = removal.failed.length;
    }
  }

  if (totals.failed) {
    log?.warn?.(`[cleanup] ${totals.failed} expired or trashed download file(s) could not be removed from disk.`);
  }
  return totals;
}

export async function removeStoredFiles(files, config, { protectedPaths = new Set() } = {}) {
  const byPath = new Map();
  const failed = [];
  let deleted = 0;
  const protectedResolvedPaths = new Set([...protectedPaths].map((filePath) => path.resolve(filePath)));

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
      if (protectedResolvedPaths.has(path.resolve(filePath))) continue;
      const paths = await resolveRelatedStoredDownloadPaths(filePath, group);
      for (const relatedPath of paths) {
        if (protectedResolvedPaths.has(path.resolve(relatedPath))) continue;
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

async function resolveRelatedStoredDownloadPaths(filePath, files = []) {
  const resolved = path.resolve(filePath);
  const paths = [resolved];
  const dir = path.dirname(resolved);
  const extension = path.extname(resolved).toLowerCase();
  const stem = path.basename(resolved, extension);
  const relatedStems = new Set([stem]);
  for (const file of files) {
    const videoId = String(file?.video_id ?? '').trim();
    if (/^[A-Za-z0-9_-]{1,128}$/.test(videoId)) {
      relatedStems.add(videoId);
    }
  }
  const galleryPrefix = extension === '.zip' ? `${stem}__` : '';
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const isMediaSidecar = [...relatedStems].some((relatedStem) => isKnownSidecar(entry.name, relatedStem));
      const isGalleryImage = galleryPrefix
        && entry.name.startsWith(galleryPrefix)
        && /\.(jpe?g|png|webp|gif|heic)$/i.test(entry.name);
      if (!isMediaSidecar && !isGalleryImage) continue;
      paths.push(path.join(dir, entry.name));
    }
  } catch {
    return paths;
  }
  return [...new Set(paths)];
}

function isKnownSidecar(filename, stem) {
  if (!filename.startsWith(`${stem}.`)) return false;
  const suffix = filename.slice(stem.length).toLowerCase();
  return /^(?:\.info\.json|\.description|\.image|\.jpe?g|\.png|\.webp|\.gif|\.heic|\.m4a|\.mp3|\.aac|\.opus|\.ogg|\.wav|\.vtt|\.srt|\.ass|\.lrc|\.part|\.ytdl)$/.test(suffix);
}

function resolveProtectedStoredPaths(store, files, downloadDir) {
  const paths = store.listFilePathsReferencedOutside?.(files.map((file) => file.id)) ?? [];
  return new Set(paths
    .map((filePath) => resolveStoredDownloadPath(downloadDir, filePath))
    .filter(Boolean));
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
