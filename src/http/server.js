import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createReadStream } from 'node:fs';
import { normalizeUsername } from '../util/files.js';

export function createHttpHandler({ config, store, creatorImportService = null }) {
  assertServerDeps(config, store);

  return async function handleRequest(req, res) {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

      if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/health') {
        return sendJson(res, 200, buildHealthPayload(config, store), { head: req.method === 'HEAD' });
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

      const restoreVideoMatch = url.pathname.match(/^\/api\/videos\/(\d+)\/restore$/);
      if (restoreVideoMatch) {
        return handleVideoRestoreRequest(req, res, {
          config,
          store,
          fileId: Number(restoreVideoMatch[1]),
        });
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
  if (req.method !== 'GET') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  const limit = Math.max(1, Math.min(1_000, Number(url.searchParams.get('limit')) || 100));
  const videos = (store.listTrashedFiles?.(limit) ?? []).map((file) => serializeTrashedFile(file, config));
  return sendJson(res, 200, {
    videos,
    retentionDays: Math.max(0, Number(config.archiveTrashRetentionDays) || 0),
  });
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
    if (trashed.delete_requested_at != null && trashed.delete_error == null) {
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
