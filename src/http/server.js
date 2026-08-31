import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createReadStream } from 'node:fs';
import { parseProfileReference } from '../platforms/index.js';
import { normalizeUsername } from '../util/files.js';
import { removeStoredFiles } from '../cleanup/downloads.js';

export function createHttpHandler({ config, store, creatorImportService = null }) {
  assertServerDeps(config, store);

  return async function handleRequest(req, res) {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

      if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/health') {
        return sendJson(res, 200, buildHealthPayload(config, store), { head: req.method === 'HEAD' });
      }

      if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/ready') {
        try {
          return sendJson(res, 200, buildReadinessPayload(store), { head: req.method === 'HEAD' });
        } catch {
          return sendJson(res, 503, { status: 'not_ready' }, { head: req.method === 'HEAD' });
        }
      }

      if (url.pathname === '/api/imports' || /^\/api\/imports\/\d+(?:\/(?:cancel|retry))?$/.test(url.pathname)) {
        return handleCreatorImportRequest(req, res, {
          config,
          creatorImportService,
          url,
        });
      }

      if (url.pathname === '/api/trash') {
        return handleTrashRequest(req, res, { config, store, url });
      }

      const trashVideoMatch = url.pathname.match(/^\/api\/trash\/(\d+)$/);
      if (trashVideoMatch) {
        return handleTrashVideoRequest(req, res, {
          config,
          store,
          fileId: Number(trashVideoMatch[1]),
        });
      }

      if (url.pathname === '/api/bookmarks') {
        return handleBookmarksRequest(req, res, { config, store });
      }

      if (
        url.pathname === '/api/rewind/creators'
        || url.pathname === '/api/rewind/videos'
        || url.pathname === '/api/rewind/stats'
        || url.pathname === '/api/rewind/posts'
      ) {
        return handleRewindArchiveReadRequest(req, res, { config, store, url });
      }

      const bookmarkMatch = url.pathname.match(/^\/api\/bookmarks\/(\d+)$/);
      if (bookmarkMatch) {
        return handleBookmarkRequest(req, res, {
          config,
          store,
          fileId: Number(bookmarkMatch[1]),
        });
      }

      const postBookmarkMatch = url.pathname.match(/^\/api\/post-bookmarks\/(\d+)$/);
      if (postBookmarkMatch) {
        return handlePostBookmarkRequest(req, res, {
          config,
          store,
          fileId: Number(postBookmarkMatch[1]),
        });
      }

      const mediaPostRestoreMatch = url.pathname.match(/^\/api\/media-posts\/(\d+)\/restore$/);
      if (mediaPostRestoreMatch) {
        return handleMediaPostRestoreRequest(req, res, {
          config,
          store,
          fileId: Number(mediaPostRestoreMatch[1]),
        });
      }

      const mediaPostMatch = url.pathname.match(/^\/api\/media-posts\/(\d+)$/);
      if (mediaPostMatch) {
        return handleMediaPostRequest(req, res, {
          config,
          store,
          fileId: Number(mediaPostMatch[1]),
        });
      }

      const restoreVideoMatch = url.pathname.match(/^\/api\/videos\/(\d+)\/restore$/);
      if (restoreVideoMatch) {
        return handleVideoRestoreRequest(req, res, {
          config,
          store,
          fileId: Number(restoreVideoMatch[1]),
        });
      }

      if (
        url.pathname === '/api/profile-groups'
        || /^\/api\/profile-groups\/\d+$/.test(url.pathname)
        || /^\/api\/profile-groups\/\d+\/profiles\/\d+$/.test(url.pathname)
      ) {
        return handleProfileGroupsRequest(req, res, { config, store, url });
      }

      const creatorMonitoringMatch = url.pathname.match(/^\/api\/creators\/([^/]+)\/monitoring$/);
      if (creatorMonitoringMatch) {
        let username = '';
        try {
          username = decodeURIComponent(creatorMonitoringMatch[1]);
        } catch {
          return sendJson(res, 400, { error: 'Creator username is invalid' });
        }
        return handleCreatorMonitoringRequest(req, res, { config, store, username });
      }

      const creatorVideosMatch = url.pathname.match(/^\/api\/creators\/([^/]+)\/videos$/);
      if (creatorVideosMatch) {
        let username = '';
        try {
          username = decodeURIComponent(creatorVideosMatch[1]);
        } catch {
          return sendJson(res, 400, { error: 'Creator username is invalid' });
        }
        return handleCreatorVideosRequest(req, res, { config, store, username });
      }

      const videoMatch = url.pathname.match(/^\/api\/videos\/(\d+)$/);
      if (videoMatch) {
        return handleVideoRequest(req, res, {
          config,
          store,
          fileId: Number(videoMatch[1]),
        });
      }

      if (req.method === 'GET' || req.method === 'HEAD') {
        const token = matchFileToken(url.pathname);
        if (token) {
          return handleFileRequest(req, res, { config, store, token });
        }
      }

      return sendJson(res, 404, { error: 'Not found' }, { head: req.method === 'HEAD' });
    } catch (error) {
      return sendJson(res, 500, {
        error: 'Internal server error',
      }, { head: req.method === 'HEAD' });
    }
  };
}

export async function handleProfileGroupsRequest(req, res, { config, store, url }) {
  if (!isImportAuthorized(req, config)) {
    return sendJson(res, 401, { error: 'Unauthorized' });
  }

  try {
    if (req.method === 'GET' && url.pathname === '/api/profile-groups') {
      return sendJson(res, 200, buildProfileGroupsPayload(store));
    }

    if (req.method === 'POST' && url.pathname === '/api/profile-groups') {
      const body = await readJsonBody(req);
      if (!Array.isArray(body.profiles)) {
        return sendJson(res, 400, { error: 'profiles must be an array of profile URLs or IDs' });
      }
      const groupId = body.groupId == null || body.groupId === '' ? null : positiveId(body.groupId);
      if (!groupId && body.profiles.length < 2) {
        return sendJson(res, 400, { error: 'Choose at least two profiles when creating a creator group' });
      }
      if (groupId && !store.getCreatorGroup?.(groupId)) {
        return sendJson(res, 404, { error: 'Creator group not found' });
      }
      const profiles = body.profiles.map((profile) => resolveProfileForLink(store, profile));
      const profileIds = [...new Set(profiles.map((profile) => Number(profile.id)))];
      if (!groupId && profileIds.length < 2) {
        return sendJson(res, 400, { error: 'Choose two different profiles when creating a creator group' });
      }
      const linked = store.linkCreatorProfiles(profileIds, {
        groupId,
        ...(Object.hasOwn(body, 'name') ? { name: body.name } : {}),
        mergeGroups: body.mergeGroups === true,
      });
      return sendJson(res, 200, {
        group: serializeCreatorGroup(linked),
      });
    }

    const groupMatch = url.pathname.match(/^\/api\/profile-groups\/(\d+)$/);
    if (req.method === 'PATCH' && groupMatch) {
      const body = await readJsonBody(req);
      if (typeof body.name !== 'string') {
        return sendJson(res, 400, { error: 'name must be a string' });
      }
      const renamed = store.renameCreatorGroup?.(Number(groupMatch[1]), body.name);
      if (!renamed) return sendJson(res, 404, { error: 'Creator group not found' });
      return sendJson(res, 200, { group: serializeCreatorGroup(renamed) });
    }

    const memberMatch = url.pathname.match(/^\/api\/profile-groups\/(\d+)\/profiles\/(\d+)$/);
    if (req.method === 'DELETE' && memberMatch) {
      const groupId = Number(memberMatch[1]);
      const profileId = Number(memberMatch[2]);
      const member = store.getCreatorGroupMember?.(groupId, profileId);
      if (!member) return sendJson(res, 404, { error: 'Linked profile not found' });
      store.unlinkProfileFromCreatorGroup(profileId);
      const group = store.getCreatorGroup?.(groupId);
      return sendJson(res, 200, {
        unlinkedProfile: serializePlatformProfile(store.getPlatformProfile(profileId)),
        group: group ? serializeCreatorGroup({
          ...group,
          members: store.listCreatorGroupMembers(groupId),
        }) : null,
      });
    }

    return sendJson(res, 405, { error: 'Method not allowed' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const statusCode = Number(error?.statusCode)
      || (/different creator groups|another creator group/i.test(message) ? 409 : 400);
    return sendJson(res, statusCode, { error: message });
  }
}

export async function handleRewindArchiveReadRequest(req, res, { config, store, url }) {
  if (!isImportAuthorized(req, config)) {
    return sendJson(res, 401, { error: 'Unauthorized' });
  }
  if (req.method !== 'GET') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  try {
    if (url.pathname === '/api/rewind/posts') {
      const limit = queryInteger(url, 'limit', { defaultValue: 100, minimum: 1, maximum: 501 });
      const fileId = queryInteger(url, 'fileId', { defaultValue: null, minimum: 1 });
      const profileId = queryInteger(url, 'profileId', { defaultValue: null, minimum: 1 });
      const groupId = queryInteger(url, 'groupId', { defaultValue: null, minimum: 1 });
      const beforeCreatedAt = queryInteger(url, 'beforeCreatedAt', {
        defaultValue: null,
        minimum: 0,
      });
      const beforeFileId = queryInteger(url, 'beforeFileId', { defaultValue: null, minimum: 1 });
      if ((beforeCreatedAt == null) !== (beforeFileId == null)) {
        return sendJson(res, 400, { error: 'Both Rewind media cursor fields are required' });
      }
      const username = String(url.searchParams.get('username') ?? '').trim();
      if (username.length > 128) {
        return sendJson(res, 400, { error: 'Rewind username is too long' });
      }
      const platform = String(url.searchParams.get('platform') ?? '').trim();
      if (platform.length > 32) {
        return sendJson(res, 400, { error: 'Rewind platform is too long' });
      }
      const posts = store.listRewindMediaPosts({
        platform,
        username,
        profileId,
        groupId,
        fileId,
        limit,
        cursor: beforeCreatedAt == null ? null : {
          createdAt: beforeCreatedAt,
          fileId: beforeFileId,
        },
        bookmarkedOnly: url.searchParams.get('bookmarked') === '1',
        trashedOnly: url.searchParams.get('trashed') === '1',
      });
      return sendJson(res, 200, { posts });
    }
    if (url.pathname === '/api/rewind/creators') {
      return sendJson(res, 200, { creators: store.listRewindCreators() });
    }
    if (url.pathname === '/api/rewind/stats') {
      return sendJson(res, 200, { stats: store.getRewindStats() });
    }

    const limit = queryInteger(url, 'limit', { defaultValue: 500, minimum: 1, maximum: 5_001 });
    const fileId = queryInteger(url, 'fileId', { defaultValue: null, minimum: 1 });
    const beforeCreatedAt = queryInteger(url, 'beforeCreatedAt', {
      defaultValue: null,
      minimum: 0,
    });
    const beforeFileId = queryInteger(url, 'beforeFileId', { defaultValue: null, minimum: 1 });
    if ((beforeCreatedAt == null) !== (beforeFileId == null)) {
      return sendJson(res, 400, { error: 'Both Rewind cursor fields are required' });
    }
    const username = String(url.searchParams.get('username') ?? '').trim();
    if (username.length > 128) {
      return sendJson(res, 400, { error: 'Rewind username is too long' });
    }
    const videos = store.listRewindVideos({
      username,
      fileId,
      limit,
      cursor: beforeCreatedAt == null ? null : {
        createdAt: beforeCreatedAt,
        fileId: beforeFileId,
      },
      bookmarkedOnly: url.searchParams.get('bookmarked') === '1',
    });
    return sendJson(res, 200, { videos });
  } catch (error) {
    return sendJson(res, Number(error?.statusCode) || 400, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function handleCreatorMonitoringRequest(req, res, { config, store, username }) {
  if (!isImportAuthorized(req, config)) {
    return sendJson(res, 401, { error: 'Unauthorized' });
  }
  if (req.method !== 'DELETE') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  try {
    const normalizedUsername = normalizeUsername(username);
    const watch = store.getWatch(normalizedUsername)
      ?? store.listWatches().find((entry) => (
        String(entry.username).toLowerCase() === normalizedUsername.toLowerCase()
      ));
    const watchedUsername = String(watch?.username || normalizedUsername);
    const subscriptionCount = watch
      ? (store.listWatchSubscriptions?.(watchedUsername) ?? []).length
      : 0;
    const removed = watch ? store.removeWatch(watchedUsername) : false;

    return sendJson(res, 200, {
      username: watchedUsername,
      monitoring: false,
      removed,
      removedSubscriptions: removed ? subscriptionCount : 0,
    });
  } catch (error) {
    const statusCode = Number(error?.statusCode) || 400;
    return sendJson(res, statusCode, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function handleVideoRequest(req, res, { config, store, fileId }) {
  if (!isImportAuthorized(req, config)) {
    return sendJson(res, 401, { error: 'Unauthorized' });
  }
  if (req.method !== 'DELETE') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  try {
    const body = await readJsonBody(req);
    if (Number(body.confirmFileId) !== Number(fileId)) {
      return sendJson(res, 400, { error: 'Confirm the video before deleting it' });
    }

    const file = store.getVideoFilePurgePlan(fileId);
    if (!file) return sendJson(res, 404, { error: 'Video not found' });

    const trashed = store.trashFile?.(file.id);
    if (!trashed) return sendJson(res, 404, { error: 'Video not found' });

    return sendJson(res, 200, {
      fileId: Number(file.id),
      videoId: String(file.video_id ?? ''),
      username: String(file.username ?? ''),
      deletedVideo: true,
      deletedStoredFiles: 0,
      trashedVideo: true,
      trashedAt: Number(trashed.trashed_at),
      purgeAt: trashPurgeAt(trashed.trashed_at, config),
    });
  } catch (error) {
    const statusCode = Number(error?.statusCode) || 400;
    return sendJson(res, statusCode, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function handleBookmarksRequest(req, res, { config, store }) {
  if (!isImportAuthorized(req, config)) {
    return sendJson(res, 401, { error: 'Unauthorized' });
  }
  if (req.method === 'GET') {
    return sendJson(res, 200, { fileIds: store.listBookmarkedFileIds?.() ?? [] });
  }
  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  try {
    const body = await readJsonBody(req);
    if (!Array.isArray(body.fileIds)) {
      return sendJson(res, 400, { error: 'fileIds must be an array' });
    }
    return sendJson(res, 200, {
      fileIds: store.addFileBookmarks?.(body.fileIds) ?? [],
    });
  } catch (error) {
    const statusCode = Number(error?.statusCode) || 400;
    return sendJson(res, statusCode, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function handleBookmarkRequest(req, res, { config, store, fileId }) {
  if (!isImportAuthorized(req, config)) {
    return sendJson(res, 401, { error: 'Unauthorized' });
  }
  if (req.method !== 'PUT' && req.method !== 'DELETE') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  const bookmarked = req.method === 'PUT';
  const updated = store.setFileBookmark?.(fileId, bookmarked);
  if (!updated && bookmarked) return sendJson(res, 404, { error: 'Video not found' });
  return sendJson(res, 200, { fileId: Number(fileId), bookmarked });
}

export async function handlePostBookmarkRequest(req, res, { config, store, fileId }) {
  if (!isImportAuthorized(req, config)) {
    return sendJson(res, 401, { error: 'Unauthorized' });
  }
  if (req.method !== 'PUT' && req.method !== 'DELETE') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  const bookmarked = req.method === 'PUT';
  const updated = store.setMediaFileBookmark?.(fileId, bookmarked);
  if (!updated) return sendJson(res, 404, { error: 'Post not found' });
  return sendJson(res, 200, { fileId: Number(fileId), bookmarked });
}

export async function handleMediaPostRequest(req, res, { config, store, fileId }) {
  if (!isImportAuthorized(req, config)) {
    return sendJson(res, 401, { error: 'Unauthorized' });
  }
  if (req.method !== 'DELETE') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  try {
    const body = await readJsonBody(req);
    if (Number(body.confirmFileId) !== Number(fileId)) {
      return sendJson(res, 400, { error: 'Confirm the post before moving it to trash' });
    }
    const trashed = store.trashMediaFile?.(fileId);
    if (!trashed) {
      const existing = store.getTrashedMediaFile?.(fileId);
      return sendJson(res, existing ? 409 : 404, {
        error: existing ? 'The post is already in trash' : 'Post not found',
      });
    }
    return sendJson(res, 200, {
      fileId: Number(trashed.id),
      platform: String(trashed.platform ?? ''),
      remoteId: String(trashed.video_id ?? ''),
      trashedAt: Number(trashed.trashed_at ?? 0),
      trashedPost: true,
    });
  } catch (error) {
    return sendJson(res, Number(error?.statusCode) || 400, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function handleMediaPostRestoreRequest(req, res, { config, store, fileId }) {
  if (!isImportAuthorized(req, config)) {
    return sendJson(res, 401, { error: 'Unauthorized' });
  }
  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  try {
    const body = await readJsonBody(req);
    if (Number(body.confirmFileId) !== Number(fileId)) {
      return sendJson(res, 400, { error: 'Confirm the post before restoring it' });
    }
    const trashed = store.getTrashedMediaFile?.(fileId);
    if (!trashed) return sendJson(res, 404, { error: 'Trashed post not found' });
    if (trashed.retention_status === 'trash_claimed'
      || (trashed.delete_requested_at != null && trashed.delete_error == null)) {
      return sendJson(res, 409, { error: 'The archived post is currently being purged' });
    }

    const storedPaths = new Set([trashed.path, ...(trashed.asset_paths ?? [])].filter(Boolean));
    for (const storedPath of storedPaths) {
      const filePath = resolveDownloadPath(config.downloadDir, storedPath);
      const fileStats = filePath ? await stat(filePath).catch(() => null) : null;
      if (!fileStats?.isFile()) {
        return sendJson(res, 409, { error: 'The archived post media is no longer available on disk' });
      }
    }

    const restored = store.restoreTrashedMediaFile?.(fileId);
    if (!restored) {
      const current = store.getTrashedMediaFile?.(fileId);
      return sendJson(res, current ? 409 : 404, {
        error: current ? 'The archived post is currently being purged' : 'Trashed post not found',
      });
    }
    return sendJson(res, 200, {
      fileId: Number(restored.id),
      platform: String(restored.platform ?? ''),
      remoteId: String(restored.video_id ?? ''),
      restoredPost: true,
    });
  } catch (error) {
    return sendJson(res, Number(error?.statusCode) || 400, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function handleCreatorVideosRequest(req, res, { config, store, username }) {
  if (!isImportAuthorized(req, config)) {
    return sendJson(res, 401, { error: 'Unauthorized' });
  }
  if (req.method !== 'DELETE') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  try {
    const normalizedUsername = normalizeUsername(username);
    const body = await readJsonBody(req);
    const confirmedUsername = normalizeUsername(body.confirmUsername);
    if (confirmedUsername.toLowerCase() !== normalizedUsername.toLowerCase()) {
      return sendJson(res, 400, { error: `Type @${normalizedUsername} to confirm deletion` });
    }
    const activeImport = store.findActiveCreatorImport?.(normalizedUsername);
    if (activeImport) {
      return sendJson(res, 409, {
        error: `Wait for the active @${normalizedUsername} import to finish before deleting its videos`,
      });
    }

    const trashedIds = store.trashCreatorVideoFiles?.(normalizedUsername) ?? [];

    return sendJson(res, 200, {
      username: normalizedUsername,
      deletedVideos: trashedIds.length,
      deletedStoredFiles: 0,
      trashedVideos: trashedIds.length,
      failedVideos: 0,
    });
  } catch (error) {
    const statusCode = Number(error?.statusCode) || 400;
    return sendJson(res, statusCode, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function handleTrashRequest(req, res, { config, store, url }) {
  if (!isImportAuthorized(req, config)) {
    return sendJson(res, 401, { error: 'Unauthorized' });
  }
  if (req.method !== 'GET' && req.method !== 'DELETE') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  if (req.method === 'DELETE') {
    try {
      const body = await readJsonBody(req);
      if (body.confirmDeleteAll !== true) {
        return sendJson(res, 400, { error: 'Confirm all trashed videos before deleting them permanently' });
      }

      const files = store.claimAllTrashedFilesForDeletion?.() ?? [];
      if (!files.length) {
        return sendJson(res, 200, {
          permanentlyDeletedVideos: 0,
          deletedStoredFiles: 0,
          failedVideos: 0,
        });
      }

      const protectedPaths = new Set(
        (store.listFilePathsReferencedOutside?.(files.map((file) => file.id)) ?? [])
          .map((filePath) => resolveDownloadPath(config.downloadDir, filePath))
          .filter(Boolean),
      );
      const removal = await removeStoredFiles(files, config, { protectedPaths });
      for (const failure of removal.failed) {
        store.markFileDeletionFailed?.(failure.file.id, failure.error, Date.now(), {
          expectedRetentionStatus: 'trash_claimed',
          expectedRequestedAt: failure.file.delete_requested_at,
        });
      }
      const failedIds = new Set(removal.failed.map((failure) => Number(failure.file.id)));
      const removableIds = files
        .map((file) => Number(file.id))
        .filter((fileId) => !failedIds.has(fileId));
      const deletedRecords = store.deleteFileRecords?.(removableIds, {
        requiredRetentionStatus: 'trash_claimed',
        claimRequestedAt: files[0]?.delete_requested_at,
      }) ?? 0;
      return sendJson(res, 200, {
        permanentlyDeletedVideos: deletedRecords,
        deletedStoredFiles: removal.deleted,
        failedVideos: failedIds.size,
      });
    } catch (error) {
      const statusCode = Number(error?.statusCode) || 400;
      return sendJson(res, statusCode, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const limit = Math.max(1, Math.min(1_000, Number(url.searchParams.get('limit')) || 100));
  const videos = (store.listTrashedFiles?.(limit) ?? []).map((file) => serializeTrashedFile(file, config));
  return sendJson(res, 200, {
    videos,
    retentionDays: Math.max(0, Number(config.archiveTrashRetentionDays) || 0),
  });
}

export async function handleTrashVideoRequest(req, res, { config, store, fileId }) {
  if (!isImportAuthorized(req, config)) {
    return sendJson(res, 401, { error: 'Unauthorized' });
  }
  if (req.method !== 'DELETE') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  try {
    const body = await readJsonBody(req);
    if (Number(body.confirmFileId) !== Number(fileId)) {
      return sendJson(res, 400, { error: 'Confirm the trashed video before deleting it permanently' });
    }

    const file = store.claimTrashedFileForDeletion?.(fileId);
    if (!file) {
      const existing = store.getTrashedFile?.(fileId);
      return sendJson(res, existing ? 409 : 404, {
        error: existing ? 'The archived video is currently being purged' : 'Trashed video not found',
      });
    }

    const protectedPaths = new Set(
      (store.listFilePathsReferencedOutside?.([file.id]) ?? [])
        .map((filePath) => resolveDownloadPath(config.downloadDir, filePath))
        .filter(Boolean),
    );
    const removal = await removeStoredFiles([file], config, { protectedPaths });
    if (removal.failed.length) {
      const failure = removal.failed[0];
      store.markFileDeletionFailed?.(file.id, failure.error, Date.now(), {
        expectedRetentionStatus: 'trash_claimed',
        expectedRequestedAt: file.delete_requested_at,
      });
      return sendJson(res, 500, { error: 'The video file could not be deleted. You can retry from trash.' });
    }

    const deletedRecords = store.deleteFileRecords?.([file.id], {
      requiredRetentionStatus: 'trash_claimed',
      claimRequestedAt: file.delete_requested_at,
    }) ?? 0;
    if (!deletedRecords) {
      return sendJson(res, 404, { error: 'Trashed video not found' });
    }
    return sendJson(res, 200, {
      fileId: Number(file.id),
      videoId: String(file.video_id ?? ''),
      username: String(file.username ?? ''),
      permanentlyDeleted: true,
      deletedStoredFiles: removal.deleted,
    });
  } catch (error) {
    const statusCode = Number(error?.statusCode) || 400;
    return sendJson(res, statusCode, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function handleVideoRestoreRequest(req, res, { config, store, fileId }) {
  if (!isImportAuthorized(req, config)) {
    return sendJson(res, 401, { error: 'Unauthorized' });
  }
  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  try {
    const body = await readJsonBody(req);
    if (Number(body.confirmFileId) !== Number(fileId)) {
      return sendJson(res, 400, { error: 'Confirm the video before restoring it' });
    }
    const trashed = store.getTrashedFile?.(fileId);
    if (!trashed) return sendJson(res, 404, { error: 'Trashed video not found' });
    if (trashed.retention_status === 'trash_claimed' || (trashed.delete_requested_at != null && trashed.delete_error == null)) {
      return sendJson(res, 409, { error: 'The archived video is currently being purged' });
    }

    const filePath = resolveDownloadPath(config.downloadDir, trashed.path);
    if (!filePath) {
      return sendJson(res, 409, { error: 'The archived video is no longer available on disk' });
    }
    const fileStats = await stat(filePath).catch(() => null);
    if (!fileStats?.isFile()) {
      return sendJson(res, 409, { error: 'The archived video is no longer available on disk' });
    }

    const restored = store.restoreTrashedFile?.(fileId);
    if (!restored) return sendJson(res, 404, { error: 'Trashed video not found' });
    return sendJson(res, 200, {
      fileId: Number(restored.id),
      videoId: String(restored.video_id ?? ''),
      username: String(restored.username ?? ''),
      restoredVideo: true,
    });
  } catch (error) {
    const statusCode = Number(error?.statusCode) || 400;
    return sendJson(res, statusCode, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function startHttpServer({
  config,
  store,
  creatorImportService = null,
  host = '0.0.0.0',
  port = config?.httpPort,
} = {}) {
  assertServerDeps(config, store);

  const server = http.createServer(createHttpHandler({ config, store, creatorImportService }));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  return {
    server,
    address: server.address(),
  };
}

export async function handleCreatorImportRequest(req, res, { config, creatorImportService, url }) {
  if (!isImportAuthorized(req, config)) {
    return sendJson(res, 401, { error: 'Unauthorized' });
  }
  if (!creatorImportService) {
    return sendJson(res, 503, { error: 'Creator imports are unavailable' });
  }

  try {
    if (req.method === 'GET' && url.pathname === '/api/imports') {
      const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit')) || 20));
      return sendJson(res, 200, {
        imports: creatorImportService.list(limit).map(serializeCreatorImport),
        service: creatorImportService.status?.() ?? null,
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/imports') {
      const body = await readJsonBody(req);
      const result = creatorImportService.start({
        username: body.username,
        maxDurationSeconds: body.maxDurationSeconds,
      });
      return sendJson(res, result.reused ? 200 : 202, {
        import: serializeCreatorImport(result.import),
        reused: result.reused,
      });
    }

    const match = url.pathname.match(/^\/api\/imports\/(\d+)$/);
    if (req.method === 'GET' && match) {
      const record = creatorImportService.get(Number(match[1]));
      if (!record) return sendJson(res, 404, { error: 'Import not found' });
      return sendJson(res, 200, { import: serializeCreatorImport(record) });
    }

    const cancelMatch = url.pathname.match(/^\/api\/imports\/(\d+)\/cancel$/);
    if (req.method === 'POST' && cancelMatch) {
      const result = creatorImportService.cancel?.(Number(cancelMatch[1]));
      if (!result || result.reason === 'not_found') return sendJson(res, 404, { error: 'Import not found' });
      if (!result.accepted) {
        return sendJson(res, 409, {
          error: `Import cannot be canceled from status ${result.import?.status ?? 'unknown'}`,
          import: serializeCreatorImport(result.import),
        });
      }
      return sendJson(res, result.import?.status === 'canceled' ? 200 : 202, {
        import: serializeCreatorImport(result.import),
        cancellationRequested: true,
      });
    }

    const retryMatch = url.pathname.match(/^\/api\/imports\/(\d+)\/retry$/);
    if (req.method === 'POST' && retryMatch) {
      const result = creatorImportService.retry?.(Number(retryMatch[1]));
      if (!result || result.reason === 'not_found') return sendJson(res, 404, { error: 'Import not found' });
      if (!result.accepted) {
        return sendJson(res, 409, {
          error: `Import cannot be retried from status ${result.import?.status ?? 'unknown'}`,
          import: serializeCreatorImport(result.import),
        });
      }
      return sendJson(res, 202, {
        import: serializeCreatorImport(result.import),
        retried: true,
      });
    }

    return sendJson(res, 405, { error: 'Method not allowed' });
  } catch (error) {
    const statusCode = Number(error?.statusCode) || 400;
    return sendJson(res, statusCode, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function handleFileRequest(req, res, { config, store, token, now = Date.now() }) {
  const record = store.getValidToken(token, now);
  if (!record) {
    return sendJson(res, 404, { error: 'File not found' });
  }

  const filePath = resolveDownloadPath(config.downloadDir, record.path);
  if (!filePath) {
    return sendJson(res, 404, { error: 'File not found' });
  }

  try {
    const fileStats = await stat(filePath);
    if (!fileStats.isFile()) {
      return sendJson(res, 404, { error: 'File not found' });
    }

    const filename = record.filename || path.basename(filePath);
    const range = parseRangeHeader(req.headers.range, fileStats.size);
    if (range?.invalid) {
      res.writeHead(416, {
        'Content-Range': `bytes */${fileStats.size}`,
      });
      res.end();
      return;
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? fileStats.size - 1;
    const contentLength = end - start + 1;
    const headers = {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(contentLength),
      'Content-Disposition': `attachment; filename="${escapeContentDisposition(filename)}"`,
      'Accept-Ranges': 'bytes',
    };
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${fileStats.size}`;
    res.writeHead(range ? 206 : 200, headers);

    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    await pipeline(createReadStream(filePath, { start, end }), res);
  } catch (error) {
    if (!res.headersSent) {
      return sendJson(res, error?.code === 'ENOENT' ? 404 : 500, {
        error: error?.code === 'ENOENT' ? 'File not found' : 'Internal server error',
      }, { head: req.method === 'HEAD' });
    }
    res.destroy(error);
  }
}

export function resolveDownloadPath(downloadDir, filePath) {
  const resolvedDownloadDir = path.resolve(downloadDir);
  const resolvedFilePath = path.resolve(resolvedDownloadDir, String(filePath ?? ''));
  const relative = path.relative(resolvedDownloadDir, resolvedFilePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return resolvedFilePath;
}

export function buildHealthPayload(config, store) {
  return {
    status: 'ok',
  };
}

export function buildReadinessPayload(store) {
  const readiness = store.checkReadiness?.();
  if (!readiness || readiness.database !== 'ready') {
    throw new Error('Archive database is not ready.');
  }
  return { status: 'ready', ...readiness };
}

export function isImportAuthorized(req, config) {
  const remoteAddress = String(req?.socket?.remoteAddress ?? '');
  if (remoteAddress === '127.0.0.1' || remoteAddress === '::1' || remoteAddress === '::ffff:127.0.0.1') {
    return true;
  }
  const expected = String(config?.importApiToken ?? '');
  const authorization = String(req?.headers?.authorization ?? '');
  const provided = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (!expected || !provided) return false;
  const expectedBytes = Buffer.from(expected);
  const providedBytes = Buffer.from(provided);
  return expectedBytes.length === providedBytes.length && timingSafeEqual(expectedBytes, providedBytes);
}

export async function readJsonBody(req, maxBytes = 16 * 1024) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) {
      throw Object.assign(new Error('Request body is too large'), { statusCode: 413 });
    }
    chunks.push(buffer);
  }
  if (!bytes) return {};
  try {
    return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Request body must be valid JSON'), { statusCode: 400 });
  }
}

export function serializeCreatorImport(record) {
  if (!record) return null;
  return {
    id: Number(record.id),
    username: String(record.username ?? ''),
    status: String(record.status ?? ''),
    maxDurationSeconds: Number(record.max_duration_seconds ?? 0),
    discoveredCount: Number(record.discovered_count ?? 0),
    processedCount: Number(record.processed_count ?? 0),
    downloadedCount: Number(record.downloaded_count ?? 0),
    skippedExistingCount: Number(record.skipped_existing_count ?? 0),
    skippedDurationCount: Number(record.skipped_duration_count ?? 0),
    skippedUnknownDurationCount: Number(record.skipped_unknown_duration_count ?? 0),
    failedCount: Number(record.failed_count ?? 0),
    lastError: record.last_error == null ? null : String(record.last_error),
    createdAt: Number(record.created_at ?? 0),
    startedAt: record.started_at == null ? null : Number(record.started_at),
    completedAt: record.completed_at == null ? null : Number(record.completed_at),
    discoveryCompletedAt: record.discovery_completed_at == null ? null : Number(record.discovery_completed_at),
    cancelRequestedAt: record.cancel_requested_at == null ? null : Number(record.cancel_requested_at),
    canceledAt: record.canceled_at == null ? null : Number(record.canceled_at),
    retryCount: Number(record.retry_count ?? 0),
    resumeCount: Number(record.resume_count ?? 0),
    lastResumedAt: record.last_resumed_at == null ? null : Number(record.last_resumed_at),
    updatedAt: Number(record.updated_at ?? 0),
    ...(Array.isArray(record.items) ? { items: record.items.map(serializeCreatorImportItem) } : {}),
  };
}

export function serializeCreatorImportItem(record) {
  return {
    id: Number(record.id),
    position: Number(record.position ?? 0),
    videoId: String(record.video_id ?? ''),
    sourceUrl: String(record.source_url ?? ''),
    title: String(record.title ?? ''),
    status: String(record.status ?? ''),
    durationSeconds: record.duration_seconds == null ? null : Number(record.duration_seconds),
    fileId: record.file_id == null ? null : Number(record.file_id),
    error: record.error == null ? null : String(record.error),
    attemptCount: Number(record.attempt_count ?? 0),
    completedAt: record.completed_at == null ? null : Number(record.completed_at),
    updatedAt: Number(record.updated_at ?? 0),
  };
}

export function buildProfileGroupsPayload(store) {
  const groups = (store.listCreatorGroups?.({ includeEmpty: false }) ?? []).map((group) => (
    serializeCreatorGroup({
      ...group,
      members: store.listCreatorGroupMembers?.(group.id) ?? [],
    })
  ));
  const unlinkedProfiles = (store.listPlatformProfiles?.({ unlinkedOnly: true }) ?? [])
    .map(serializePlatformProfile);
  return { groups, unlinkedProfiles };
}

export function serializeCreatorGroup(record) {
  if (!record) return null;
  const members = Array.isArray(record.members) ? record.members.map(serializePlatformProfile) : [];
  return {
    id: Number(record.id),
    name: String(record.name ?? ''),
    memberCount: Number(record.member_count ?? members.length),
    createdAt: Number(record.created_at ?? 0),
    updatedAt: Number(record.updated_at ?? 0),
    members,
  };
}

export function serializePlatformProfile(record) {
  if (!record) return null;
  return {
    id: Number(record.id),
    platform: String(record.platform ?? ''),
    remoteId: record.remote_id == null || record.remote_id === '' ? null : String(record.remote_id),
    handle: String(record.handle ?? ''),
    displayName: String(record.display_name ?? ''),
    profileUrl: String(record.profile_url ?? ''),
    groupId: record.group_id == null ? null : Number(record.group_id),
    linkedAt: record.linked_at == null ? null : Number(record.linked_at),
    createdAt: Number(record.created_at ?? 0),
    updatedAt: Number(record.updated_at ?? 0),
  };
}

function resolveProfileForLink(store, input) {
  if (Number.isInteger(input) && input > 0) {
    const profile = store.getPlatformProfile?.(input);
    if (!profile) throw Object.assign(new Error(`Platform profile ${input} was not found.`), { statusCode: 404 });
    return profile;
  }
  if (typeof input !== 'string') {
    throw new Error('Every profile must be an existing profile ID or a TikTok, Instagram, or X profile URL.');
  }
  const reference = parseProfileReference(input);
  if (!reference) {
    throw new Error('A TikTok, Instagram, or X profile URL is required.');
  }
  return store.upsertPlatformProfile({
    platform: reference.platform,
    remoteId: reference.remoteId,
    handle: reference.handle,
    profileUrl: reference.canonicalUrl,
  });
}

function positiveId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new Error('A valid creator group ID is required.');
  return id;
}

function queryInteger(url, name, {
  defaultValue = null,
  minimum = Number.MIN_SAFE_INTEGER,
  maximum = Number.MAX_SAFE_INTEGER,
} = {}) {
  const raw = url.searchParams.get(name);
  if (raw == null || raw === '') return defaultValue;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

export function serializeTrashedFile(record, config = {}) {
  return {
    fileId: Number(record.id),
    videoId: String(record.video_id ?? ''),
    username: String(record.username ?? ''),
    sourceUrl: String(record.source_url ?? ''),
    filename: String(record.filename ?? ''),
    sizeBytes: Number(record.size_bytes ?? 0),
    createdAt: Number(record.created_at ?? 0),
    trashedAt: Number(record.trashed_at ?? 0),
    purgeAt: trashPurgeAt(record.trashed_at, config),
  };
}

function trashPurgeAt(trashedAt, config = {}) {
  const retentionDays = Number(config.archiveTrashRetentionDays);
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return null;
  return Number(trashedAt) + retentionDays * 24 * 60 * 60 * 1000;
}

export function parseRangeHeader(header, size) {
  const value = String(header ?? '').trim();
  if (!value) return null;
  const match = value.match(/^bytes=(\d*)-(\d*)$/i);
  if (!match || !size) return { invalid: true };
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return { invalid: true };
  if (!rawStart) {
    const suffixLength = Number(rawEnd);
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) return { invalid: true };
    return {
      start: Math.max(0, size - suffixLength),
      end: size - 1,
    };
  }
  const start = Number(rawStart);
  const requestedEnd = rawEnd ? Number(rawEnd) : size - 1;
  if (!Number.isInteger(start) || !Number.isInteger(requestedEnd) || start < 0 || start >= size || requestedEnd < start) {
    return { invalid: true };
  }
  return { start, end: Math.min(size - 1, requestedEnd) };
}

export function matchFileToken(pathname) {
  const match = pathname.match(/^\/files\/([^/]+)$/);
  if (!match) return '';
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return '';
  }
}

export function sendJson(res, statusCode, payload, { head = false } = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(head ? undefined : body);
}

function escapeContentDisposition(filename) {
  return String(filename).replace(/["\\\r\n]/g, '_');
}

function assertServerDeps(config, store) {
  if (!config?.downloadDir) {
    throw new Error('config.downloadDir is required');
  }
  if (!store || typeof store.getValidToken !== 'function') {
    throw new Error('store must provide getValidToken()');
  }
}
