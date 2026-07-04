import { rm, rmdir } from 'node:fs/promises';
import path from 'node:path';

export async function cleanupExpiredDownloads({ config, store, now = Date.now(), log = console } = {}) {
  if (!config?.downloadDir || !store?.listFilesWithoutActiveLinks || !store?.deleteFileRecords) {
    throw new Error('cleanupExpiredDownloads requires config.downloadDir and compatible store methods.');
  }

  const files = store.listFilesWithoutActiveLinks(now);
  if (!files.length) return { files: 0, deleted: 0, failed: 0 };

  const removal = await removeStoredFiles(files, config);
  const removableIds = files
    .filter((file) => !removal.failed.some((failure) => failure.file.id === file.id))
    .map((file) => file.id);
  const deletedRecords = store.deleteFileRecords(removableIds);

  if (removal.failed.length) {
    log?.warn?.(`[cleanup] ${removal.failed.length} expired download file(s) could not be removed from disk.`);
  }

  return {
    files: deletedRecords,
    deleted: removal.deleted,
    failed: removal.failed.length,
  };
}

export async function removeStoredFiles(files, config) {
  const seen = new Set();
  const failed = [];
  let deleted = 0;

  for (const file of files) {
    const filePath = resolveStoredDownloadPath(config.downloadDir, file.path);
    if (!filePath || seen.has(filePath)) continue;
    seen.add(filePath);

    try {
      await rm(filePath, { force: true });
      deleted += 1;
      await removeEmptyParents(path.dirname(filePath), config.downloadDir);
    } catch (error) {
      failed.push({ file, error });
    }
  }

  return { deleted, failed };
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
